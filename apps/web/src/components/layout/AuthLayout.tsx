import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Logo } from "../ui/Logo";

const CYCLE = ["Learn", "Practice", "Test", "Analyze", "Improve"];

const POINTS = [
  { title: "A tutor that knows your notes", text: "Ask about your own PDFs and get answers with the source shown." },
  { title: "Quizzes and vivas that find the gaps", text: "Practice, get checked, and see exactly what to revisit." },
  { title: "AI with a clear privacy notice", text: "When enabled, AI requests are processed by Google Gemini; no other provider is tried." },
];

/** The learning loop, lit one step at a time. Respects reduced motion (no timer; the first step stays lit). */
function Cycle() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setActive((a) => (a + 1) % CYCLE.length), 1600);
    return () => clearInterval(t);
  }, []);
  return (
    <ol aria-label="The learning loop" className="flex flex-wrap items-center gap-2 text-sm">
      {CYCLE.map((step, i) => (
        <li key={step} className="flex items-center gap-2">
          <span className={`rounded-full px-3 py-1 ring-1 transition-all duration-500 ${i === active ? "bg-[#f3e2b0] text-[#1b1608] shadow-[0_0_24px_rgb(232_194_92/0.45)] ring-[#f3e2b0]" : "bg-white/5 text-white/75 ring-white/10"}`}>{step}</span>
          {i < CYCLE.length - 1 && (
            <span aria-hidden="true" className="text-white/40">
              →
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Two columns on desktop: an animated brand panel (soft moving colour, a grid that lights up under the pointer, the learning
 * loop) and the form. Phones get the form only. Everything decorative is hidden from screen readers and stops for reduced motion.
 */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null);

  // The glow follows the pointer by setting two CSS variables - no React re-render per mouse move.
  function onMove(e: PointerEvent<HTMLElement>) {
    const el = panel.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      <aside ref={panel} onPointerMove={onMove} className="auth-panel palette-light hero-surface relative hidden flex-col justify-between overflow-hidden p-12 lg:flex">
        <div aria-hidden="true" className="auth-aurora" />
        <div aria-hidden="true" className="auth-grid" />
        <div aria-hidden="true" className="auth-glow" />

        <Logo className="relative text-white" />

        <div className="relative">
          <p className="mb-4 text-xs font-semibold uppercase tracking-[0.14em] text-[#e8c25c]">
            <span aria-hidden="true" className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-[#d9a93a] align-middle" />
            AI study copilot
          </p>
          <h2 className="max-w-md font-display text-5xl font-semibold leading-[1.08] tracking-tight text-white">Study smarter with a tutor that knows where you struggle.</h2>
          <ul className="mt-8 max-w-md space-y-4">
            {POINTS.map((p, i) => (
              <li key={p.title} className="auth-rise flex gap-3" style={{ animationDelay: `${150 + i * 120}ms` }}>
                <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#d9a93a]" />
                <span>
                  <span className="block text-sm font-medium text-white">{p.title}</span>
                  <span className="block text-sm text-white/65">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-8">
            <Cycle />
          </div>
        </div>

        <p className="relative text-xs text-white/70">Your study data is scoped to your account.</p>
      </aside>

      <main className="relative flex items-center justify-center px-4 py-10 sm:px-8">
        <div aria-hidden="true" className="auth-main-glow" />
        <div className="animate-fade-up auth-card relative w-full max-w-sm">
          <Logo className="mb-8 lg:hidden" />
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-slate-600">{subtitle}</p>
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            AI is disabled for this deployment, so prompts and study content are not currently sent to an AI provider. If Gemini is enabled later after model eligibility is verified, relevant content may be sent to Google. Google's unpaid-tier terms say submitted content may be used to improve products and may be reviewed by humans.
          </p>
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
