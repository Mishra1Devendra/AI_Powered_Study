import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeBackend, makeChunks, makeNote, nid, type Call } from "../../dev/fakeNotesBackend";

const USER_ID = "11111111-1111-4111-8111-111111111111";

/* ------------------------------------ rendering ------------------------------------ */

function makeClient(signedIn = true) {
  const session = signedIn ? ({ access_token: "tok", user: { id: USER_ID, email: "r@example.com" } } as unknown as Session) : null;
  return {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(async () => ({ error: null })),
    },
  } as unknown as SupabaseClient;
}

let currentPath = "";
function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function renderNotes(path = "/notes", signedIn = true, opts: Parameters<typeof userEvent.setup>[0] = {}) {
  const user = userEvent.setup(opts);
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={makeClient(signedIn)}>
        <PathProbe />
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

let backend: ReturnType<typeof makeBackend>;
function useBackend(seed?: Parameters<typeof makeBackend>[0]) {
  backend = makeBackend(seed);
  vi.stubGlobal("fetch", backend.fetchMock);
  vi.stubGlobal("XMLHttpRequest", backend.FakeXHR);
}

const scrollIntoView = vi.fn();
beforeEach(() => {
  useBackend();
  scrollIntoView.mockClear();
  Element.prototype.scrollIntoView = scrollIntoView;
});
afterEach(() => vi.unstubAllGlobals());

const pdf = (name = "chem.pdf", size = 2048) => new File([new Uint8Array(size)], name, { type: "application/pdf" });
const listCalls = (calls: Call[]) => calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/notes?") || (c.method === "GET" && c.url === "/api/notes"));
const dialog = () => screen.getByRole("dialog", { name: "Add study material" });

/* --------------------------------------- library --------------------------------------- */

describe("access", () => {
  it("signed-in students can open /notes; the sidebar no longer marks Notes as upcoming", async () => {
    renderNotes();
    expect(await screen.findByRole("heading", { level: 1, name: "Notes" })).toBeInTheDocument();
  });

  it("a signed-out visitor is redirected to login and nothing is requested", async () => {
    renderNotes("/notes", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });
});

describe("library states", () => {
  it("shows a loading state, then the first-time empty state with one clear action (no sample notes)", async () => {
    const fast = backend.fetchMock;
    vi.stubGlobal("fetch", async (...args: Parameters<typeof fetch>) => {
      await new Promise((r) => setTimeout(r, 60));
      return fast(...args);
    });
    renderNotes();
    expect(await screen.findByText("Loading your notes…")).toBeInTheDocument();
    expect(await screen.findByText("Turn your study material into an interactive study companion.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Upload Notes" }).length).toBeGreaterThan(0);
    expect(within(screen.getByRole("main")).queryByRole("listitem")).toBeNull();
  });

  it("shows an error with Try again, and recovers", async () => {
    backend.knobs.networkDown = true;
    const { user } = renderNotes();
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
    backend.knobs.networkDown = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Turn your study material into an interactive study companion.")).toBeInTheDocument();
  });

  it("lists notes with type, size, status and sections; only READY notes can be opened", async () => {
    useBackend({
      notes: [
        makeNote(1, { title: "Thermodynamics", pageCount: 12, chunkCount: 34, fileSize: 1_572_864 }),
        makeNote(2, { title: "Organic chem", status: "processing", chunkCount: 0, pageCount: null }),
        makeNote(3, { title: "Broken scan", status: "failed", error: "This PDF has no selectable text.", chunkCount: 0, pageCount: null }),
      ],
    });
    renderNotes();
    const ready = (await screen.findByRole("link", { name: "Thermodynamics" })).closest("li")!;
    expect(within(ready).getByText("Ready")).toBeInTheDocument();
    expect(within(ready).getByText(/PDF · 1\.5 MB · 12 pages · 34 sections/)).toBeInTheDocument();
    expect(within(ready).getByRole("link", { name: "Open" })).toBeInTheDocument();

    const busy = screen.getByText("Organic chem").closest("li")!;
    expect(within(busy).getByText("Processing")).toBeInTheDocument();
    expect(within(busy).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow"); // indeterminate, never a fake %
    expect(within(busy).queryByRole("link")).toBeNull();

    const failed = screen.getByText("Broken scan").closest("li")!;
    expect(within(failed).getByText("Failed")).toBeInTheDocument();
    expect(within(failed).getByRole("alert")).toHaveTextContent("This PDF has no selectable text.");
    expect(within(failed).getByRole("button", { name: "Retry processing" })).toBeInTheDocument();
  });

  it("retrying a failed note processes it", async () => {
    useBackend({ notes: [makeNote(1, { title: "Broken scan", status: "failed", error: "No text.", chunkCount: 0 })] });
    const { user } = renderNotes();
    await user.click(await screen.findByRole("button", { name: "Retry processing" }));
    const link = await screen.findByRole("link", { name: "Broken scan" });
    expect(within(link.closest("li")!).getByText("Ready")).toBeInTheDocument();
  });

  it("refreshes by itself while a note is processing, and stops once nothing is busy", async () => {
    useBackend({ notes: [makeNote(1, { title: "Slow one", status: "processing", chunkCount: 0 })] });
    renderNotes();
    const row = (await screen.findByText("Slow one")).closest("li")!;
    expect(within(row).getByText("Processing")).toBeInTheDocument();
    backend.notes[0]!.status = "ready"; // the server finished
    await waitFor(() => expect(within(row).getByText("Ready")).toBeInTheDocument(), { timeout: 5000 });
    const before = listCalls(backend.calls).length;
    await new Promise((r) => setTimeout(r, 3000));
    expect(listCalls(backend.calls).length).toBe(before); // no polling once idle
  }, 12000);
});

describe("search, filter and sort", () => {
  beforeEach(() =>
    useBackend({
      notes: [
        makeNote(1, { title: "Thermodynamics", originalFilename: "thermo.pdf" }),
        makeNote(2, { title: "Cell biology", originalFilename: "cells.md", fileType: "md" }),
        makeNote(3, { title: "Broken", status: "failed", error: "x" }),
      ],
    }),
  );

  it("searches by title (debounced) and offers to clear when nothing matches", async () => {
    const { user } = renderNotes();
    await screen.findByText("Thermodynamics");
    await user.type(screen.getByRole("searchbox", { name: /Search notes/ }), "cell");
    await waitFor(() => expect(screen.queryByText("Thermodynamics")).toBeNull());
    expect(screen.getByText("Cell biology")).toBeInTheDocument();
    // typing 4 letters must not have produced 4 requests
    expect(listCalls(backend.calls).filter((c) => c.url.includes("q=")).length).toBeLessThanOrEqual(2);

    await user.clear(screen.getByRole("searchbox", { name: /Search notes/ }));
    await user.type(screen.getByRole("searchbox", { name: /Search notes/ }), "zzz");
    expect(await screen.findByText("No notes match your search")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(await screen.findByText("Thermodynamics")).toBeInTheDocument();
  });

  it("filters by file type and status, and sorts", async () => {
    const { user } = renderNotes();
    await screen.findByText("Thermodynamics");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by file type" }), "md");
    await waitFor(() => expect(screen.queryByText("Thermodynamics")).toBeNull());
    expect(screen.getByText("Cell biology")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by file type" }), "");
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "failed");
    await waitFor(() => expect(screen.queryByText("Cell biology")).toBeNull());
    expect(screen.getByText("Broken")).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by status" }), "");
    await user.selectOptions(screen.getByRole("combobox", { name: "Sort notes" }), "name");
    await waitFor(() => expect(listCalls(backend.calls).some((c) => c.url.includes("sort=name"))).toBe(true));
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Broken", "Cell biology", "Thermodynamics"]);
  });
});

describe("removing a note", () => {
  it("asks first, then removes it from the library (soft delete on the server)", async () => {
    useBackend({ notes: [makeNote(1, { title: "Thermodynamics" }), makeNote(2, { title: "Cell biology" })] });
    const { user } = renderNotes();
    await user.click(await screen.findByRole("button", { name: "Remove Thermodynamics from library" }));
    expect(backend.calls.some((c) => c.method === "DELETE")).toBe(false); // not yet
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Thermodynamics")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Thermodynamics from library" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("Thermodynamics")).toBeNull());
    expect(backend.calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`/api/notes/${nid(1)}`]);
    expect(screen.getByText("Cell biology")).toBeInTheDocument();
  });
});

