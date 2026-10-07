import { describe, expect, it } from "vitest";
import { NOTE_LIMITS } from "@copilot/shared";
import { chunkPages, classifyHeading, splitLong } from "./chunker.js";
import { extractDocument } from "./extract.js";
import { NoteFileError, detectFile, sanitizeFilename, titleFromFilename } from "./file-validation.js";
import { normalizeText } from "./normalize.js";
import { ProcessingError } from "./processing-error.js";
import { makePdf } from "./testing/pdf.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("sanitizeFilename", () => {
  it.each([
    ["../../etc/passwd", "passwd"],
    ["C:\\Users\\me\\notes.pdf", "notes.pdf"],
    ["..\\..\\secret.txt", "secret.txt"],
    ["/abs/path/file.md", "file.md"],
    ["  spaced   out .pdf ", "spaced out .pdf"],
    [".hidden.txt", "hidden.txt"],
    ["bad<>:\"|?*name.txt", "badname.txt"],
    ["evil\u202etxt.exe", "eviltxt.exe"], // right-to-left override stripped
    ["null\u0000byte.pdf", "nullbyte.pdf"],
    ["", "untitled"],
    ["///", "untitled"],
  ])("%j -> %j", (input, expected) => {
    expect(sanitizeFilename(input)).toBe(expected);
  });

  it("caps very long names", () => {
    expect(sanitizeFilename("a".repeat(500) + ".pdf").length).toBeLessThanOrEqual(255);
  });

  it("derives a readable title", () => {
    expect(titleFromFilename("Cell_Biology_notes.final.pdf")).toBe("Cell Biology notes.final");
    expect(titleFromFilename("x.md")).toBe("x");
  });
});

describe("detectFile (content, not just name or MIME)", () => {
  const pdf = makePdf([["Hello world"]]);

  it("accepts a real PDF, TXT and Markdown file", () => {
    expect(detectFile(pdf, "a.pdf")).toMatchObject({ fileType: "pdf", mime: "application/pdf" });
    expect(detectFile(enc("plain notes"), "a.txt")).toMatchObject({ fileType: "txt", mime: "text/plain", text: "plain notes" });
    expect(detectFile(enc("# Title\ntext"), "a.md")).toMatchObject({ fileType: "md", mime: "text/markdown" });
    expect(detectFile(enc("# Title"), "A.MARKDOWN")).toMatchObject({ fileType: "md" });
  });

  it("strips a UTF-8 BOM", () => {
    expect(detectFile(enc("\uFEFFhello"), "a.txt").text).toBe("hello");
  });

  it("rejects empty and whitespace-only files", () => {
    expect(() => detectFile(new Uint8Array(), "a.txt")).toThrow(/empty/);
    expect(() => detectFile(enc("   \n\n  "), "a.txt")).toThrow(/no text/);
  });

  it.each(["a.exe", "a.docx", "a.png", "a", "a.pdf.exe", "a.html", "a.js"])("rejects unsupported type %s", (name) => {
    expect(() => detectFile(enc("hello"), name)).toThrow(NoteFileError);
    try {
      detectFile(enc("hello"), name);
    } catch (e) {
      expect((e as NoteFileError).status).toBe(415);
    }
  });

  it("rejects an oversized file with 413", () => {
    const big = new Uint8Array(NOTE_LIMITS.maxFileBytes + 1).fill(65);
    expect(() => detectFile(big, "a.txt")).toThrow(/larger than/);
  });

  it("rejects a .pdf that is not a PDF (corrupt / renamed)", () => {
    expect(() => detectFile(enc("this is not a pdf at all"), "a.pdf")).toThrow(/not a valid PDF/);
    expect(() => detectFile(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]), "a.pdf")).toThrow(/not a valid PDF/); // an .exe header
  });

  it("rejects a PDF renamed to .txt, and binary data renamed to .txt", () => {
    expect(() => detectFile(pdf, "a.txt")).toThrow(/PDF with a text-file name/);
    expect(() => detectFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), "a.txt")).toThrow(/binary/);
  });

  it("rejects text that is not valid UTF-8", () => {
    expect(() => detectFile(new Uint8Array([0xff, 0xfe, 0x41, 0x80, 0x81]), "a.txt")).toThrow(/UTF-8/);
  });

  it("rejects a mostly-control-character 'text' file", () => {
    expect(() => detectFile(enc("\u0001\u0002\u0003\u0004\u0005 hi"), "a.txt")).toThrow(/readable text/);
  });
});

