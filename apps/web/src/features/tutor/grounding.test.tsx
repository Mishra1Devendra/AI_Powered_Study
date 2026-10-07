import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TutorMessage, TutorStreamEvent } from "@copilot/shared";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeBackend, uid, type Call } from "../../dev/fakeTutorBackend";
import { sourceLabel } from "./MessageItem";

/** Phase 11 on the Tutor screen: answers from the student's notes, their real sources, and "not in your notes". */
const USER_ID = "11111111-1111-4111-8111-111111111111";
const DOC = uid(7);

function makeClient() {
  const session = { access_token: "tok", user: { id: USER_ID, email: "r@example.com" } } as unknown as Session;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

let path = "";
function Probe() {
  path = useLocation().pathname;
  return null;
}
function renderTutor(entry: string | { pathname: string; state: unknown } = "/tutor") {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider client={makeClient()}>
        <Probe />
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

let backend: ReturnType<typeof makeBackend>;
beforeEach(() => {
  backend = makeBackend({ mock: false });
  vi.stubGlobal("fetch", backend.fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const composer = () => screen.getByRole("textbox", { name: "Message your tutor" });
const sends = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));

/** Makes the next answer a grounded / not-found / general one, the way the real server reports them. */
function answerWith(extra: Partial<TutorMessage>, text: string) {
  backend.knobs.reply = () => {
    const conversationId = backend.conversations[0]!.id;
    const message = backend.mk(conversationId, "assistant", text, { isMock: false, model: "llama3.2:3b", ...extra });
    backend.messages[conversationId]!.push(message);
    const events: TutorStreamEvent[] = [{ type: "delta", text }, { type: "done", message, conversation: { ...backend.conversations[0]! } }];
    return events;
  };
}

const SOURCES = [
  { key: "S1", chunkIndex: 3, page: 14, heading: "Entropy", documentId: DOC, documentTitle: "Thermodynamics.pdf" },
  { key: "S2", chunkIndex: 4, page: null, heading: "Heat engines", documentId: DOC, documentTitle: "Thermodynamics.pdf" },
];

describe("answers from the student's notes", () => {
  it("labels a grounded answer 'From your notes' and shows its REAL sources as links to the document", async () => {
    answerWith({ grounding: "grounded", sources: SOURCES }, "Entropy never decreases in an isolated system [S1].");
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "What does my document say about entropy?{Enter}");
    expect(await screen.findByText("From your notes")).toBeInTheDocument();
    const sources = screen.getByText("Sources from your notes").parentElement!;
    const first = within(sources).getByRole("link", { name: "Thermodynamics.pdf – Page 14" });
    expect(first).toHaveAttribute("href", `/notes/${DOC}`);
    // No page number is invented for a passage that has none: the section is shown instead.
    expect(within(sources).getByRole("link", { name: "Thermodynamics.pdf – Section: Heat engines" })).toBeInTheDocument();
    expect(within(sources).queryByText(/Page null|undefined/)).toBeNull();
  });

  it("a general answer carries no sources and no 'from your notes' claim", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "What is entropy?{Enter}");
    expect(await screen.findByText(/Answer to: What is entropy\?/)).toBeInTheDocument();
    expect(screen.queryByText("From your notes")).toBeNull();
    expect(screen.queryByText("Sources from your notes")).toBeNull();
  });

  it("'not in your notes' offers Explain generally, which asks the SAME question again from general knowledge", async () => {
    answerWith({ grounding: "not_found", model: "knowledge-index", isMock: false }, "I couldn't find this topic in your uploaded material. I can still explain it using general knowledge.");
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "What is the Carnot efficiency?{Enter}");
    expect(await screen.findByText(/I couldn't find this topic in your uploaded material/)).toBeInTheDocument();
    expect(screen.queryByText("Sources from your notes")).toBeNull(); // no fake citation
    expect(screen.queryByRole("button", { name: "Regenerate" })).toBeNull(); // regenerating the same miss would be pointless

    answerWith({ grounding: "general" }, "General explanation: the Carnot efficiency is 1 - Tc/Th.");
    await user.click(screen.getByRole("button", { name: "Explain generally" }));
    expect(await screen.findByText("General explanation - not from your notes")).toBeInTheDocument();
    const body = sends(backend.calls).at(-1)!.body;
    expect(body).toEqual({ content: "What is the Carnot efficiency?", grounding: "general" });
    // The button only belongs to the latest 'not found' reply.
    expect(screen.queryByRole("button", { name: "Explain generally" })).toBeNull();
  });
});

describe("Ask AI about this document", () => {
  it("shows what the chat is about, sends the document with each question, and can be switched off", async () => {
    const { user } = renderTutor({ pathname: "/tutor", state: { documentId: DOC, documentTitle: "Thermodynamics.pdf" } });
    expect(await screen.findByText("Thermodynamics.pdf")).toBeInTheDocument();
    expect(screen.getByText("Asking about:")).toBeInTheDocument();
    await user.type(composer(), "Summarise entropy{Enter}");
    await waitFor(() => expect(sends(backend.calls)).toHaveLength(1));
    expect(sends(backend.calls)[0]!.body).toEqual({ content: "Summarise entropy", documentId: DOC });

    // The scope survives the move to /tutor/:id and the next question.
    await waitFor(() => expect(path).toMatch(/^\/tutor\/0000/));
    await user.type(composer(), "And the second law?{Enter}");
    await waitFor(() => expect(sends(backend.calls)).toHaveLength(2));
    expect(sends(backend.calls)[1]!.body).toEqual({ content: "And the second law?", documentId: DOC });

    await user.click(await screen.findByRole("button", { name: "Ask about all my notes" }));
    expect(screen.queryByText("Asking about:")).toBeNull();
    await user.type(composer(), "Another question{Enter}");
    await waitFor(() => expect(sends(backend.calls)).toHaveLength(3));
    expect(sends(backend.calls)[2]!.body).toEqual({ content: "Another question" });
  });

  it("a plain visit to the tutor is not tied to any document", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "hello{Enter}");
    await waitFor(() => expect(sends(backend.calls)).toHaveLength(1));
    expect(sends(backend.calls)[0]!.body).toEqual({ content: "hello" });
    expect(screen.queryByText("Asking about:")).toBeNull();
  });
});

describe("source labels", () => {
  it("use only real metadata", () => {
    expect(sourceLabel({ key: "S1", chunkIndex: 0, page: 14, heading: null, documentTitle: "Notes.pdf", documentId: DOC })).toBe("Notes.pdf – Page 14");
    expect(sourceLabel({ key: "S1", chunkIndex: 0, page: null, heading: "Entropy", documentTitle: "Notes.pdf", documentId: DOC })).toBe("Notes.pdf – Section: Entropy");
    expect(sourceLabel({ key: "S1", chunkIndex: 0, page: null, heading: null, documentTitle: "Notes.pdf", documentId: DOC })).toBe("Notes.pdf");
    expect(sourceLabel({ key: "S2", chunkIndex: 0, page: null, heading: null })).toBe("Source S2");
  });
});
