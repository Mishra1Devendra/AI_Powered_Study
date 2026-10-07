import { describe, expect, it } from "vitest";
import { cleanText, parseCards, parseJson, parseMindmap } from "./parse.js";

describe("parseJson", () => {
  it("reads plain JSON, a ```json fence, and JSON wrapped in a sentence", () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('Sure! Here you go: {"a":1} Hope that helps.')).toEqual({ a: 1 });
    expect(parseJson("[1,2]")).toEqual([1, 2]);
  });
  it("returns null for text that is not JSON, including a cut-off reply", () => {
    expect(parseJson("no json here")).toBeNull();
    expect(parseJson('{"cards":[{"front":"a"')).toBeNull();
  });
});

describe("cleanText", () => {
  it("strips control characters, markdown decoration and list markers, and caps the length", () => {
    expect(cleanText("  **Hello**\n  `world` \u0007", 50)).toBe("Hello world");
    expect(cleanText("1. Photosynthesis", 50)).toBe("Photosynthesis");
    expect(cleanText("- a bullet", 50)).toBe("a bullet");
    expect(cleanText("x".repeat(100), 10)).toHaveLength(10);
    expect(cleanText(42, 10)).toBe("");
  });
});

describe("parseCards", () => {
  it("accepts {cards:[…]}, a bare array and the usual alternative field names", () => {
    expect(parseCards('{"cards":[{"front":"What is ATP?","back":"Energy currency.","hint":"energy"}]}', 5)).toEqual([{ front: "What is ATP?", back: "Energy currency.", hint: "energy" }]);
    expect(parseCards('[{"question":"What is DNA?","answer":"A molecule that carries genes."}]', 5)).toEqual([{ front: "What is DNA?", back: "A molecule that carries genes.", hint: null }]);
  });

  it("drops empty, duplicate and answer-equals-question cards, and stops at the requested count", () => {
    const json = JSON.stringify({
      cards: [
        { front: "What is ATP?", back: "Energy currency." },
        { front: "what is atp", back: "Something else." },
        { front: "", back: "no front" },
        { front: "No back?", back: "" },
        { front: "Same text", back: "same text" },
        { front: "Second real question?", back: "Second answer." },
        { front: "Third real question?", back: "Third answer." },
      ],
    });
    const cards = parseCards(json, 2);
    expect(cards.map((c) => c.front)).toEqual(["What is ATP?", "Second real question?"]);
  });

  it("drops a hint that just repeats the answer, and returns [] for garbage", () => {
    expect(parseCards('{"cards":[{"front":"Capital of France?","back":"Paris","hint":"Paris"}]}', 3)[0]!.hint).toBeNull();
    expect(parseCards("nonsense", 3)).toEqual([]);
    expect(parseCards('{"cards":"nope"}', 3)).toEqual([]);
  });
});

describe("parseMindmap", () => {
  const good = { title: "Cells", root: { label: "Cells", children: [{ label: "Nucleus", note: "Holds DNA.", children: [{ label: "DNA" }, { label: "Nucleolus" }] }, { label: "Membrane" }] } };

  it("builds a clean tree with server-assigned ids and counts the nodes", () => {
    const map = parseMindmap(JSON.stringify({ ...good, root: { ...good.root, id: "evil<script>" } }), "Fallback")!;
    expect(map.title).toBe("Cells");
    expect(map.nodeCount).toBe(5);
    expect(map.tree.id).toBe("n0");
    expect(map.tree.children[0]).toMatchObject({ id: "n1", label: "Nucleus", note: "Holds DNA." });
    expect(map.tree.children[0]!.children.map((c) => c.id)).toEqual(["n2", "n3"]);
  });

  it("uses the fallback title when the model gives none, and accepts a root object without the wrapper", () => {
    const map = parseMindmap(JSON.stringify(good.root), "My notes")!;
    expect(map.title).toBe("My notes");
  });

  it("limits depth, children per node and total size", () => {
    let deep: Record<string, unknown> = { label: "leaf" };
    for (let i = 0; i < 10; i++) deep = { label: `level ${i}`, children: [deep] };
    const wide = { label: "Root", children: Array.from({ length: 30 }, (_, i) => ({ label: `branch ${i}`, children: Array.from({ length: 30 }, (_, j) => ({ label: `leaf ${i}-${j}` })) })) };
    const depthOf = (n: { children: Array<never> }): number => 1 + Math.max(0, ...n.children.map((c) => depthOf(c as never)));
    const d = parseMindmap(JSON.stringify({ root: { label: "R", children: [deep, { label: "other" }] } }), "x")!;
    expect(depthOf(d.tree as never)).toBeLessThanOrEqual(5);
    const w = parseMindmap(JSON.stringify({ root: wide }), "x")!;
    expect(w.tree.children.length).toBeLessThanOrEqual(8);
    expect(w.nodeCount).toBeLessThanOrEqual(60);
  });

  it("drops empty and duplicate sibling labels", () => {
    const map = parseMindmap(JSON.stringify({ root: { label: "Root", children: [{ label: "A" }, { label: "a" }, { label: "" }, { label: "B" }, { label: "Root" }] } }), "x")!;
    expect(map.tree.children.map((c) => c.label)).toEqual(["A", "B"]);
  });

  it("rejects what is not a usable map: no centre, fewer than two branches, or not JSON", () => {
    expect(parseMindmap("nope", "x")).toBeNull();
    expect(parseMindmap(JSON.stringify({ root: { label: "Only", children: [{ label: "one" }] } }), "x")).toBeNull();
    expect(parseMindmap(JSON.stringify({ root: { children: [{ label: "a" }, { label: "b" }] } }), "x")).toBeNull();
    expect(parseMindmap("[1,2,3]", "x")).toBeNull();
  });
});
