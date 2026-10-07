import { NOTE_LIMITS } from "@copilot/shared";
import { ProcessingError } from "./processing-error.js";

export interface PageText {
  /** 1-based page number for PDFs; null for formats without pages (txt / md / pasted). */
  page: number | null;
  text: string;
}

export interface ChunkOptions {
  /** Aim for chunks about this long; sections are closed once they reach it. */
  targetChars: number;
  /** Never exceed this (long paragraphs are split on sentence / list-item boundaries). */
  maxChars: number;
  /** Do not close a chunk shorter than this at a heading, so tiny sections stay with their neighbours. */
  minChars: number;
  maxChunks: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1100,
  maxChars: 1600,
  minChars: 250,
  maxChunks: NOTE_LIMITS.maxChunks,
};

export interface DocChunk {
  index: number;
  content: string;
  /** Only what the file really provides: null when the format has no pages. */
  page: number | null;
  pageEnd: number | null;
  /** Nearest section heading at the start of the chunk, if the text has recognisable headings. */
  heading: string | null;
  headingPath: string[];
}

type Block =
  | { kind: "heading"; level: number; text: string; page: number | null }
  | { kind: "text"; text: string; page: number | null };

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const NUMBERED = /^(\d+(?:\.\d+){0,3})[.)]?\s+(\p{Lu}[^\n]{1,78})$/u;
const CHAPTER = /^(chapter|section|unit|lesson|part|module)\s+[\w.-]+(\s*[:\-–—.]\s*.+)?$/i;
const LIST_LINE = /^\s*(?:[-*•●▪]|\d{1,3}[.)]|[a-z][.)])\s+/;
const TERMINAL = /[.!?,;:]$/;

export interface HeadingGuess {
  level: number;
  text: string;
  /** A Title Case guess with no other signal; only trusted when the surrounding lines agree. */
  weak?: boolean;
}

/** Recognises a heading from a single line. Conservative: a missed heading only costs metadata. */
export function classifyHeading(line: string, hasFollowingText: boolean): HeadingGuess | null {
  const t = line.trim();
  if (!t || t.length > 100 || t.includes("\n")) return null;

  const md = MD_HEADING.exec(t);
  if (md) return { level: md[1]!.length, text: md[2]!.trim() };

  if (LIST_LINE.test(t) && !NUMBERED.test(t)) return null;
  const words = t.split(/\s+/);

  const numbered = NUMBERED.exec(t);
  if (numbered && !TERMINAL.test(t) && words.length <= 12) {
    return { level: Math.min(numbered[1]!.split(".").length, 4), text: t };
  }
  if (CHAPTER.test(t) && t.length <= 80 && !/[.!?]$/.test(t)) return { level: 1, text: t };

  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 3 && words.length <= 10 && t.length <= 80 && !/[.!?]$/.test(t)) {
    const upper = letters.replace(/[^A-Z]/g, "").length;
    if (upper / letters.length >= 0.85) return { level: 2, text: t };
  }

  // Title Case line, followed by text, with no sentence punctuation: "Cell Division".
  if (hasFollowingText && words.length <= 8 && t.length <= 70 && !TERMINAL.test(t) && /^\p{Lu}/u.test(t)) {
    const significant = words.filter((w) => w.length > 3);
    if (significant.length > 0 && significant.every((w) => /^[\p{Lu}\d(]/u.test(w))) {
      return { level: 3, text: t, weak: true };
    }
  }
  return null;
}

/**
 * Splits page text into heading and text blocks. Headings are recognised line by line because PDF
 * text has no blank line between a heading and its paragraph.
 */
function toBlocks(pages: PageText[]): Block[] {
  const blocks: Block[] = [];
  for (const { page, text } of pages) {
    const parts = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    parts.forEach((part, partIndex) => {
      const lines = part.split("\n");
      const hasNextPart = partIndex < parts.length - 1;
      let run: string[] = [];
      const flushRun = () => {
        if (run.length) blocks.push({ kind: "text", text: run.join("\n").trim(), page });
        run = [];
      };
      lines.forEach((line, i) => {
        const md = MD_HEADING.exec(line.trim());
        if (md) {
          flushRun();
          blocks.push({ kind: "heading", level: md[1]!.length, text: md[2]!.trim(), page });
          return;
        }
        const prev = i > 0 ? lines[i - 1]! : undefined;
        const next = i < lines.length - 1 ? lines[i + 1]! : undefined;
        const guess = classifyHeading(line, next !== undefined || hasNextPart);
        // A weak (Title Case) guess must look like a heading in context: it starts the block or
        // follows a finished sentence, and what follows is real text rather than another bare
        // line (which would make it an unmarked list).
        const contextOk =
          !guess?.weak ||
          ((prev === undefined || TERMINAL.test(prev.trim()) || Boolean(MD_HEADING.exec(prev.trim()))) &&
            (next === undefined ? hasNextPart : next.length > 40 || /[.!?]$/.test(next.trim())));
        if (guess && contextOk) {
          flushRun();
          blocks.push({ kind: "heading", level: guess.level, text: guess.text, page });
        } else {
          run.push(line);
        }
      });
      flushRun();
    });
  }
  return blocks.filter((b) => b.text.length > 0);
}

