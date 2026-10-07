import { NOTE_ACCEPT_EXTENSIONS, NOTE_LIMITS, type Note, type NoteFileType, type NoteStatus } from "@copilot/shared";

export const FILE_TYPE_LABEL: Record<NoteFileType, string> = { pdf: "PDF", txt: "TXT", md: "Markdown" };

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
}

export const STATUS_INFO: Record<NoteStatus, { label: string; busy: boolean; classes: string }> = {
  uploading: { label: "Uploading", busy: true, classes: "bg-sky-50 text-sky-800 ring-sky-200" },
  processing: { label: "Processing", busy: true, classes: "bg-amber-50 text-amber-900 ring-amber-200" },
  ready: { label: "Ready", busy: false, classes: "bg-emerald-50 text-emerald-800 ring-emerald-200" },
  failed: { label: "Failed", busy: false, classes: "bg-red-50 text-red-800 ring-red-200" },
};

export const isBusy = (n: Pick<Note, "status">) => n.status === "uploading" || n.status === "processing";

/** "12 pages · 34 sections" - only what the file really has. */
export function noteStats(n: Note): string {
  const parts: string[] = [];
  if (n.pageCount) parts.push(`${n.pageCount} ${n.pageCount === 1 ? "page" : "pages"}`);
  if (n.status === "ready") parts.push(`${n.chunkCount} ${n.chunkCount === 1 ? "section" : "sections"}`);
  return parts.join(" · ");
}

/** Early, friendly checks mirroring the server's rules. The server still validates everything. */
export function validateClientFile(file: File): string | null {
  const name = file.name.toLowerCase();
  if (!NOTE_ACCEPT_EXTENSIONS.some((ext) => name.endsWith(ext))) return "Unsupported file type. Upload a PDF, TXT or Markdown file, or paste your text.";
  if (file.size === 0) return "This file is empty.";
  if (file.size > NOTE_LIMITS.maxFileBytes) return `This file is larger than ${NOTE_LIMITS.maxFileBytes / (1024 * 1024)} MB.`;
  return null;
}
