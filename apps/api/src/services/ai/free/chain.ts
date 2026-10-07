import type { AiStatusReport, AiStepStatus } from "@copilot/shared";
import { AIError } from "../errors.js";
import type { AiProbe, GenerateTextRequest, GenerateTextResult, LLMProvider, StreamEnd, TextStream } from "../types.js";

export const ALL_FREE_UNAVAILABLE = "All free AI services are currently unavailable. Please try again later.";

/** One approved free online service. `label` is for in-process bookkeeping and tests only: it is never sent to a client or logged. */
export interface FreeSlot {
  label: string;
  provider: LLMProvider;
  /** For the administrator's AI status screen only (never sent to students). */
  service?: string;
  model?: string;
  limits?: { perMinute: number | null; perDay: number | null; note: string };
}

/** After these failures a slot rests, so one broken or exhausted service is not asked again on every request. */
const COOL_DOWN_MS: Partial<Record<AIError["code"], number>> = { rate_limited: 60_000, auth: 10 * 60_000, unavailable: 30_000, timeout: 30_000, bad_request: 5 * 60_000, empty_response: 0, unknown: 30_000 };

export type LocalPosition = "first" | "last";

export interface ChainOptions {
  local: LLMProvider;
  slots: readonly FreeSlot[];
  /** "first" (default): the local model answers first and online services are the backup. "last": online services first, local model last. */
  localPosition?: LocalPosition;
  now?: () => number;
  /** Test/diagnostic hook: which step was tried (-1 = the local model) and what happened. Receives opaque indexes, never keys or content. */
  onAttempt?: (info: { slot: number; outcome: "ok" | AIError["code"] }) => void;
}

type Step = { kind: "local" } | { kind: "online"; index: number };

/**
 * THE FREE-AI PROVIDER MANAGER.
 *
 *   localPosition "first":  local Ollama -> free service #1 -> #2 -> #3 -> "AI temporarily unavailable"
 *   localPosition "last":   free service #1 -> #2 -> #3 -> local Ollama -> "AI temporarily unavailable"
 *
 * - A free service that is rate-limited, out of quota, unavailable, timing out or unauthorised is skipped and the NEXT step is tried.
 *   There is no paid service anywhere in the chain, so there is nothing paid to fall back to; if every step fails the student gets a
 *   plain message, never a charge.
 * - Each student request makes at most ONE attempt per step (no retries, no loops) and only when the student asked.
 * - Fallback happens only BEFORE any text was produced; once a reply has started it is never silently restarted elsewhere.
 * - The local model is skipped only when it is not running at all. Its other errors (a timeout, a missing model) are reported as they are.
 * - Which online service answered is not revealed: results carry the opaque label "free-ai" / "free-online-ai".
 */
export class FreeAiChainProvider implements LLMProvider {
  readonly name = "free-ai" as const;
  readonly isMock = false;
  private readonly restingUntil = new Map<number, number>();
  /** Per step (-1 = the local model): requests started today, and what happened last. In memory only; starts at zero with the server. */
  private readonly stats = new Map<number, { day: string; used: number; lastResult: string | null; lastAt: number | null }>();
  private lastAnswered: { step: number; at: number } | null = null;
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly position: LocalPosition;

  constructor(private readonly options: ChainOptions) {
    this.now = options.now ?? (() => Date.now());
    this.startedAt = this.now();
    this.position = options.localPosition ?? "first";
  }

  /** The configured local model is the headline model; online answers say "free-online-ai" in the result itself. */
  get model(): string {
    return this.options.local.model;
  }

  /** True when at least one free online service is configured. */
  get hasOnlineServices(): boolean {
    return this.options.slots.length > 0;
  }

  get localPosition(): LocalPosition {
    return this.position;
  }

  probe(): Promise<AiProbe> {
    return this.options.local.probe ? this.options.local.probe() : Promise.resolve({ reachable: false, modelInstalled: null });
  }

