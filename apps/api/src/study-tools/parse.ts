import { STUDY_TOOLS_LIMITS, type MindmapNode } from "@copilot/shared";

/**
 * Turns what the model returned into clean, bounded data. The model's output is untrusted: it may be wrapped in prose, cut off,
 * oversized, repeated or shaped differently than asked. Nothing is stored that did not pass through here.
 */

/** Removes control characters and simple markdown decoration, and collapses whitespace. */
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/[*_`#>]+/g, "")
      .replace(/^\s*(?:[-•]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
      .trim()
  );
}

/** The first JSON value in the text: plain, in a ```json fence, or inside a sentence. Null when there is none. */
export function parseJson(text: string): unknown {
  let body = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced?.[1]) body = fenced[1];
  try {
    return JSON.parse(body);
  } catch {
    const start = body.search(/[[{]/);
    const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const normalise = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/* ------------------------------------------ flashcards ------------------------------------------ */

export interface ParsedCard {
  front: string;
  back: string;
  hint: string | null;
}

/** Up to `max` distinct, non-empty cards. Accepts {cards:[…]} or a bare array, and common alternative field names. */
export function parseCards(text: string, max: number): ParsedCard[] {
  const value = parseJson(text);
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.cards) ? value.cards : isRecord(value) && Array.isArray(value.flashcards) ? value.flashcards : [];
  const seen = new Set<string>();
  const out: ParsedCard[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const front = cleanText(item.front ?? item.question ?? item.term, STUDY_TOOLS_LIMITS.frontMaxChars);
    const back = cleanText(item.back ?? item.answer ?? item.definition, STUDY_TOOLS_LIMITS.backMaxChars);
    if (front.length < 3 || back.length < 1) continue;
    // A card whose answer is just the question again teaches nothing.
    if (normalise(front) === normalise(back)) continue;
    const key = normalise(front);
    if (seen.has(key)) continue;
    seen.add(key);
    const hint = cleanText(item.hint, STUDY_TOOLS_LIMITS.hintMaxChars);
    out.push({ front, back, hint: hint && normalise(hint) !== normalise(back) ? hint : null });
    if (out.length >= max) break;
  }
  return out;
}

/* ------------------------------------------ mind maps ------------------------------------------ */

export interface ParsedMap {
  title: string | null;
  tree: MindmapNode;
  nodeCount: number;
}

/**
 * Cleans a mind-map tree: bounded depth, children per node and total size; empty and duplicate sibling labels dropped; ids assigned
 * here (the model's are ignored). Returns null when what is left is not a usable map (needs a centre and at least two branches).
 */
export function parseMindmap(text: string, fallbackTitle: string): ParsedMap | null {
  const value = parseJson(text);
  if (!isRecord(value)) return null;
  const rootRaw = isRecord(value.root) ? value.root : isRecord(value.tree) ? value.tree : "label" in value || "name" in value ? value : null;
  if (!rootRaw) return null;

  let count = 0;
  const build = (raw: Record<string, unknown>, depth: number): MindmapNode | null => {
    if (count >= STUDY_TOOLS_LIMITS.maxMapNodes) return null;
    const label = cleanText(raw.label ?? raw.name ?? raw.title ?? raw.text, STUDY_TOOLS_LIMITS.labelMaxChars);
    if (!label) return null;
    const node: MindmapNode = { id: `n${count++}`, label, children: [] };
    const note = cleanText(raw.note ?? raw.description, STUDY_TOOLS_LIMITS.noteMaxChars);
    if (note && normalise(note) !== normalise(label)) node.note = note;
    const kids = Array.isArray(raw.children) ? raw.children : [];
    if (depth < STUDY_TOOLS_LIMITS.maxMapDepth) {
      const seen = new Set<string>([normalise(label)]);
      for (const kid of kids) {
        if (node.children.length >= STUDY_TOOLS_LIMITS.maxChildren) break;
        if (!isRecord(kid)) continue;
        const key = normalise(cleanText(kid.label ?? kid.name ?? kid.title ?? kid.text, STUDY_TOOLS_LIMITS.labelMaxChars));
        if (!key || seen.has(key)) continue;
        const child = build(kid, depth + 1);
        if (child) (seen.add(key), node.children.push(child));
      }
    }
    return node;
  };

  const tree = build(rootRaw, 0);
  if (!tree || tree.children.length < 2) return null;
  const title = cleanText(value.title, STUDY_TOOLS_LIMITS.titleMaxChars) || null;
  return { title: title ?? (fallbackTitle || null), tree, nodeCount: count };
}
