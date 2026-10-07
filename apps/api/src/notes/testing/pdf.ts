/**
 * Builds a small but valid text PDF for tests (no binary fixtures in the repo).
 * `pages` is a list of pages, each a list of text lines.
 */
export function makePdf(pages: string[][]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects: string[] = [];
  const pageObjIds: number[] = [];
  // 1 = catalog, 2 = pages tree, 3 = font; then (page, content) pairs
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let next = 4;
  for (const lines of pages) {
    const pageId = next++;
    const contentId = next++;
    pageObjIds.push(pageId);
    let y = 740;
    const body = lines
      .map((line) => {
        const cmd = `BT /F1 12 Tf 72 ${y} Td (${esc(line)}) Tj ET`;
        y -= 18;
        return cmd;
      })
      .join("\n");
    objects[contentId] = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjIds.length} >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < next; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