/** Splits an over-long block on list-item or sentence boundaries, never mid-word when avoidable. */
export function splitLong(text: string, targetChars: number, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const lines = text.split("\n");
  const isList = lines.length > 1 && lines.filter((l) => LIST_LINE.test(l)).length >= lines.length / 2;
  const units = isList
    ? lines
    : text.split(/(?<=[.!?])\s+(?=[\p{Lu}\d"(“])/u).flatMap((s) => (s.length > maxChars ? hardSplit(s, maxChars) : [s]));
  const joiner = isList ? "\n" : " ";
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (cur && cur.length + joiner.length + u.length > targetChars) {
      out.push(cur);
      cur = u;
    } else {
      cur = cur ? cur + joiner + u : u;
    }
  }
  if (cur) out.push(cur);
  return out.flatMap((p) => (p.length > maxChars ? hardSplit(p, maxChars) : [p]));
}

function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Heading-aware chunking. Sections stay together where possible, paragraphs and lists are not cut
 * in the middle, and each chunk records the page(s) and heading it came from when the file provides
 * them. The output is plain data, so embeddings / vector search can later be attached per chunk
 * without changing this step.
 */
export function chunkPages(pages: PageText[], options: Partial<ChunkOptions> = {}): DocChunk[] {
  const opt = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const chunks: DocChunk[] = [];
  const stack: Array<{ level: number; text: string }> = [];

  interface Buf {
    texts: string[];
    chars: number;
    page: number | null;
    pageEnd: number | null;
    heading: string | null;
    headingPath: string[];
    /** True once real text (not just heading lines) has been added. */
    hasBody: boolean;
  }
  let buf: Buf | null = null;

  const start = (page: number | null): Buf => ({
    texts: [],
    chars: 0,
    page,
    pageEnd: page,
    heading: stack.length ? stack[stack.length - 1]!.text : null,
    headingPath: stack.map((s) => s.text),
    hasBody: false,
  });
  const flush = () => {
    if (!buf || buf.texts.length === 0) {
      buf = null;
      return;
    }
    if (chunks.length >= opt.maxChunks) {
      throw new ProcessingError(`This document is too large to process (more than ${opt.maxChunks} sections).`);
    }
    chunks.push({
      index: chunks.length,
      content: buf.texts.join("\n\n"),
      page: buf.page,
      pageEnd: buf.pageEnd,
      heading: buf.heading,
      headingPath: buf.headingPath,
    });
    buf = null;
  };

  for (const block of toBlocks(pages)) {
    if (block.kind === "heading") {
      // A heading on a new page starts a new chunk, so a chunk's body stays on one page.
      if (buf && buf.hasBody && block.page !== null && buf.pageEnd !== null && block.page !== buf.pageEnd) flush();
      if (buf && buf.chars >= opt.minChars) flush();
      while (stack.length && stack[stack.length - 1]!.level >= block.level) stack.pop();
      stack.push({ level: block.level, text: block.text });
      if (!buf) buf = start(block.page);
      // Only headings so far: the text that follows belongs to the deepest heading, so record that one.
      if (!buf.hasBody) {
        buf.heading = block.text;
        buf.headingPath = stack.map((s) => s.text);
      }
      buf.texts.push(block.text);
      buf.chars += block.text.length;
      buf.pageEnd = block.page;
      continue;
    }
    for (const piece of splitLong(block.text, opt.targetChars, opt.maxChars)) {
      // A chunk never mixes body text from two pages, so a cited page number is always exact.
      if (buf && buf.hasBody && block.page !== null && buf.pageEnd !== null && block.page !== buf.pageEnd) flush();
      if (buf && ((buf.chars + piece.length > opt.targetChars && buf.chars >= opt.minChars) || buf.chars + piece.length > opt.maxChars)) {
        flush();
      }
      if (!buf) buf = start(block.page);
      // A heading carried over from the previous page: the body (what gets cited) starts here.
      if (!buf.hasBody) buf.page = block.page;
      buf.texts.push(piece);
      buf.hasBody = true;
      buf.chars += piece.length + 2;
      buf.pageEnd = block.page;
    }
  }
  flush();
  return chunks;
}
