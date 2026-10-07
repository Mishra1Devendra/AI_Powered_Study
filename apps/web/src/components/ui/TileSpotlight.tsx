import { useEffect, useRef } from "react";
import { useTheme } from "../../lib/theme";

const TILE = 56;

/**
 * A purely decorative dark-mode backdrop: a faint tile grid behind the page, and the four tiles around the mouse light up.
 * It never takes part in layout or input (`aria-hidden`, no pointer events), only runs for a real mouse (not touch), and does
 * nothing for people who asked for reduced motion.
 */
export function TileSpotlight() {
  const { resolved } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const dark = resolved === "dark";

  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const hover = window.matchMedia?.("(hover: hover)").matches ?? false;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!hover || reduced) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const { clientX, clientY } = e;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // The grid corner nearest the mouse; the lit square is the four tiles that meet there.
        layer.style.setProperty("--tx", `${Math.round(clientX / TILE) * TILE - TILE}px`);
        layer.style.setProperty("--ty", `${Math.round(clientY / TILE) * TILE - TILE}px`);
        layer.setAttribute("data-on", "");
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, [dark]);

  if (!dark) return null;
  return <div ref={ref} className="tile-spotlight" aria-hidden="true" />;
}