describe("normalizeText", () => {
  it("normalises newlines, control characters, spaces and blank lines", () => {
    const out = normalizeText("a\r\nb\u0000\u0007c  \n\n\n\n\nd\u00a0e\u200bf");
    expect(out).toBe("a\nbc\n\nd ef");
  });

  it("re-joins words hyphenated across a line break, but not real hyphens", () => {
    expect(normalizeText("photo-\nsynthesis and well-known")).toBe("photosynthesis and well-known");
    expect(normalizeText("self-\nCare")).toBe("self-\nCare"); // uppercase next: keep
  });

  it("unwraps hard-wrapped PDF lines but keeps lists and finished sentences", () => {
    const out = normalizeText("The cell is the basic\nunit of life.\nIt has parts:\n- nucleus\n- membrane\nNext paragraph", { unwrap: true });
    expect(out).toBe("The cell is the basic unit of life.\nIt has parts:\n- nucleus\n- membrane\nNext paragraph");
  });

  it("does not unwrap when told not to (Markdown / text keep their line breaks)", () => {
    expect(normalizeText("line one\nline two")).toBe("line one\nline two");
  });
});

describe("classifyHeading", () => {
  it.each([
    ["# Title", 1, "Title"],
    ["### Sub section ###", 3, "Sub section"],
    ["1. Introduction to Cells", 1, "1. Introduction to Cells"],
    ["2.3 Cell Division", 2, "2.3 Cell Division"],
    ["Chapter 4: Energy", 1, "Chapter 4: Energy"],
    ["THE KREBS CYCLE", 2, "THE KREBS CYCLE"],
  ])("%j is a heading", (line, level, text) => {
    expect(classifyHeading(line, true)).toMatchObject({ level, text });
  });

  it.each(["This is a normal sentence about cells.", "- a bullet point", "a lowercase fragment", "Is it a question?", "x".repeat(150)])(
    "%j is not a heading",
    (line) => {
      expect(classifyHeading(line, true)).toBeNull();
    },
  );

  it("treats Title Case as only a weak guess", () => {
    expect(classifyHeading("Cell Division", true)).toMatchObject({ weak: true });
    expect(classifyHeading("Cell Division", false)).toBeNull();
  });
});

