import { NOTE_LIMITS, SCANNED_PDF_MESSAGE, type NoteFileType } from "@copilot/shared";
import { extractText, getDocumentProxy } from "unpdf";
import type { PageText } from "./chunker.js";
import { decodeTextFile } from "./file-validation.js";
import { ProcessingError } from "./processing-error.js";

export interface Extracted {
  pages: PageText[];
  /** null for formats without pages. */
  pageCount: number | null;
}

/** Fewer characters than this across the whole PDF means there is no real text layer (a scan). */
const MIN_PDF_TEXT_CHARS = 20;

/**
 * Extracts raw text from a validated file. DOCX / image (OCR) support can be added here later
 * as new branches without touching storage, chunking or the assistant.
 * Throws ProcessingError with a student-safe message for anything that cannot be read.
 */
export async function extractDocument(bytes: Uint8Array, fileType: NoteFileType): Promise<Extracted> {
  if (fileType === "txt" || fileType === "md") {
    const text = decodeTextFile(bytes);
    return { pages: [{ page: null, text }], pageCount: null };
  }
  return extractPdf(bytes);
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // Text extraction only: no rendering, no scripting. Fonts and CMaps come from the local pdfjs-dist
    // package (unpdf resolves them), so nothing is fetched from the network.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { useSystemFonts: false, disableFontFace: true, verbosity: 0 });
    if (pdf.numPages > NOTE_LIMITS.maxPages) {
      throw new ProcessingError(`This PDF has ${pdf.numPages} pages; the limit is ${NOTE_LIMITS.maxPages}.`);
    }
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((t, i) => ({ page: i + 1, text: t }));
    const total = pages.reduce((n, p) => n + p.text.replace(/\s+/g, "").length, 0);
    if (total < MIN_PDF_TEXT_CHARS) {
      throw new ProcessingError(
        SCANNED_PDF_MESSAGE,
      );
    }
    return { pages, pageCount: pdf.numPages };
  } catch (err) {
    if (err instanceof ProcessingError) throw err;
    const name = err instanceof Error ? err.name : "";
    if (name === "PasswordException") throw new ProcessingError("This PDF is password-protected. Remove the password and upload it again.");
    if (name === "InvalidPDFException" || name === "FormatError" || name === "MissingPDFException") {
      throw new ProcessingError("This PDF could not be read. It may be corrupted.");
    }
    throw new ProcessingError("Something went wrong while reading this PDF.");
  } finally {
    await pdf?.loadingTask.destroy().catch(() => undefined);
  }
}
