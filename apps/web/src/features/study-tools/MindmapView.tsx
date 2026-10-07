import { useMemo, useState } from "react";
import type { MindmapNode } from "@copilot/shared";
import { Button } from "../../components/ui/Button";
import { branchColor, branchIds, layoutMindmap, toSvg } from "./mindmapLayout";

const ZOOMS = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2] as const;

function Outline({ node, depth = 0 }: { node: MindmapNode; depth?: number }) {
  return (
    <li>
      <p className={depth === 0 ? "text-lg font-semibold text-slate-900" : "font-medium text-slate-800"}>{node.label}</p>
      {node.note && <p className="text-sm text-slate-600">{node.note}</p>}
      {node.children.length > 0 && (
        <ul className="mt-1.5 space-y-2 border-l-2 border-slate-200 pl-4">
          {node.children.map((c) => (
            <Outline key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The map itself: click a box to fold or unfold its branch, zoom, switch to a plain outline (easier to read on a phone or with a screen
 * reader), or download it as an image. Nothing here talks to the server.
 */
export function MindmapView({ tree, title }: { tree: MindmapNode; title: string }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [view, setView] = useState<"map" | "outline">("map");
  const layout = useMemo(() => layoutMindmap(tree, collapsed), [tree, collapsed]);
  const all = useMemo(() => branchIds(tree), [tree]);
  const chosen = layout.nodes.find((n) => n.id === selected) ?? null;

  const toggle = (id: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function download() {
    const blob = new Blob([toSvg(layout, title)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 60) || "mind-map"}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const step = (dir: 1 | -1) => setZoom((z) => ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z as (typeof ZOOMS)[number]) + dir))]!);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="View" className="inline-flex gap-1 rounded-xl bg-slate-100 p-1">
          {(["map", "outline"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`h-9 rounded-lg px-4 text-sm font-medium transition ${view === v ? "bg-white text-brand-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"}`}>
              {v === "map" ? "Map" : "Outline"}
            </button>
          ))}
        </div>
        {view === "map" && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" className="h-9 px-3" onClick={() => setCollapsed(new Set(all.filter((id) => id !== tree.id)))}>
              Collapse
            </Button>
            <Button variant="secondary" className="h-9 px-3" onClick={() => setCollapsed(new Set())}>
              Expand all
            </Button>
            <div className="flex items-center gap-1" role="group" aria-label="Zoom">
              <Button variant="secondary" className="h-9 w-9 px-0" aria-label="Zoom out" onClick={() => step(-1)} disabled={zoom <= ZOOMS[0]}>
                −
              </Button>
              <span className="w-12 text-center text-sm tabular-nums text-slate-600" aria-live="polite">
                {Math.round(zoom * 100)}%
              </span>
              <Button variant="secondary" className="h-9 w-9 px-0" aria-label="Zoom in" onClick={() => step(1)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]!}>
                +
              </Button>
            </div>
            <Button variant="secondary" className="h-9 px-3" onClick={download}>
              Download image
            </Button>
          </div>
        )}
      </div>

      {view === "map" ? (
        <>
          <div className="mt-3 overflow-auto rounded-(--radius-card) bg-white ring-1 ring-slate-200/70" style={{ maxHeight: "70vh" }} data-testid="mindmap-canvas">
            <svg role="group" aria-label={`Mind map: ${title}`} width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`} className="block">
              {layout.links.map((l) => (
                <path key={`${l.from}-${l.to}`} d={l.d} className="mm-link" stroke={branchColor(l.branch)} />
              ))}
              {layout.nodes.map((n) => {
                const color = branchColor(n.branch);
                const root = n.depth === 0;
                const foldable = n.childCount > 0;
                return (
                  <g
                    key={n.id}
                    className="mm-node"
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.label}${foldable ? (n.collapsed ? ", folded, press to open" : ", press to fold") : ""}`}
                    aria-expanded={foldable ? !n.collapsed : undefined}
                    aria-pressed={selected === n.id}
                    onClick={() => {
                      setSelected(n.id);
                      if (foldable) toggle(n.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelected(n.id);
                        if (foldable) toggle(n.id);
                      }
                    }}
                  >
                    <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={10} fill={color} fillOpacity={root ? 1 : selected === n.id ? 0.3 : 0.14} stroke={color} strokeWidth={selected === n.id ? 3 : 1.5} />
                    <text textAnchor="middle" className={root ? "mm-root-label" : "mm-label"} fontSize={13} fontWeight={root ? 700 : 500}>
                      {n.lines.map((line, i) => (
                        <tspan key={i} x={n.x + n.w / 2} y={n.y + 11 + 16 * i + 12}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                    {foldable && n.collapsed && (
                      <g>
                        <circle cx={n.x + n.w} cy={n.y + n.h / 2} r={11} fill={color} />
                        <text x={n.x + n.w} y={n.y + n.h / 2 + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#ffffff">
                          +{n.childCount}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="mt-3 min-h-14 rounded-xl bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200/70" aria-live="polite">
            {chosen ? (
              <>
                <p className="font-semibold text-slate-900">{chosen.label}</p>
                <p className="mt-0.5 text-slate-600">{chosen.note ?? (chosen.childCount > 0 ? `${chosen.childCount} ${chosen.childCount === 1 ? "branch" : "branches"} under this idea.` : "No further detail for this idea.")}</p>
              </>
            ) : (
              <p className="text-slate-600">Click an idea to see its note. Ideas with branches fold and unfold when you click them.</p>
            )}
          </div>
        </>
      ) : (
        <ul className="mt-3 space-y-3 rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70" aria-label="Mind map outline">
          <Outline node={tree} />
        </ul>
      )}
    </div>
  );
}
