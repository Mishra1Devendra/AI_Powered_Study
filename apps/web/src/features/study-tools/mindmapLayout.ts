import type { MindmapNode } from "@copilot/shared";

/**
 * Lays a mind map out left to right: the central idea on the left, each level one column further right. Pure (no DOM), so the
 * same function draws the on-screen map and the downloadable SVG, and it can be tested.
 */

const LINE_CHARS = 22;
const MAX_LINES = 2;
const CHAR_W = 7.4;
const PAD_X = 14;
const LINE_H = 16;
const PAD_Y = 11;
const COLUMN_GAP = 64;
const ROW_GAP = 14;
const MARGIN = 28;

export interface PlacedNode {
  id: string;
  label: string;
  lines: string[];
  note: string | undefined;
  depth: number;
  /** Index of the top-level branch it belongs to (the centre is -1); picks its colour. */
  branch: number;
  x: number;
  y: number;
  w: number;
  h: number;
  parentId: string | null;
  childCount: number;
  collapsed: boolean;
}

export interface Link {
  from: string;
  to: string;
  branch: number;
  d: string;
}

export interface Layout {
  nodes: PlacedNode[];
  links: Link[];
  width: number;
  height: number;
}

/** Breaks a label into at most two lines at word boundaries; the last line ends in an ellipsis when the label is longer. */
export function wrapLabel(label: string, lineChars = LINE_CHARS, maxLines = MAX_LINES): string[] {
  const words = label.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const push = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (const word of words) {
    // A single very long word is cut so it can never make the box huge.
    const w = word.length > lineChars ? `${word.slice(0, lineChars - 1)}…` : word;
    if (!line) line = w;
    else if (`${line} ${w}`.length <= lineChars) line = `${line} ${w}`;
    else (push(), (line = w));
  }
  push();
  if (lines.length <= maxLines) return lines.length ? lines : [""];
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1]!;
  kept[maxLines - 1] = `${last.length >= lineChars ? last.slice(0, lineChars - 1) : last}…`;
  return kept;
}

const measure = (lines: string[]) => ({ w: Math.max(84, Math.min(240, Math.ceil(Math.max(...lines.map((l) => l.length)) * CHAR_W) + PAD_X * 2)), h: lines.length * LINE_H + PAD_Y * 2 });

export function layoutMindmap(root: MindmapNode, collapsed: ReadonlySet<string> = new Set()): Layout {
  interface Box {
    node: MindmapNode;
    depth: number;
    branch: number;
    parentId: string | null;
    lines: string[];
    w: number;
    h: number;
    y: number;
    kids: Box[];
  }

  const build = (node: MindmapNode, depth: number, branch: number, parentId: string | null): Box => {
    const lines = wrapLabel(node.label);
    const { w, h } = measure(lines);
    const open = !collapsed.has(node.id);
    const kids = open ? node.children.map((c, i) => build(c, depth + 1, depth === 0 ? i : branch, node.id)) : [];
    return { node, depth, branch, parentId, lines, w, h, y: 0, kids };
  };
  const tree = build(root, 0, -1, null);

  // Rows: every visible leaf takes one slot; a parent sits at the middle of its children.
  let cursor = MARGIN;
  const place = (b: Box) => {
    if (b.kids.length === 0) {
      b.y = cursor + b.h / 2;
      cursor += b.h + ROW_GAP;
      return;
    }
    b.kids.forEach(place);
    b.y = (b.kids[0]!.y + b.kids[b.kids.length - 1]!.y) / 2;
  };
  place(tree);

  // Columns: each depth is as wide as its widest box.
  const flat: Box[] = [];
  (function walk(b: Box) {
    flat.push(b);
    b.kids.forEach(walk);
  })(tree);
  const colW: number[] = [];
  for (const b of flat) colW[b.depth] = Math.max(colW[b.depth] ?? 0, b.w);
  const colX: number[] = [];
  colW.reduce((x, w, d) => ((colX[d] = x), x + w + COLUMN_GAP), MARGIN);

  const placed = new Map<string, PlacedNode>();
  const nodes: PlacedNode[] = flat.map((b) => {
    const p: PlacedNode = {
      id: b.node.id,
      label: b.node.label,
      lines: b.lines,
      note: b.node.note,
      depth: b.depth,
      branch: b.branch,
      x: colX[b.depth]!,
      y: b.y - b.h / 2,
      w: b.w,
      h: b.h,
      parentId: b.parentId,
      childCount: b.node.children.length,
      collapsed: collapsed.has(b.node.id) && b.node.children.length > 0,
    };
    placed.set(p.id, p);
    return p;
  });

  const links: Link[] = nodes
    .filter((n) => n.parentId)
    .map((n) => {
      const p = placed.get(n.parentId!)!;
      const x1 = p.x + p.w;
      const y1 = p.y + p.h / 2;
      const x2 = n.x;
      const y2 = n.y + n.h / 2;
      const mid = (x1 + x2) / 2;
      return { from: p.id, to: n.id, branch: n.branch, d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` };
    });

  const width = Math.max(...nodes.map((n) => n.x + n.w)) + MARGIN;
  const height = Math.max(cursor - ROW_GAP + MARGIN, MARGIN * 2 + 40);
  return { nodes, links, width, height };
}

/** The ids of every node that has children (to collapse the whole map to its first level, or open it fully). */
export function branchIds(root: MindmapNode): string[] {
  const out: string[] = [];
  (function walk(n: MindmapNode) {
    if (n.children.length) out.push(n.id);
    n.children.forEach(walk);
  })(root);
  return out;
}

/** One colour per top-level branch (readable on light and dark backgrounds). */
export const BRANCH_COLORS = ["#3a5fd0", "#0ea5e9", "#10b981", "#d9a93a", "#ec4899", "#8b5cf6", "#14b8a6", "#f97316"] as const;
export const branchColor = (branch: number): string => (branch < 0 ? "#2f55c9" : BRANCH_COLORS[branch % BRANCH_COLORS.length]!);

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A standalone SVG (light background, explicit colours, no scripts) of the map as currently shown, for download. */
export function toSvg(layout: Layout, title: string): string {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="13">`,
    `<title>${esc(title)}</title>`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    ...layout.links.map((l) => `<path d="${l.d}" fill="none" stroke="${branchColor(l.branch)}" stroke-width="2" opacity="0.6"/>`),
    ...layout.nodes.map((n) => {
      const color = branchColor(n.branch);
      const root = n.depth === 0;
      const text = n.lines.map((line, i) => `<tspan x="${n.x + n.w / 2}" y="${n.y + PAD_Y + LINE_H * i + 12}">${esc(line)}</tspan>`).join("");
      return `<g><rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${root ? color : color}" fill-opacity="${root ? 1 : 0.14}" stroke="${color}" stroke-width="1.5"/><text text-anchor="middle" fill="${root ? "#ffffff" : "#0f172a"}" font-weight="${root ? 700 : 500}">${text}</text></g>`;
    }),
    `</svg>`,
  ];
  return parts.join("\n");
}
