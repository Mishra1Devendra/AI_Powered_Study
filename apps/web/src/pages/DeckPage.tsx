import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { STUDY_TOOLS_LIMITS, type Flashcard } from "@copilot/shared";
import { useAuth } from "../auth/AuthProvider";
import { Alert } from "../components/ui/Alert";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { ErrorState } from "../components/ui/ErrorState";
import { LoadingState } from "../components/ui/LoadingState";
import { Spinner } from "../components/ui/Spinner";
import { dueLabel, stateTone } from "../features/study-tools/format";
import { fieldClass } from "../features/study-tools/SourceForm";
import { useDeck } from "../features/study-tools/useStudyTools";
import { friendlyMessage } from "../lib/errors";
import { addCard, deleteCard, deleteDeck, renameDeck, updateCard } from "../lib/studyToolsApi";

function CardEditor({ initial, submitLabel, onSubmit, onCancel }: { initial?: Flashcard; submitLabel: string; onSubmit: (v: { front: string; back: string; hint: string }) => Promise<void>; onCancel?: () => void }) {
  const [front, setFront] = useState(initial?.front ?? "");
  const [back, setBack] = useState(initial?.back ?? "");
  const [hint, setHint] = useState(initial?.hint ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = front.trim() !== "" && back.trim() !== "";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ front: front.trim(), back: back.trim(), hint: hint.trim() });
      if (!initial) (setFront(""), setBack(""), setHint(""));
    } catch (err) {
      setError(friendlyMessage(err, "Could not save the card. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-medium text-slate-800">
          Front (question)
          <textarea value={front} onChange={(e) => setFront(e.target.value)} maxLength={STUDY_TOOLS_LIMITS.frontMaxChars} rows={3} className="mt-1.5 w-full rounded-xl bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600" />
        </label>
        <label className="block text-sm font-medium text-slate-800">
          Back (answer)
          <textarea value={back} onChange={(e) => setBack(e.target.value)} maxLength={STUDY_TOOLS_LIMITS.backMaxChars} rows={3} className="mt-1.5 w-full rounded-xl bg-white px-3 py-2 text-sm text-slate-900 ring-1 ring-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-600" />
        </label>
      </div>
      <label className="block text-sm font-medium text-slate-800">
        Hint <span className="font-normal text-slate-600">(optional)</span>
        <input value={hint} onChange={(e) => setHint(e.target.value)} maxLength={STUDY_TOOLS_LIMITS.hintMaxChars} className={`mt-1.5 ${fieldClass}`} />
      </label>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" loading={busy} disabled={!ready} className="h-10">
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} className="h-10">
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

/** `/flashcards/:deckId`: the cards of one deck - read, edit, add, delete - and the way into a study round. */
export default function DeckPage() {
  const { deckId = "" } = useParams();
  const { client } = useAuth();
  const navigate = useNavigate();
  const deck = useDeck(client, deckId);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const now = useMemo(() => new Date(), [deck.state]);

  if (deck.state.status === "loading") return <LoadingState label="Loading the deck…" />;
  if (deck.state.status === "error") {
    const gone = /not found/i.test(deck.state.message);
    return (
      <div className="space-y-4">
        <ErrorState message={gone ? "That deck doesn't exist any more." : deck.state.message} {...(gone ? {} : { onRetry: () => void deck.reload() })} />
        <Link to="/flashcards" className="inline-block text-sm font-medium text-brand-700 underline">
          Back to your decks
        </Link>
      </div>
    );
  }

  const { deck: d, cards } = deck.state.data;
  const fail = (err: unknown, fallback: string) => setNotice(friendlyMessage(err, fallback));

  async function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await renameDeck(client, d.id, title.trim());
      setRenaming(false);
      await deck.refresh();
    } catch (err) {
      fail(err, "Could not rename the deck.");
    }
  }

  async function removeDeck() {
    try {
      await deleteDeck(client, d.id);
      navigate("/flashcards");
    } catch (err) {
      fail(err, "Could not delete the deck.");
    }
  }

  return (
    <div className="animate-fade-up mx-auto max-w-4xl">
      <Link to="/flashcards" className="-ml-2.5 inline-flex h-10 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-slate-700 hover:bg-slate-100">
        <span aria-hidden="true">←</span> All decks
      </Link>

      <header className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          {renaming ? (
            <form onSubmit={(e) => void saveName(e)} className="flex flex-wrap gap-2">
              <input aria-label="Deck name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={STUDY_TOOLS_LIMITS.titleMaxChars} className={`${fieldClass} sm:w-80`} />
              <Button type="submit" className="h-11">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            </form>
          ) : (
            <h1 className="break-words text-2xl font-semibold tracking-tight">{d.title}</h1>
          )}
          <p className="mt-1 text-sm text-slate-600">
            {d.status === "ready" ? `${d.cardCount} ${d.cardCount === 1 ? "card" : "cards"} · ${d.dueCount} due · ${d.newCount} new` : d.status === "generating" ? "Being written…" : "Could not be written"}
            {d.isMock && d.status === "ready" && <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-200">Demo AI: placeholder cards</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {d.status === "ready" && d.dueCount + d.newCount > 0 && (
            <Link to={`/flashcards/${d.id}/study`} className="inline-flex h-11 items-center rounded-xl bg-brand-600 px-5 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
              Study now
            </Link>
          )}
          {!renaming && (
            <Button variant="secondary" onClick={() => (setTitle(d.title), setRenaming(true))}>
              Rename
            </Button>
          )}
          <Button variant="secondary" onClick={() => setConfirmDelete(true)} className="text-red-700">
            Delete
          </Button>
        </div>
      </header>

      {notice && (
        <div className="mt-4">
          <Alert tone="error">{notice}</Alert>
        </div>
      )}

      {confirmDelete && (
        <div role="alertdialog" aria-label="Delete this deck?" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 ring-1 ring-red-200">
          <p className="text-sm text-red-900">Delete this deck and its {cards.length} cards? This can&apos;t be undone.</p>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} className="h-10">
              Keep it
            </Button>
            <Button onClick={() => void removeDeck()} className="h-10 bg-red-600 hover:bg-red-700">
              Delete deck
            </Button>
          </div>
        </div>
      )}

      {d.status === "generating" && (
        <Card className="mt-6">
          <p className="flex items-center gap-3 text-sm text-slate-700" role="status">
            <Spinner /> Writing your cards. This usually takes under a minute; you can leave this page and come back.
          </p>
        </Card>
      )}
      {d.status === "error" && (
        <div className="mt-6">
          <ErrorState message={d.error ?? "The cards could not be written."} />
        </div>
      )}

      {d.status === "ready" && (
        <div className="mt-6 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold tracking-tight">Cards</h2>
            <Button variant="secondary" onClick={() => setAdding((a) => !a)} aria-expanded={adding} className="h-10">
              {adding ? "Close" : "Add a card"}
            </Button>
          </div>

          {adding && (
            <Card>
              <CardEditor
                submitLabel="Add card"
                onSubmit={async (v) => {
                  await addCard(client, d.id, { front: v.front, back: v.back, ...(v.hint ? { hint: v.hint } : {}) });
                  await deck.refresh();
                }}
              />
            </Card>
          )}

          {cards.length === 0 ? (
            <Card>
              <p className="text-sm text-slate-600">This deck has no cards yet. Add your first one above.</p>
            </Card>
          ) : (
            <ul className="space-y-3" aria-label="Cards in this deck">
              {cards.map((c) => (
                <li key={c.id} className="rounded-2xl bg-white p-4 shadow-card ring-1 ring-slate-200/70">
                  {editing === c.id ? (
                    <CardEditor
                      initial={c}
                      submitLabel="Save changes"
                      onCancel={() => setEditing(null)}
                      onSubmit={async (v) => {
                        await updateCard(client, c.id, { front: v.front, back: v.back, hint: v.hint });
                        setEditing(null);
                        await deck.refresh();
                      }}
                    />
                  ) : (
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="break-words font-medium text-slate-900">{c.front}</p>
                        <p className="mt-1 break-words text-sm text-slate-600">{c.back}</p>
                        {c.hint && <p className="mt-1 text-xs italic text-slate-500">Hint: {c.hint}</p>}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-2">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${stateTone[c.state]}`}>{dueLabel(c, now)}</span>
                        <div className="flex gap-1">
                          <button type="button" onClick={() => setEditing(c.id)} aria-label={`Edit card: ${c.front}`} className="h-9 rounded-lg px-3 text-sm font-medium text-slate-700 hover:bg-slate-100">
                            Edit
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete card: ${c.front}`}
                            onClick={() =>
                              void deleteCard(client, c.id)
                                .then(() => deck.refresh())
                                .catch((err: unknown) => fail(err, "Could not delete the card."))
                            }
                            className="h-9 rounded-lg px-3 text-sm font-medium text-red-700 hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
