import { useEffect, useRef, useState, type ReactNode } from "react";
import type { StudyTime, QuizStats } from "@copilot/shared";
import { formatMinutes, pctText, shortDate, weekday } from "./format";

const H = 200;
const PAD = { top: 12, right: 8, bottom: 26, left: 38 };
const plotH = H - PAD.top - PAD.bottom;
const FALLBACK_WIDTH = 600;

/** The drawing is made at the real pixel width, so text keeps its size on a phone instead of shrinking with the chart. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => el.clientWidth > 0 && setWidth(Math.max(260, Math.round(el.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** Rounds a maximum up to a tidy axis value (e.g. 135 -> 150, 45 -> 60). */
function niceMax(v: number): number {
  if (v <= 30) return 30;
  const step = v <= 120 ? 30 : v <= 480 ? 60 : 120;
  return Math.ceil(v / step) * step;
}

function Figure({ label, caption, children, table }: { label: string; caption: ReactNode; children: (w: number) => ReactNode; table: ReactNode }) {
  const { ref, width: W } = useWidth();
  return (
    <figure className="m-0">
      {/* The drawing is positioned out of the flow, so the chart can never make its card (or the page) wider than the screen. */}
      <div ref={ref} className="relative w-full" style={{ height: H }}>
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="absolute left-0 top-0 overflow-visible">
          {children(W)}
        </svg>
      </div>
      <figcaption className="mt-2 text-xs text-slate-600">{caption}</figcaption>
      {/* The same numbers as text, for screen readers. */}
      <div className="sr-only">{table}</div>
    </figure>
  );
}

/** Study time per day (7 and 30 days) or per week (90 days, all time). Only completed sessions; zero days are shown as empty. */
export function StudyTimeChart({ data }: { data: StudyTime }) {
  const bars = data.byPeriod;
  const max = niceMax(Math.max(0, ...bars.map((b) => b.minutes)));
  const label = (start: string) => (data.granularity === "day" && bars.length <= 7 ? weekday(start) : shortDate(start));
  const unit = data.granularity === "day" ? "day" : "week";
  return (
    <Figure
      label={`Bar chart of study time per ${unit}. Total ${formatMinutes(data.totalMinutes)} over ${bars.length} ${unit}s.`}
      caption={data.granularity === "week" ? "Each bar is one week (Monday to Sunday)." : "Each bar is one day."}
      table={
        <table>
          <caption>Study time per {unit}</caption>
          <thead>
            <tr>
              <th>{unit === "day" ? "Day" : "Week starting"}</th>
              <th>Minutes</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.start}>
                <td>{shortDate(b.start)}</td>
                <td>{b.minutes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {(W) => {
        const plotW = W - PAD.left - PAD.right;
        const slot = plotW / Math.max(bars.length, 1);
        const barW = Math.min(36, slot * 0.64);
        // About one label per 56px keeps them from running into each other on a phone.
        const every = Math.max(1, Math.ceil(bars.length / Math.max(2, Math.floor(plotW / 56))));
        return (
          <>
      {[0, 0.5, 1].map((f) => {
        const y = PAD.top + plotH * (1 - f);
        return (
          <g key={f}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="var(--color-slate-200)" strokeDasharray={f === 0 ? undefined : "3 4"} />
            <text x={PAD.left - 6} y={y + 4} textAnchor="end" fontSize="11" fill="var(--color-slate-500)">
              {formatMinutes(Math.round(max * f))}
            </text>
          </g>
        );
      })}
      {bars.map((b, i) => {
        const h = (b.minutes / max) * plotH;
        const x = PAD.left + slot * i + (slot - barW) / 2;
        return (
          <g key={b.start}>
            <title>{`${shortDate(b.start)}: ${formatMinutes(b.minutes)}`}</title>
            {b.minutes > 0 ? <rect x={x} y={PAD.top + plotH - h} width={barW} height={h} rx="4" fill="var(--color-brand-600)" /> : <rect x={x} y={PAD.top + plotH - 2} width={barW} height="2" rx="1" fill="var(--color-slate-300)" />}
            {i % every === 0 && (
              <text x={x + barW / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--color-slate-500)">
                {label(b.start)}
              </text>
            )}
          </g>
        );
      })}
          </>
        );
      }}
    </Figure>
  );
}

/** Quiz scores over time, one point per finished attempt, on the real dates. */
export function ScoreTrendChart({ quiz }: { quiz: QuizStats }) {
  const pts = quiz.trend;
  const y = (p: number) => PAD.top + plotH * (1 - p / 100);
  return (
    <Figure
      label={`Line chart of quiz scores over time. ${pts.length} finished ${pts.length === 1 ? "attempt" : "attempts"}, latest ${pctText(quiz.recentScore)}.`}
      caption="Each point is one finished quiz attempt, on the day it was finished."
      table={
        <table>
          <caption>Quiz scores</caption>
          <thead>
            <tr>
              <th>Date</th>
              <th>Quiz</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {pts.map((p) => (
              <tr key={p.attemptId}>
                <td>{shortDate(p.date)}</td>
                <td>{p.quizTitle}</td>
                <td>{pctText(p.percentage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {(W) => {
        const plotW = W - PAD.left - PAD.right;
        const x = (i: number) => PAD.left + (pts.length === 1 ? plotW / 2 : (plotW * i) / (pts.length - 1));
        const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.percentage).toFixed(1)}`).join(" ");
        const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(plotW / 64))));
        return (
          <>
      {[0, 25, 50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--color-slate-200)" strokeDasharray={v === 0 ? undefined : "3 4"} />
          <text x={PAD.left - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--color-slate-500)">
            {v}
          </text>
        </g>
      ))}
      {pts.length > 1 && <path d={path} fill="none" stroke="var(--color-brand-600)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
      {pts.map((p, i) => (
        <g key={p.attemptId}>
          <title>{`${shortDate(p.date)} · ${p.quizTitle}: ${pctText(p.percentage)}`}</title>
          <circle cx={x(i)} cy={y(p.percentage)} r="5" fill="white" stroke="var(--color-brand-600)" strokeWidth="2.5" />
          {i % every === 0 && (
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--color-slate-500)">
              {shortDate(p.date)}
            </text>
          )}
        </g>
      ))}
          </>
        );
      }}
    </Figure>
  );
}