/* ---------------------------------------- upload ---------------------------------------- */

describe("upload", () => {
  it("opens an accessible dialog with file and paste options, and closes on Escape returning focus", async () => {
    const { user } = renderNotes();
    const opener = (await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!;
    await user.click(opener);
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("tab", { name: "Upload a file", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Paste text" })).toBeInTheDocument();
    expect(screen.getByText(/PDF, TXT or Markdown · up to 10 MB/)).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("uploads a PDF with the file picker: the new note appears and the dialog closes", async () => {
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    await user.upload(screen.getByLabelText("Choose a file"), pdf("chem.pdf"));
    expect(await screen.findByRole("link", { name: "chem" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.calls.find((c) => c.url === "/api/notes" && c.method === "POST")?.body).toEqual({ file: "chem.pdf", size: 2048 });
  });

  it("uploads by drag and drop", async () => {
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    fireEvent.drop(screen.getByTestId("drop-zone"), { dataTransfer: { files: [pdf("dropped.pdf")] } });
    expect(await screen.findByRole("link", { name: "dropped" })).toBeInTheDocument();
  });

  it("rejects several dropped files at once", async () => {
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    fireEvent.drop(screen.getByTestId("drop-zone"), { dataTransfer: { files: [pdf("a.pdf"), pdf("b.pdf")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("one file at a time");
    expect(backend.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("rejects unsupported types and empty files in the browser, before any upload", async () => {
    const { user } = renderNotes("/notes", true, { applyAccept: false });
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    await user.upload(screen.getByLabelText("Choose a file"), new File(["x"], "virus.exe"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported file type");
    await user.upload(screen.getByLabelText("Choose a file"), new File([], "empty.pdf"));
    expect(await screen.findByRole("alert")).toHaveTextContent("empty");
    expect(backend.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("shows REAL byte progress, then switches to an indeterminate Processing state (never a fake 100%)", async () => {
    backend.knobs.upload = "hold";
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    await user.upload(screen.getByLabelText("Choose a file"), pdf("big.pdf", 4000));

    expect(await within(dialog()).findByText("Starting upload…")).toBeInTheDocument();
    expect(within(dialog()).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow"); // no bytes reported yet

    backend.held.current!.progress(1000, 4000);
    const bar = await within(dialog()).findByRole("progressbar", { name: "Upload progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "25");
    expect(within(dialog()).getByText(/Uploading… 25%/)).toBeInTheDocument();

    backend.held.current!.progress(4000, 4000);
    expect(await within(dialog()).findByText("Reading and organising your material…")).toBeInTheDocument();
    expect(within(dialog()).getByRole("progressbar", { name: "Processing" })).not.toHaveAttribute("aria-valuenow");

    backend.held.current!.finish();
    expect(await screen.findByRole("link", { name: "big" })).toBeInTheDocument();
  });

  it("Cancel aborts the in-flight upload and closes the dialog", async () => {
    backend.knobs.upload = "hold";
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    await user.upload(screen.getByLabelText("Choose a file"), pdf("big.pdf"));
    await user.click(await within(dialog()).findByRole("button", { name: "Cancel" }));
    expect(backend.held.current!.aborted).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(backend.notes).toHaveLength(0);
  });

  it("tells the student about a duplicate and links to the existing note", async () => {
    useBackend({ notes: [makeNote(1, { title: "Chem", originalFilename: "chem.pdf" })] });
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    await user.upload(screen.getByLabelText("Choose a file"), pdf("chem.pdf"));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent('You already uploaded this as "Chem".');
    await user.click(within(dialog()).getByRole("link", { name: "Open the existing note" }));
    await waitFor(() => expect(currentPath).toBe(`/notes/${nid(1)}`));
  });

  it("shows the server's reason when the upload is refused, and a network message when offline", async () => {
    backend.knobs.uploadError = { status: 422, body: { error: "unsupported", message: "This PDF is password-protected." } };
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    await user.upload(screen.getByLabelText("Choose a file"), pdf("locked.pdf"));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent("password-protected");

    backend.knobs.uploadError = null;
    backend.knobs.networkDown = true;
    await user.upload(screen.getByLabelText("Choose a file"), pdf("again.pdf"));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(/Could not reach the server/);
  });

  it("adds pasted text with an optional title, counting characters", async () => {
    const { user } = renderNotes();
    await user.click((await screen.findAllByRole("button", { name: "Upload Notes" }))[0]!);
    await user.click(screen.getByRole("tab", { name: "Paste text" }));
    expect(screen.getByRole("button", { name: "Add to library" })).toBeDisabled();
    await user.type(screen.getByLabelText(/Title/), "Lecture 4");
    await user.type(screen.getByRole("textbox", { name: "Your notes" }), "Entropy always increases.");
    expect(screen.getByText(/25 \/ 200,000 characters/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add to library" }));
    expect(await screen.findByRole("link", { name: "Lecture 4" })).toBeInTheDocument();
    expect(backend.calls.find((c) => c.url === "/api/notes/text")?.body).toEqual({ text: "Entropy always increases.", title: "Lecture 4" });
  });
});

/* -------------------------------------- workspace -------------------------------------- */

const NOTE = makeNote(1, { title: "Thermodynamics", chunkCount: 5 });
const paragraphSource = (key: string, chunkIndex: number, page: number | null, heading: string | null) => ({ key, chunkIndex, page, heading });

describe("workspace", () => {
  beforeEach(() => useBackend({ notes: [NOTE], chunks: { [NOTE.id]: makeChunks(5) }, mock: true }));

  it("shows info + outline, the document, and the assistant, with MOCK AI labelled when demo mode is on", async () => {
    renderNotes(`/notes/${NOTE.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Thermodynamics" })).toBeInTheDocument();
    const outline = screen.getByRole("navigation", { name: "Document outline" });
    expect(within(outline).getAllByRole("button")).toHaveLength(5);
    expect(await screen.findByRole("region", { name: "Section 1" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "AI study assistant" })).toBeInTheDocument();
    expect(await screen.findByText("MOCK AI")).toBeInTheDocument();
    for (const label of ["Explain", "Summarize", "Key concepts", "Definitions", "Formulas", "Flashcards", "Quiz me", "Important topics"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("labels a historical model result without claiming it ran locally", async () => {
    useBackend({ notes: [NOTE], chunks: { [NOTE.id]: makeChunks(5) }, mock: false });
    renderNotes(`/notes/${NOTE.id}`);
    expect(await screen.findByText("AI · llama3.2:3b")).toBeInTheDocument();
    expect(screen.queryByText("MOCK AI")).toBeNull();
  });

  it("an unknown or other-user's note shows a safe not-found message and no content", async () => {
    renderNotes(`/notes/${nid(999)}`);
    expect(await screen.findByText("This note doesn't exist or was removed.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Document" })).toBeNull();
  });

  it("a note that is still processing shows progress instead of the workspace", async () => {
    const busy = makeNote(2, { title: "Busy", status: "processing", chunkCount: 0 });
    useBackend({ notes: [busy] });
    renderNotes(`/notes/${busy.id}`);
    expect(await screen.findByText(/reading and organising this material/i)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "AI study assistant" })).toBeNull();
  });

  it("a failed note shows its reason and can be retried into the workspace", async () => {
    const failed = makeNote(2, { title: "Scan", status: "failed", error: "This PDF has no selectable text.", chunkCount: 0 });
    useBackend({ notes: [failed] });
    const { user } = renderNotes(`/notes/${failed.id}`);
    expect(await screen.findByRole("alert")).toHaveTextContent("no selectable text");
    await user.click(screen.getByRole("button", { name: "Retry processing" }));
    expect(await screen.findByRole("region", { name: "Section 1" })).toBeInTheDocument();
  });

  it("a study action sends exactly that action, streams the reply, and badges it", async () => {
    const { user } = renderNotes(`/notes/${NOTE.id}`);
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    const reply = await screen.findByRole("article", { name: "Assistant replied" });
    expect(within(reply).getByText(/Answer about: \[action:summarize\]/)).toBeInTheDocument();
    expect(within(reply).getByText("MOCK AI")).toBeInTheDocument();
    expect(backend.calls.find((c) => c.url.endsWith("/assistant"))?.body).toEqual({ action: "summarize" });
    expect(screen.getByRole("article", { name: "You asked" })).toHaveTextContent("Summarize");
  });

  it("asking a question sends it as an ask action and clears the box", async () => {
    const { user } = renderNotes(`/notes/${NOTE.id}`);
    await user.type(await screen.findByRole("textbox", { name: "Ask a question about this document" }), "What is entropy?{Enter}");
    expect(await screen.findByText("Answer about: What is entropy?")).toBeInTheDocument();
    expect(backend.calls.find((c) => c.url.endsWith("/assistant"))?.body).toEqual({ action: "ask", question: "What is entropy?" });
    expect(screen.getByRole("textbox", { name: "Ask a question about this document" })).toHaveValue("");
  });

  it("only [S#] citations that match real sources become clickable; invented ones stay plain text", async () => {
    backend.knobs.reply = { text: "Entropy rises [S1], as the notes say. Also [S9].", sources: [paragraphSource("S1", 2, 2, "Section 3")] };
    const { user } = renderNotes(`/notes/${NOTE.id}`);
    await user.click(await screen.findByRole("button", { name: "Explain" }));
    const reply = await screen.findByRole("article", { name: "Assistant replied" });
    const cite = await within(reply).findByRole("button", { name: "Source S1, page 2" });
    expect(cite).toBeInTheDocument();
    expect(within(reply).queryByRole("button", { name: /Source S9/ })).toBeNull();
    expect(reply).toHaveTextContent("[S9]"); // left as-is, not made into a link
    // the chips come from server metadata (page + heading)
    expect(within(reply).getByRole("button", { name: "Source S1, page 2, Section 3" })).toBeInTheDocument();

    await user.click(cite);
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(screen.getByRole("region", { name: "Section 3" })).toHaveClass("ring-amber-300");
  });

  it("following a citation into a far part of a long document loads that part", async () => {
    const big = makeNote(2, { title: "Textbook", chunkCount: 60 });
    useBackend({ notes: [big], chunks: { [big.id]: makeChunks(60) } });
    backend.knobs.reply = { text: "See [S1].", sources: [paragraphSource("S1", 45, 23, "Section 46")] };
    const { user } = renderNotes(`/notes/${big.id}`);
    await user.click(await screen.findByRole("button", { name: "Explain" }));
    await user.click(await screen.findByRole("button", { name: "Source S1, page 23" }));
    expect(await screen.findByRole("region", { name: "Section 46" })).toBeInTheDocument();
    expect(backend.calls.some((c) => c.url.includes("/content?cursor=43"))).toBe(true);
    expect(screen.getByRole("button", { name: "Show earlier sections" })).toBeInTheDocument();
  });

  it("the outline jumps to a section", async () => {
    const { user } = renderNotes(`/notes/${NOTE.id}`);
    const outline = await screen.findByRole("navigation", { name: "Document outline" });
    await user.click(within(outline).getByRole("button", { name: /Section 4/ }));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(screen.getByRole("region", { name: "Section 4" })).toHaveClass("ring-amber-300");
  });

  it("loads long documents in pages", async () => {
    const big = makeNote(2, { title: "Textbook", chunkCount: 45 });
    useBackend({ notes: [big], chunks: { [big.id]: makeChunks(45) } });
    const { user } = renderNotes(`/notes/${big.id}`);
    await screen.findByRole("region", { name: "Section 20" });
    expect(screen.queryByRole("region", { name: "Section 21" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByRole("region", { name: "Section 21" });
    expect(screen.queryByRole("region", { name: "Section 45" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("region", { name: "Section 45" })).toBeInTheDocument();
    expect(screen.getByText(/End of document · 45 sections/)).toBeInTheDocument();
  });

  it("shows a retryable error when the assistant fails, and Retry regenerates", async () => {
    backend.knobs.failAssistant = { status: 503, message: "The AI is unavailable right now." };
    const { user } = renderNotes(`/notes/${NOTE.id}`);
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    expect(await screen.findByText("The AI is unavailable right now.")).toBeInTheDocument();
    backend.knobs.failAssistant = null;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("article", { name: "Assistant replied" })).toBeInTheDocument();
  });

  it("Regenerate replaces the previous answer instead of stacking two", async () => {
    const { user } = renderNotes(`/notes/${NOTE.id}`);
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    await screen.findByRole("article", { name: "Assistant replied" });
    backend.knobs.reply = { text: "A second, different answer.", sources: [] };
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(await screen.findByText("A second, different answer.")).toBeInTheDocument();
    expect(screen.getAllByRole("article", { name: "Assistant replied" })).toHaveLength(1);
  });

  it("shows a neutral AI badge for a historical model answer", async () => {
    useBackend({ notes: [NOTE], chunks: { [NOTE.id]: makeChunks(5) }, mock: false });
    const { user } = renderNotes(`/notes/${NOTE.id}`);
    await user.click(await screen.findByRole("button", { name: "Summarize" }));
    const reply = await screen.findByRole("article", { name: "Assistant replied" });
    expect(within(reply).getByText("AI · llama3.2:3b")).toBeInTheDocument();
  });

  it("never renders HTML from a document as markup", async () => {
    const md = makeNote(3, { title: "Markdown", fileType: "md", chunkCount: 1 });
    useBackend({
      notes: [md],
      chunks: { [md.id]: [{ index: 0, page: null, pageEnd: null, heading: "Intro", content: "Hello <script>window.__pwned=1</script><img src=x onerror=\"window.__pwned=1\"> **bold**" }] },
    });
    renderNotes(`/notes/${md.id}`);
    await screen.findByRole("region", { name: "Intro" });
    expect(document.querySelector("script[src], img[onerror]")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
