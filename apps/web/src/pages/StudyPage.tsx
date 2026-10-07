import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import type { CardGrade, Flashcard, StudyQueueResponse } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { GRADES, intervalLabel } from "../features/study-tools/format";
import { friendlyMessage } from "../lib/errors";
import { getStudyQueue, reviewCard } from "../lib/studyToolsApi";

/** A card forgotten ("Again") comes back later in the same round, at most this many times. */
const MAX_REQUEUES = 2;

type Tally = Record<CardGrade, number>;
const EMPTY_TALLY: Tally = { again: 0, hard: 0, good: 0, easy: 0 };

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: StudyQueueResponse };

/** `/flashcards/:deckId/study`: one card at a time. Flip, say how well you remembered, and the server schedules the next review. */
export default function StudyPage() {
  const { deckId = "" } = useParams();
  const { client } = useAuth();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [queue, setQueue] = useState<Flashcard[]>([]);
  const [revealed, setRevealed] = useState(false);
  const [showHint, setShowHint] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tally, setTally] = useState<Tally>(EMPTY_TALLY);
  const [round, setRound] = useState(0);
  const requeues = useRef(new Map<string, number>());

  const start = useCallback(async () => {
    setLoad({ status: "loading" });
    try {
      const data = await getStudyQueue(client, deckId);
      requeues.current = new Map();
      setQueue(data.cards);
      setTally(EMPTY_TALLY);
      setRevealed(false);
      setShowHint(false);
      setError(null);
      setLoad({ status: "ready", data });
    } catch (e) {
      setLoad({ status: "error", message: friendlyMessage(e, "Could not load the cards. Please try again.") });
    }
  }, [client, deckId]);

  useEffect(() => {
    void start();
  }, [start, round]);

  const current = queue[0];

  const grade = useCallback(
    async (g: CardGrade) => {
      if (!current || saving) return;
      setSaving(true);
      setError(null);
      try {
        await reviewCard(client, current.id, g);
        setTally((t) => ({ ...t, [g]: t[g] + 1 }));
        const times = requeues.current.get(current.id) ?? 0;
        const again = g === "again" && times < MAX_REQUEUES;
        if (again) requeues.current.set(current.id, times + 1);
        setQueue((q) => (again ? [...q.slice(1), q[0]!] : q.slice(1)));
        setRevealed(false);
        setShowHint(false);
      } catch (e) {
        setError(friendlyMessage(e, "Could not save that answer. Please try again."));
      } finally {
        setSaving(false);
      }
    },
    [client, current, saving],
  );

  // Keyboard: Space/Enter flips, 1-4 answer once the card is flipped.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (!current || tag === "INPUT" || tag === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!revealed && (e.key === " " || e.key === "Enter")) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed) {
        const g = GRADES.find((x) => x.key === e.key);
        if (g) void grade(g.grade);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, revealed, grade]);

  if (load.status === "loading") return <LoadingState label="Getting your cards…" />;
  if (load.status === "error") {
    return (
      <div className="space-y-4">
        <ErrorState message={load.message} onRetry={() => void start()} />
        <Link to={`/flashcards/${deckId}`} className="inline-block text-sm font-medium text-brand-700 underline">
          Back to the deck
        </Link>
      </div>
    );
  }

  const { data } = load;
  const total = data.cards.length;
  const reviewed = tally.again + tally.hard + tally.good + tally.easy;
  const remainingNow = queue.length;
  const done = total === 0 || !current;
  const remembered = tally.good + tally.easy + tally.hard;

  return (
    <div className="animate-fade-up mx-auto max-w-2xl">
      {/* The card screen has no visible title; give assistive technology one (the finished screen has its own visible heading). */}
      {!done && <h1 className="sr-only">Studying {data.deck.title}</h1>}
      <div className="flex items-center justify-between gap-3">
        <Link to={`/flashcards/${deckId}`} className="-ml-2.5 inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
          <span aria-hidden="true">←</span> {data.deck.title}
        </Link>
        {!done && (
          <p className="text-sm tabular-nums text-slate-600" aria-live="polite">
            {Math.min(reviewed + 1, reviewed + remainingNow)} of {reviewed + remainingNow}
          </p>
        )}
      </div>

      {!done && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-label="Round progress" aria-valuemin={0} aria-valuemax={reviewed + remainingNow} aria-valuenow={reviewed}>
          <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${(reviewed / Math.max(1, reviewed + remainingNow)) * 100}%` }} />
        </div>
      )}

      {done ? (
        <div className="mt-8 rounded-(--radius-card) bg-white p-8 text-center shadow-card ring-1 ring-slate-200/70">
          <h1 className="text-2xl font-semibold tracking-tight">{total === 0 ? "You're all caught up" : "Round complete"}</h1>
          {total === 0 ? (
            <p className="mt-2 text-sm text-slate-600">Nothing is due in this deck right now. Come back later and the cards you need will be waiting.</p>
          ) : (
            <>
              <p className="mt-2 text-sm text-slate-600">
                You reviewed {total} {total === 1 ? "card" : "cards"} and remembered {remembered} of {reviewed} answers.
              </p>
              <dl className="mx-auto mt-6 grid max-w-sm grid-cols-4 gap-2 text-center">
                {GRADES.map((g) => (
                  <div key={g.grade} className="rounded-xl bg-slate-50 py-3">
                    <dd className="text-xl font-semibold tabular-nums text-slate-900">{tally[g.grade]}</dd>
                    <dt className="text-xs text-slate-500">{g.label}</dt>
                  </div>
                ))}
              </dl>
            </>
          )}
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {data.remaining > 0 && <Button onClick={() => setRound((r) => r + 1)}>Keep going ({data.remaining} more)</Button>}
            <Link to={`/flashcards/${deckId}`} className="inline-flex h-11 items-center rounded-xl bg-white px-5 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50">
              Back to the deck
            </Link>
          </div>
        </div>
      ) : (
        <div className="mt-6">
          <div
            className="flex min-h-72 flex-col justify-between rounded-(--radius-card) bg-white p-6 shadow-card ring-1 ring-slate-200/70 sm:p-8"
            data-testid="flashcard"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{revealed ? "Answer" : "Question"}</p>
            <div className="my-6 text-center">
              <p className="break-words font-display text-2xl font-medium leading-snug text-slate-900 sm:text-[1.9rem]">{revealed ? current.back : current.front}</p>
              {revealed && <p className="mt-4 break-words text-sm text-slate-500">{current.front}</p>}
              {!revealed && showHint && current.hint && <p className="mt-4 text-sm italic text-slate-500">Hint: {current.hint}</p>}
            </div>
            <div className="flex justify-center">
              {!revealed && current.hint && !showHint && (
                <button type="button" onClick={() => setShowHint(true)} className="h-9 rounded-lg px-3 text-sm font-medium text-brand-700 hover:bg-brand-50">
                  Show hint
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="mt-3">
              <Alert tone="error">{error}</Alert>
            </div>
          )}

          {!revealed ? (
            <Button className="mt-4 w-full" onClick={() => setRevealed(true)}>
              Show answer <span className="ml-1 hidden text-xs opacity-75 sm:inline">(Space)</span>
            </Button>
          ) : (
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="How well did you remember it?">
              {GRADES.map((g) => (
                <button
                  key={g.grade}
                  type="button"
                  disabled={saving}
                  onClick={() => void grade(g.grade)}
                  title={g.hint}
                  className={`flex min-h-16 flex-col items-center justify-center rounded-xl px-2 py-2 text-sm font-semibold ring-1 transition disabled:cursor-not-allowed disabled:opacity-60 ${g.tone}`}
                >
                  <span>{g.label}</span>
                  <span className="mt-0.5 text-xs font-normal opacity-80">{intervalLabel(current.nextDays[g.grade])}</span>
                  <span className="sr-only">Key {g.key}</span>
                </button>
              ))}
            </div>
          )}
          <p className="mt-3 hidden text-center text-xs text-slate-500 sm:block">Space flips the card. After flipping, press 1 Again, 2 Hard, 3 Good or 4 Easy.</p>
        </div>
      )}
    </div>
  );
}
