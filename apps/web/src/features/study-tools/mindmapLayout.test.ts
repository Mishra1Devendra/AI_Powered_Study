import { describe, expect, it } from "vitest";
import type { MindmapNode } from "@copilot/shared";
import { branchColor, branchIds, layoutMindmap, toSvg, wrapLabel } from "./mindmapLayout";

const leaf = (id: string, label: string): MindmapNode => ({ id, label, children: [] });
const tree: MindmapNode = {
  id: "n0",
  label: "Cells",
  children: [
    { id: "n1", label: "Nucleus", note: "Holds DNA.", children: [leaf("n2", "DNA"), leaf("n3", "Nucleolus")] },
    { id: "n4", label: "Membrane", children: [leaf("n5", "Lipids")] },
    leaf("n6", "Cytoplasm"),
  ],
};

describe("wrapLabel", () => {
  it("keeps short labels on one line and wraps at word boundaries", () => {
    expect(wrapLabel("DNA")).toEqual(["DNA"]);
    const lines = wrapLabel("Light dependent reactions in the chloroplast");
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.every((l) => l.length <= 22)).toBe(true);
    expect(lines.at(-1)!.endsWith("…")).toBe(true);
  });
  it("cuts a single enormous word instead of making a huge box", () => {
    expect(wrapLabel("Pneumonoultramicroscopicsilicovolcanoconiosis")[0]!.length).toBeLessThanOrEqual(22);
    expect(wrapLabel("")).toEqual([""]);
  });
});

describe("layoutMindmap", () => {
  const layout = layoutMindmap(tree);
  const by = (id: string) => layout.nodes.find((n) => n.id === id)!;

  it("puts the centre in column 0 and each level one column to the right, without overlaps", () => {
    expect(by("n0").x).toBeLessThan(by("n1").x);
    expect(by("n1").x).toBeLessThan(by("n2").x);
    expect(by("n1").x).toBe(by("n4").x);
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a.id >= b.id) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    }
  });

  it("centres a parent on its children and links each child to its parent", () => {
    const kids = [by("n2"), by("n3")];
    const mid = (kids[0]!.y + kids[0]!.h / 2 + kids[1]!.y + kids[1]!.h / 2) / 2;
    expect(by("n1").y + by("n1").h / 2).toBeCloseTo(mid, 5);
    expect(layout.links).toHaveLength(layout.nodes.length - 1);
    expect(layout.links.find((l) => l.to === "n2")).toMatchObject({ from: "n1", branch: 0 });
    expect(layout.links.find((l) => l.to === "n5")).toMatchObject({ from: "n4", branch: 1 });
  });

  it("hides the descendants of a collapsed node and marks it", () => {
    const small = layoutMindmap(tree, new Set(["n1"]));
    expect(small.nodes.map((n) => n.id)).toEqual(["n0", "n1", "n4", "n5", "n6"]);
    expect(small.nodes.find((n) => n.id === "n1")).toMatchObject({ collapsed: true, childCount: 2 });
    expect(small.height).toBeLessThan(layout.height);
    expect(layoutMindmap(tree, new Set(["n0"])).nodes).toHaveLength(1);
  });

  it("sizes the canvas to contain every node", () => {
    for (const n of layout.nodes) {
      expect(n.x + n.w).toBeLessThanOrEqual(layout.width);
      expect(n.y + n.h).toBeLessThanOrEqual(layout.height);
      expect(n.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("helpers", () => {
  it("lists the nodes that can be collapsed", () => {
    expect(branchIds(tree)).toEqual(["n0", "n1", "n4"]);
  });
  it("gives each top-level branch its own colour and the centre the brand colour", () => {
    expect(branchColor(-1)).toBe("#2f55c9");
    expect(branchColor(0)).not.toBe(branchColor(1));
    expect(branchColor(8)).toBe(branchColor(0));
  });
  it("exports a standalone, script-free SVG with escaped text", () => {
    const svg = toSvg(layoutMindmap({ id: "r", label: 'A & <B> "C"', children: [leaf("a", "x"), leaf("b", "y")] }), "T <1>");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("A &amp; &lt;B&gt; &quot;C&quot;");
    expect(svg).toContain("<title>T &lt;1&gt;</title>");
    expect(svg).not.toMatch(/<script|onclick|javascript:/i);
  });
});