  /**
   * For the administrator's AI status screen: every step in the order it would be tried, whether it is ready or resting, how many
   * requests it was asked today and its free limit. Makes no AI request (the local check only lists installed models).
   */
  async status(): Promise<AiStatusReport> {
    const t = this.now();
    const probe = await this.probe().catch(() => ({ reachable: false, modelInstalled: null }));
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    const all: Step[] = this.options.slots.map((_, index) => ({ kind: "online" as const, index }));
    const ordered: Step[] = this.position === "first" ? [{ kind: "local" }, ...all] : [...all, { kind: "local" }];
    const steps: AiStepStatus[] = ordered.map((step, i) => {
      const st = this.stat(this.idx(step));
      if (step.kind === "local") {
        return {
          order: i + 1,
          service: "Local AI (Ollama)",
          model: this.options.local.model,
          where: "this_computer" as const,
          state: probe.reachable ? ("ready" as const) : ("not_running" as const),
          restingSeconds: 0,
          usedToday: st.used,
          limitPerMinute: null,
          limitPerDay: null,
          limitNote: "No service limit: it runs on this computer, so only the computer's speed limits it.",
          lastResult: st.lastResult,
          lastAt: iso(st.lastAt),
        };
      }
      const slot = this.options.slots[step.index]!;
      const rest = Math.max(0, (this.restingUntil.get(step.index) ?? 0) - t);
      return {
        order: i + 1,
        service: slot.service ?? "Free online AI",
        model: slot.model ?? slot.provider.model,
        where: "online" as const,
        state: rest > 0 ? ("resting" as const) : ("ready" as const),
        restingSeconds: Math.ceil(rest / 1000),
        usedToday: st.used,
        limitPerMinute: slot.limits?.perMinute ?? null,
        limitPerDay: slot.limits?.perDay ?? null,
        limitNote: slot.limits?.note ?? "Free tier only; over the limit gives an error, never a charge.",
        lastResult: st.lastResult,
        lastAt: iso(st.lastAt),
      };
    });
    const answered = this.lastAnswered;
    const answeredStep = answered ? steps.find((x) => (answered.step === -1 ? x.where === "this_computer" : x.order === ordered.findIndex((o) => o.kind === "online" && o.index === answered.step) + 1)) : undefined;
    return {
      mode: "free",
      localPosition: this.position,
      lastAnswered: answered && answeredStep ? { service: answeredStep.service, model: answeredStep.model, at: new Date(answered.at).toISOString() } : null,
      steps,
      countersSince: new Date(this.startedAt).toISOString(),
    };
  }

  /** The steps to try for this request, in order: online services that are not resting, with the local model first or last. */
  private steps(): Step[] {
    const t = this.now();
    const online: Step[] = this.options.slots.map((_, index) => ({ kind: "online" as const, index })).filter((s) => (this.restingUntil.get(s.index) ?? 0) <= t);
    return this.position === "first" ? [{ kind: "local" }, ...online] : [...online, { kind: "local" }];
  }

  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  private stat(index: number) {
    const day = this.day();
    let st = this.stats.get(index);
    if (!st || st.day !== day) {
      st = { day, used: 0, lastResult: st?.lastResult ?? null, lastAt: st?.lastAt ?? null };
      this.stats.set(index, st);
    }
    return st;
  }

  private idx(step: Step): number {
    return step.kind === "local" ? -1 : step.index;
  }

  /** Called just before a request is sent to a step: counts it against that service's free allowance. */
  private started(step: Step) {
    this.stat(this.idx(step)).used++;
  }

  private note(step: Step, result: string) {
    const st = this.stat(this.idx(step));
    st.lastResult = result;
    st.lastAt = this.now();
  }

  private rest(slot: number, code: AIError["code"]) {
    const ms = COOL_DOWN_MS[code] ?? 30_000;
    if (ms > 0) this.restingUntil.set(slot, this.now() + ms);
  }

  private provider(step: Step): LLMProvider {
    return step.kind === "local" ? this.options.local : this.options.slots[step.index]!.provider;
  }

  /** Decides what a failure of `step` means. Returns normally to move on to the next step; throws to stop the request. */
  private onFailure(step: Step, err: unknown, request: GenerateTextRequest): void {
    if (request.signal?.aborted) throw err; // the student left: do not try another service for them
    if (!(err instanceof AIError)) throw err;
    this.note(step, err.code);
    if (step.kind === "local") {
      // Only "not running at all" moves on. A timeout or a missing model is reported as it is, never hidden behind another service.
      if (err.code !== "local_unavailable") throw err;
      this.options.onAttempt?.({ slot: -1, outcome: err.code });
      return;
    }
    this.options.onAttempt?.({ slot: step.index, outcome: err.code });
    this.rest(step.index, err.code);
  }

  private ok(step: Step) {
    this.note(step, "ok");
    this.lastAnswered = { step: this.idx(step), at: this.now() };
    this.options.onAttempt?.({ slot: this.idx(step), outcome: "ok" });
  }

  async generateText(request: GenerateTextRequest): Promise<GenerateTextResult> {
    for (const step of this.steps()) {
      this.started(step);
      try {
        const out = await this.provider(step).generateText(request);
        this.ok(step);
        return out;
      } catch (err) {
        this.onFailure(step, err, request);
      }
    }
    throw new AIError("unavailable", ALL_FREE_UNAVAILABLE, true);
  }

  async *streamText(request: GenerateTextRequest): TextStream {
    for (const step of this.steps()) {
      this.started(step);
      const stream = this.provider(step).streamText(request);
      let first: IteratorResult<string, StreamEnd>;
      try {
        first = await stream.next();
      } catch (err) {
        this.onFailure(step, err, request);
        continue; // nothing was produced yet: the next step may answer
      }
      this.ok(step);
      if (first.done) return first.value;
      yield first.value;
      return yield* stream;
    }
    throw new AIError("unavailable", ALL_FREE_UNAVAILABLE, true);
  }
}
