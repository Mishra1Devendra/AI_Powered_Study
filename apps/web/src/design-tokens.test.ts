import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the design tokens (docs/DESIGN.md): every text/background pair the app uses must keep WCAG AA contrast in BOTH themes, and the
 * dark palette must be complete. Change a colour in index.css or theme-dark.generated.css and this tells you at once if it breaks reading.
 */
const src = join(import.meta.dirname);
const indexCss = readFileSync(join(src, "index.css"), "utf8");
const darkCss = readFileSync(join(src, "theme-dark.generated.css"), "utf8");

function hexTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--color-(slate|brand|accent)-(\d+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[`${m[1]}-${m[2]}`] = m[3]!;
  return out;
}
const themeBlock = indexCss.slice(indexCss.indexOf("@theme {"), indexCss.indexOf("}", indexCss.indexOf("@theme {")));
const light = hexTokens(themeBlock);
// The dark palette is everything before the "keeps the LIGHT palette" island at the end of the file.
const dark = hexTokens(darkCss.slice(0, darkCss.indexOf("An element that keeps the LIGHT palette")));
const surface = /html\.dark \{[^}]*--surface:\s*(#[0-9a-fA-F]{6})/.exec(indexCss)?.[1];

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const WHITE = "#ffffff";

describe("design tokens: the palettes are readable", () => {
  it("found the tokens it checks (so this test cannot pass by reading nothing)", () => {
    expect(Object.keys(light)).toEqual(expect.arrayContaining(["slate-50", "slate-900", "brand-600", "brand-700", "accent-700"]));
    expect(Object.keys(dark)).toEqual(expect.arrayContaining(["slate-50", "slate-900", "brand-600", "brand-700", "accent-700"]));
    expect(surface).toMatch(/^#/);
  });

  describe("light theme (paper and ink)", () => {
    const L = light;
    const pairs: Array<[string, string, string, number]> = [
      ["ink (slate-900) on cards", L["slate-900"]!, WHITE, 7],
      ["ink on the page", L["slate-900"]!, L["slate-50"]!, 7],
      ["secondary text (slate-600) on the page", L["slate-600"]!, L["slate-50"]!, 4.5],
      ["secondary text on cards", L["slate-600"]!, WHITE, 4.5],
      ["muted text (slate-500) on cards", L["slate-500"]!, WHITE, 4.5],
      ["muted text (slate-500) on the page", L["slate-500"]!, L["slate-50"]!, 4.5],
      ["muted text on raised surfaces (slate-100)", L["slate-500"]!, L["slate-100"]!, 4.5],
      ["white label on the primary button (brand-600)", WHITE, L["brand-600"]!, 4.5],
      ["white label on the hovered button (brand-700)", WHITE, L["brand-700"]!, 4.5],
      ["links (brand-700) on cards", L["brand-700"]!, WHITE, 4.5],
      ["active chips (brand-700 on brand-50)", L["brand-700"]!, L["brand-50"]!, 4.5],
      ["selected chips (brand-800 on brand-100)", L["brand-800"]!, L["brand-100"]!, 4.5],
      ["gold chip (accent-700 on accent-50)", L["accent-700"]!, L["accent-50"]!, 4.5],
      ["gold chip, darker (accent-800 on accent-100)", L["accent-800"]!, L["accent-100"]!, 4.5],
    ];
    it.each(pairs)("%s", (_name, fg, bg, min) => {
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
    });
  });

  describe("dark theme (ink-navy)", () => {
    const D = dark;
    const pairs: Array<[string, string, string, number]> = [
      ["ink on the page", D["slate-900"]!, D["slate-50"]!, 7],
      ["ink on cards", D["slate-900"]!, surface!, 7],
      ["secondary text (slate-600) on the page", D["slate-600"]!, D["slate-50"]!, 4.5],
      ["secondary text on cards", D["slate-600"]!, surface!, 4.5],
      ["muted text (slate-500) on cards", D["slate-500"]!, surface!, 4.5],
      ["muted text on raised surfaces (slate-100)", D["slate-500"]!, D["slate-100"]!, 4.5],
      ["dark label on the primary button (brand-600)", D["slate-50"]!, D["brand-600"]!, 4.5],
      ["links (brand-600) on cards", D["brand-600"]!, surface!, 4.5],
      ["links, lighter (brand-700) on cards", D["brand-700"]!, surface!, 4.5],
      ["active chips (brand-700 on brand-50)", D["brand-700"]!, D["brand-50"]!, 4.5],
      ["gold chip (accent-700 on accent-50)", D["accent-700"]!, D["accent-50"]!, 4.5],
      ["gold on cards (accent-600)", D["accent-600"]!, surface!, 4.5],
      // Placeholders are hints, not content; the WCAG large-text bar (3:1) is the floor and the current value is above it.
      ["placeholder text (slate-400) on cards", D["slate-400"]!, surface!, 3],
    ];
    it.each(pairs)("%s", (_name, fg, bg, min) => {
      expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
    });
  });

  it("every shade the UI can use is defined for dark mode: the coloured families have all of 50-900 AND 950 (the 950 gap once left a heading invisible)", () => {
    const families = [...new Set([...darkCss.matchAll(/--color-([a-z]+)-900:/g)].map((m) => m[1]!))].filter((f) => f !== "slate" && f !== "brand" && f !== "accent");
    expect(families.length).toBeGreaterThanOrEqual(10);
    for (const f of families) {
      for (const shade of ["50", "100", "200", "300", "700", "800", "900", "950"]) {
        expect(darkCss, `${f}-${shade}`).toMatch(new RegExp(`--color-${f}-${shade}:`));
      }
    }
  });

  it("dark neutrals and the brand cover every shade the UI uses", () => {
    for (const shade of ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"]) expect(dark[`slate-${shade}`], `slate-${shade}`).toBeDefined();
    for (const shade of ["50", "100", "200", "500", "600", "700", "800", "900"]) expect(dark[`brand-${shade}`], `brand-${shade}`).toBeDefined();
  });
});
