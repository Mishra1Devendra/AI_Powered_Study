import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { AI_COST, STUDY_TOOLS_LIMITS, type Deck } from "@copilot/shared";
import { AiUsageNote } from "../features/ai-usage/AiUsageNote";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmblemBadge } from "../components/ui/EmblemBadge";
import { CardsIcon, SparkIcon } from "../components/ui/Icons";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { Spinner } from "../components/ui/Spinner";
import { fieldClass, SourceForm } from "../features/study-tools/SourceForm";
import { useDecks } from "../features/study-tools/useStudyTools";
import { useQuizOptions } from "../features/quiz/useQuizData";
import { friendlyMessage } from "../lib/errors";
import { createDeck, generateDeck } from "../lib/studyToolsApi";

const COUNTS = [8, 12, 20, 30] as const;

function Stat({ label, value, tone = "text-slate-900" }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl bg-white px-5 py-4 shadow-card ring-1 ring-slate-200/70">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={`mt-1 text-3xl font-semibold tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

function DeckTile({ deck }: { deck: Deck }) {
  const studiable = deck.status === "ready" && deck.dueCount + deck.newCount > 0;
  return (
    <li className="flex flex-col rounded-(--radius-card) bg-white p-5 shadow-card ring-1 ring-slate-200/70 transition hover:ring-brand-200">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/flashcards/${deck.id}`} className="-my-1.5 min-w-0 py-1.5 text-base font-semibold text-slate-900 hover:text-brand-700">
          <span className="line-clamp-2 break-words">{deck.title}</span>
        </Link>
        {deck.isMock && deck.status === "ready" && <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">Demo AI</span>}
      </div>
      <p className="mt-1 text-xs text-slate-500">{deck.sourceType === "notes" ? "From your notes" : deck.sourceType === "topic" ? "From a subject" : "Written by you"}</p>

      {deck.status === "generating" && (
        <p className="mt-4 flex items-center gap-2 text-sm text-slate-600" role="status">
          <Spinner className="h-4 w-4" /> Writing your cards…
        </p>
      )}
      {deck.status === "error" && <p className="mt-4 text-sm text-red-700">{deck.error}</p>}
      {deck.status === "ready" && (
        <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-slate-50 py-2">
            <dd className="text-lg font-semibold tabular-nums text-slate-900">{deck.cardCount}</dd>
            <dt className="text-xs text-slate-500">cards</dt>
          </div>
          <div className={`rounded-xl py-2 ${deck.dueCount > 0 ? "bg-amber-50" : "bg-slate-50"}`}>
            <dd className={`text-lg font-semibold tabular-nums ${deck.dueCount > 0 ? "text-amber-800" : "text-slate-900"}`}>{deck.dueCount}</dd>
            <dt className="text-xs text-slate-500">due</dt>
          </div>
          <div className="rounded-xl bg-slate-50 py-2">
            <dd className="text-lg font-semibold tabular-nums text-slate-900">{deck.newCount}</dd>
            <dt className="text-xs text-slate-500">new</dt>
          </div>
        </dl>
      )}

      <div className="mt-5 flex gap-2">
        {studiable && (
          <Link to={`/flashcards/${deck.id}/study`} className="inline-flex h-10 flex-1 items-center justify-center rounded-xl bg-brand-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
            Study
          </Link>
        )}
        <Link to={`/flashcards/${deck.id}`} className="inline-flex h-10 flex-1 items-center justify-center rounded-xl bg-white px-4 text-sm font-medium text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50">
          {deck.status === "ready" ? "Open" : "View"}
        </Link>
      </div>
    </li>
  );
}

/** `/flashcards`: your decks, what is due today, and the way to make a new deck (written by the AI, or by hand). */
export default function FlashcardsPage() {
  const { client } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const decks = useDecks(client);
  const options = useQuizOptions(client);
  // "Make flashcards" on a note arrives with that note chosen; the panel opens, but nothing starts until the button is pressed.
  const fromNote = params.get("document")?.slice(0, 64) ?? undefined;
  const [open, setOpen] = useState(Boolean(fromNote));
  const [mode, setMode] = useState<"ai" | "empty">("ai");
  const [count, setCount] = useState<number>(STUDY_TOOLS_LIMITS.defaultCards);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const data = decks.state.status === "ready" ? decks.state.data : null;

  async function makeEmpty(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      navigate(`/flashcards/${(await createDeck(client, name.trim())).id}`);
    } catch (err) {
      setError(friendlyMessage(err, "Could not create the deck. Please try again."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="animate-fade-up">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Flashcards</h1>
          <p className="mt-1 text-sm text-slate-600">Short cards that bring back what you forget, just before you forget it.</p>
        </div>
        <Button onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <SparkIcon className="h-4 w-4" /> {open ? "Close" : "New deck"}
        </Button>
      </header>

      {open && (
        <Card className="mt-6">
          <div role="tablist" aria-label="How to make the deck" className="mb-5 inline-flex gap-1 rounded-xl bg-slate-100 p-1">
            {(["ai", "empty"] as const).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={`h-10 rounded-lg px-4 text-sm font-medium transition ${mode === m ? "bg-white text-brand-700 shadow-sm ring-1 ring-slate-200" : "text-slate-600 hover:text-slate-900"}`}>
                {m === "ai" ? "Write with AI" : "Start empty"}
              </button>
            ))}
          </div>

          {mode === "ai" && <AiUsageNote cost={AI_COST.flashcards} className="mb-5" />}
          {mode === "ai" && options.state.status === "loading" && <LoadingState label="Loading your notes…" shape="form" />}
          {mode === "ai" && options.state.status === "error" && <ErrorState message={options.state.message} onRetry={() => void options.reload()} />}
          {mode === "ai" && options.state.status === "ready" && (
            <SourceForm
              options={options.state.data}
              prefillDocumentId={fromNote}
              submitLabel="Write my cards"
              error={error}
              extra={
                <fieldset>
                  <legend className="text-sm font-medium text-slate-800">How many cards?</legend>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {COUNTS.map((c) => (
                      <button key={c} type="button" aria-pressed={count === c} onClick={() => setCount(c)} className={`h-10 min-w-14 rounded-xl px-4 text-sm font-medium ring-1 transition ${count === c ? "bg-brand-50 text-brand-700 ring-2 ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50"}`}>
                        {c}
                      </button>
                    ))}
                  </div>
                </fieldset>
              }
              onSubmit={async (source, title) => {
                setError(null);
                try {
                  const deck = await generateDeck(client, { source, count, ...(title ? { title } : {}) });
                  setOpen(false);
                  navigate(`/flashcards/${deck.id}`);
                } catch (err) {
                  setError(friendlyMessage(err, "Could not start writing the cards. Please try again."));
                }
              }}
            />
          )}

          {mode === "empty" && (
            <form onSubmit={(e) => void makeEmpty(e)} className="space-y-4">
              <div>
                <label htmlFor="deck-name" className="text-sm font-medium text-slate-800">
                  Deck name
                </label>
                <input id="deck-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={STUDY_TOOLS_LIMITS.titleMaxChars} placeholder="e.g. Organic chemistry reactions" className={`mt-1.5 ${fieldClass}`} />
              </div>
              {error && <Alert tone="error">{error}</Alert>}
              <Button type="submit" loading={creating} disabled={!name.trim()}>
                Create deck
              </Button>
            </form>
          )}
        </Card>
      )}

      {decks.state.status === "loading" && <LoadingState label="Loading your decks…" />}
      {decks.state.status === "error" && (
        <div className="mt-6">
          <ErrorState message={decks.state.message} onRetry={() => void decks.reload()} />
        </div>
      )}

      {data && (
        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <Stat label="Due for review" value={data.dueTotal} tone={data.dueTotal > 0 ? "text-amber-700" : "text-slate-900"} />
            <Stat label="Reviewed today" value={data.reviewedToday} tone="text-emerald-700" />
          </div>

          {data.decks.length === 0 ? (
            <div className="rounded-(--radius-card) bg-white shadow-card ring-1 ring-slate-200/70">
              <div className="mx-auto flex max-w-lg flex-col items-center px-4 py-14 text-center">
                <EmblemBadge>
                  <CardsIcon className="h-7 w-7" />
                </EmblemBadge>
                <h2 className="mt-5 font-display text-2xl font-semibold tracking-tight text-slate-900">Turn your notes into flashcards.</h2>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">Pick a note or a subject and get a deck in a moment. Each time you review, the cards you find hard come back sooner and the ones you know come back later.</p>
                <Button className="mt-6" onClick={() => setOpen(true)}>
                  <SparkIcon className="h-4 w-4" /> Make my first deck
                </Button>
              </div>
            </div>
          ) : (
            <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Your decks">
              {data.decks.map((d) => (
                <DeckTile key={d.id} deck={d} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
