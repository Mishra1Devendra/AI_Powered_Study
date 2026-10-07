/**
 * Cleans extracted text so it chunks and reads well. Pure and deterministic.
 * `unwrap` re-joins hard-wrapped lines (typical of PDF text) into paragraphs; leave it off for
 * Markdown/plain text, where line breaks are intentional.
 */
export function normalizeText(raw: string, opts: { unwrap?: boolean } = {}): string {
  let text = raw
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/[​‌‍⁠]/g, "")
    .replace(/\t/g, "  ")
    .replace(/[ ]+\n/g, "\n")
    .replace(/[ ]{3,}/g, "  ");

  // Words split by a line-end hyphen: "photo-\nsynthesis" -> "photosynthesis" (only before a lowercase letter).
  text = text.replace(/([A-Za-z])-\n([a-z])/g, "$1$2");

  if (opts.unwrap) text = unwrapParagraphs(text);

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

const LIST_ITEM = /^\s*(?:[-*•●▪]|\d{1,3}[.)]|[a-z][.)])\s+/;

/** Joins "soft" line breaks inside a paragraph; keeps list items, headings and blank lines. */
function unwrapParagraphs(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const startsNewBlock = LIST_ITEM.test(line) || /^\s*#{1,6}\s/.test(line);
    const prevEndsSentence = prev === undefined || /[.!?:;)\]"'”]$/.test(prev.trimEnd());
    const lowercaseStart = /^\s*[a-z(]/.test(line);
    if (prev !== undefined && prev.trim() !== "" && line.trim() !== "" && !startsNewBlock && !prevEndsSentence && lowercaseStart) {
      out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}