describe("chunkPages", () => {
  const para = (n: number) => `Sentence ${n} about the topic explains an idea in detail. `.repeat(8).trim();

  it("returns nothing for empty text", () => {
    expect(chunkPages([{ page: null, text: "" }])).toEqual([]);
    expect(chunkPages([])).toEqual([]);
  });

  it("keeps a short document as one chunk and records no page for txt", () => {
    const chunks = chunkPages([{ page: null, text: "A short note about cells.\n\nIt is brief." }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, page: null, pageEnd: null, heading: null });
  });

  it("follows Markdown sections and records the heading path", () => {
    const md = `# Biology\n\n## Photosynthesis\n\n${para(1)}\n\n${para(2)}\n\n## Cell Division\n\n${para(3)}\n\n${para(4)}`;
    const chunks = chunkPages([{ page: null, text: md }]);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const first = chunks[0]!;
    expect(first.heading).toBe("Photosynthesis"); // body text belongs to the deepest heading above it
    expect(first.headingPath).toEqual(["Biology", "Photosynthesis"]);
    const photo = chunks.find((c) => c.content.includes("Sentence 1"))!;
    const division = chunks.find((c) => c.content.includes("Sentence 3"))!;
    expect(photo.headingPath).toEqual(["Biology", "Photosynthesis"]);
    expect(division.headingPath).toEqual(["Biology", "Cell Division"]);
    expect(photo.content).not.toContain("Sentence 3"); // sections are not blended across a heading
    expect(division.content).toContain("Cell Division"); // heading text is part of the chunk, helping retrieval
  });

  it("finds headings in PDF-style text that has no blank lines, and tracks pages", () => {
    const page1 = `Chapter 1: Photosynthesis\n${para(1)}\nLight-dependent reactions\n${para(2)}`;
    const page2 = `Chapter 2: Cell Division\n${para(3)}`;
    const chunks = chunkPages([
      { page: 1, text: normalizeText(page1, { unwrap: true }) },
      { page: 2, text: normalizeText(page2, { unwrap: true }) },
    ]);
    const ch2 = chunks.find((c) => c.content.includes("Sentence 3"))!;
    expect(ch2.page).toBe(2);
    expect(ch2.heading).toBe("Chapter 2: Cell Division");
    const ch1 = chunks.find((c) => c.content.includes("Sentence 1"))!;
    expect(ch1.page).toBe(1);
    expect(ch1.heading).toBe("Chapter 1: Photosynthesis");
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i)); // contiguous indexes
  });

  it("does not treat an unmarked list of Title Case lines as headings", () => {
    const text = `The ingredients are listed below and described in the text that follows after them.\nWater\nCarbon Dioxide\nSunlight\nGlucose is produced as a result of the reaction in the leaf.`;
    const chunks = chunkPages([{ page: null, text }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.heading).toBeNull();
  });

  it("splits an over-long paragraph on sentence boundaries, never exceeding the maximum", () => {
    const long = Array.from({ length: 80 }, (_, i) => `This is sentence number ${i} of a very long paragraph.`).join(" ");
    const chunks = chunkPages([{ page: null, text: long }]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(1600);
      expect(c.content.trimEnd().endsWith(".")).toBe(true); // ends at a sentence boundary
    }
    expect(chunks.map((c) => c.content).join(" ")).toContain("sentence number 79");
  });

  it("splits a long list between items, not inside one", () => {
    const list = Array.from({ length: 70 }, (_, i) => `- item ${i}: a reasonably descriptive list entry`).join("\n");
    const pieces = splitLong(list, 1100, 1600);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) for (const line of p.split("\n")) expect(line).toMatch(/^- item \d+: a reasonably descriptive list entry$/);
  });

  it("hard-splits text with no punctuation or whitespace structure rather than failing", () => {
    const blob = "word ".repeat(1000);
    const chunks = chunkPages([{ page: null, text: blob }]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.content.length <= 1600)).toBe(true);
  });

  it("fails clearly (not silently) when a document is too large", () => {
    const text = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\n${para(i)}`).join("\n\n");
    expect(() => chunkPages([{ page: null, text }], { maxChunks: 3 })).toThrow(ProcessingError);
  });

  it("is deterministic", () => {
    const text = `# A\n\n${para(1)}\n\n# B\n\n${para(2)}`;
    expect(chunkPages([{ page: null, text }])).toEqual(chunkPages([{ page: null, text }]));
  });
});

describe("extractDocument (real files)", () => {
  it("extracts text per page from a real PDF, with page numbers", async () => {
    const pdf = makePdf([["Chapter 1: Photosynthesis", "Plants make food from light."], ["Chapter 2: Cell Division", "Mitosis makes two cells."]]);
    const r = await extractDocument(pdf, "pdf");
    expect(r.pageCount).toBe(2);
    expect(r.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(r.pages[0]!.text).toContain("Plants make food from light.");
    expect(r.pages[1]!.text).toContain("Mitosis makes two cells.");
  });

  it("reads text and Markdown without inventing pages", async () => {
    const r = await extractDocument(enc("# Hi\nbody"), "md");
    expect(r).toEqual({ pages: [{ page: null, text: "# Hi\nbody" }], pageCount: null });
  });

  it("explains a PDF with no selectable text (scan) instead of marking it ready", async () => {
    const empty = makePdf([[" "], [" "]]);
    await expect(extractDocument(empty, "pdf")).rejects.toThrow(/image-only pages/);
  });

  it("fails safely on a corrupted PDF, without leaking internals", async () => {
    const corrupted = enc("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ngarbage garbage garbage");
    const err = await extractDocument(corrupted, "pdf").catch((e) => e);
    expect(err).toBeInstanceOf(ProcessingError);
    expect(err.message).toMatch(/could not be read|Something went wrong|No selectable/);
    expect(err.message).not.toMatch(/at |node_modules|pdfjs|stack/i);
  });

  it("rejects a PDF over the page limit", async () => {
    const many = makePdf(Array.from({ length: NOTE_LIMITS.maxPages + 1 }, (_, i) => [`Page ${i} has some text content here`]));
    await expect(extractDocument(many, "pdf")).rejects.toThrow(/limit is 300/);
  }, 60_000);
});
