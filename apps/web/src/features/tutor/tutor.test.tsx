import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@copilot/shared";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeBackend, uid, type Call } from "../../dev/fakeTutorBackend";

const USER_ID = "11111111-1111-4111-8111-111111111111";

/* ------------------------------------ rendering ------------------------------------ */

function makeClient(signedIn = true) {
  let session = signedIn ? ({ access_token: "tok", user: { id: USER_ID, email: "r@example.com" } } as unknown as Session) : null;
  let listener: ((event: string, s: Session | null) => void) | null = null;
  const signOut = vi.fn(async () => {
    session = null;
    listener?.("SIGNED_OUT", null);
    return { error: null };
  });
  const client = {
    auth: {
      getSession: vi.fn(async () => ({ data: { session } })),
      onAuthStateChange: vi.fn((cb: typeof listener) => {
        listener = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signOut,
    },
  } as unknown as SupabaseClient;
  return { client, signOut };
}

let currentPath = "";
function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function renderTutor(path = "/tutor", signedIn = true) {
  const { client, signOut } = makeClient(signedIn);
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client}>
        <PathProbe />
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user, signOut };
}

const composer = () => screen.getByRole("textbox", { name: "Message your tutor" });
const sendButton = () => screen.getByRole("button", { name: "Send" });
const post = (calls: Call[], suffix: string) => calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));

function conv(n: number, extra: Partial<Conversation> = {}): Conversation {
  const t = new Date(Date.UTC(2026, 9, 3, 10, n)).toISOString();
  return { id: uid(n), title: `Conversation ${n}`, subject: null, topic: null, level: null, createdAt: t, updatedAt: t, ...extra };
}

let backend: ReturnType<typeof makeBackend>;
function useBackend(seed?: Parameters<typeof makeBackend>[0]) {
  backend = makeBackend(seed);
  vi.stubGlobal("fetch", backend.fetchMock);
}

beforeEach(() => useBackend());
afterEach(() => vi.unstubAllGlobals());

/* -------------------------------------- tests -------------------------------------- */

describe("access", () => {
  it("a signed-in student can open /tutor", async () => {
    renderTutor();
    expect(await screen.findByRole("heading", { level: 1, name: "AI Tutor" })).toBeInTheDocument();
    expect(composer()).toBeInTheDocument();
  });

  it("a signed-out visitor is redirected to login and nothing is requested", async () => {
    renderTutor("/tutor", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });
});

describe("first visit", () => {
  it("shows the empty state with starters that fill the composer and save nothing", async () => {
    const { user } = renderTutor();
    expect(await screen.findByRole("heading", { name: "What are you studying today?" })).toBeInTheDocument();
    for (const label of ["Explain a difficult topic", "Help me solve a problem", "Prepare me for an exam", "Test my understanding", "Explain this in simple language"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: "Prepare me for an exam" }));
    expect(composer()).toHaveValue("Help me prepare for my exam on ");
    expect(post(backend.calls, "/api/tutor/conversations")).toHaveLength(0); // no fake/empty conversation created
    expect(backend.conversations).toHaveLength(0);
  });

  it("flags demo mode when the server uses the mock provider", async () => {
    renderTutor();
    expect(await screen.findByText("Demo AI (mock)")).toBeInTheDocument();
  });
});

describe("sending messages", () => {
  it("Enter sends: creates the conversation, shows the student's message, streams and shows the reply, updates the URL and history", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "What is entropy?{Enter}");

    expect(await screen.findByText("Answer to: What is entropy?")).toBeInTheDocument();
    expect(within(screen.getByRole("log")).getByText("What is entropy?")).toBeInTheDocument();
    expect(composer()).toHaveValue("");
    await waitFor(() => expect(currentPath).toBe(`/tutor/${backend.conversations[0]!.id}`));
    // history list shows the new conversation (desktop sidebar renders in jsdom)
    expect(within(screen.getByRole("navigation", { name: "Conversation history" })).getByText("What is entropy?")).toBeInTheDocument();
    // create first, then message
    expect(backend.calls.filter((c) => c.method === "POST").map((c) => c.url.split("/").pop())).toEqual(["conversations", "messages"]);
    expect(post(backend.calls, "/messages")[0]!.body).toEqual({ content: "What is entropy?" });
  });

  it("Shift+Enter adds a new line instead of sending", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "line one{Shift>}{Enter}{/Shift}line two");
    expect(composer()).toHaveValue("line one\nline two");
    expect(post(backend.calls, "/messages")).toHaveLength(0);
  });

  it("does not send empty or whitespace-only messages", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "   {Enter}");
    expect(sendButton()).toBeDisabled();
    expect(backend.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("blocks over-long messages client-side with a clear counter", async () => {
    const { user } = renderTutor();
    const box = await screen.findByRole("textbox", { name: "Message your tutor" });
    await user.click(box);
    await user.paste("x".repeat(4001));
    expect(screen.getByText(/Too long: 4001\/4000/)).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(backend.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("shows a typing indicator, a Stop button and a disabled composer action while the tutor is answering", async () => {
    backend.knobs.holdNext = true;
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "Hello{Enter}");

    expect(await screen.findByText("The tutor is typing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    for (const b of within(screen.getByRole("group", { name: "Tutoring modes" })).getAllByRole("button")) expect(b).toBeDisabled();

    backend.knobs.hold!.push({ type: "delta", text: "Streaming " });
    backend.knobs.hold!.push({ type: "delta", text: "**now**" });
    expect(await screen.findByText(/Streaming/)).toBeInTheDocument();
    expect(screen.queryByText("The tutor is typing")).not.toBeInTheDocument();
    backend.knobs.hold!.close();
    // closing without a `done` event is surfaced, not silently ignored
    expect(await screen.findByRole("alert")).toHaveTextContent(/connection ended/i);
  });

  it("Stop ends the reply, keeps the student's message and offers Retry", async () => {
    backend.knobs.holdNext = true;
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "Explain gravity{Enter}");
    await screen.findByText("The tutor is typing");
    await user.click(screen.getByRole("button", { name: "Stop" }));

    const status = await screen.findByText("Response stopped.");
    expect(status).toBeInTheDocument();
    expect(within(screen.getByRole("log")).getByText("Explain gravity")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message your tutor" })).toBeEnabled(); // composer is usable again
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Answer to: Explain gravity")).toBeInTheDocument();
    expect(post(backend.calls, "/regenerate")).toHaveLength(1);
    expect(post(backend.calls, "/messages")).toHaveLength(1); // the question was not sent twice
  });
});

describe("tutoring modes", () => {
  it("with nothing typed and no context yet, a mode arms for the next message and is sent with it", async () => {
    const { user } = renderTutor();
    await user.click(await screen.findByRole("button", { name: "Test me" }));
    expect(screen.getByRole("button", { name: "Test me", pressed: true })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Mode: Test me")).toBeInTheDocument();
    expect(backend.calls.filter((c) => c.method === "POST")).toHaveLength(0);

    await user.type(composer(), "photosynthesis{Enter}");
    await screen.findByText("Answer to: photosynthesis");
    expect(post(backend.calls, "/messages")[0]!.body).toEqual({ content: "photosynthesis", mode: "test_me" });
    expect(screen.queryByText("Mode: Test me")).not.toBeInTheDocument(); // one-shot
  });

  it("a mode with typed text acts on that text immediately (e.g. Find my mistake)", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "2+2=5, so 4=5");
    await user.click(screen.getByRole("button", { name: "Find my mistake" }));
    await screen.findByText("Answer to: 2+2=5, so 4=5");
    expect(post(backend.calls, "/messages")[0]!.body).toEqual({ content: "2+2=5, so 4=5", mode: "find_mistake" });
    expect(within(screen.getByRole("log")).getByText("Find my mistake")).toBeInTheDocument(); // mode label on the message
  });

  it("with an ongoing conversation, a mode acts immediately using a sensible default request", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "What is entropy?{Enter}");
    await screen.findByText("Answer to: What is entropy?");

    await user.click(screen.getByRole("button", { name: "Explain simply" }));
    await screen.findByText("Answer to: Please explain that again, more simply.");
    expect(post(backend.calls, "/messages")[1]!.body).toEqual({ content: "Please explain that again, more simply.", mode: "explain_simply" });
  });

  it("clicking an armed mode again turns it off", async () => {
    const { user } = renderTutor();
    const btn = await screen.findByRole("button", { name: "Give me a hint" });
    await user.click(btn);
    await user.click(screen.getByRole("button", { name: "Give me a hint", pressed: true }));
    expect(screen.queryByText("Mode: Give me a hint")).not.toBeInTheDocument();
  });
});

describe("subject / topic / level context", () => {
  it("is optional; chosen context on a new chat is sent when the conversation is created", async () => {
    const { user } = renderTutor();
    await user.click(await screen.findByRole("button", { name: /Add a subject, topic or level/ }));
    await user.type(screen.getByLabelText("Subject"), "Physics");
    await user.type(screen.getByLabelText("Topic"), "Thermodynamics");
    await user.selectOptions(screen.getByLabelText("Level"), "intermediate");
    await user.click(screen.getByRole("button", { name: "Save context" }));
    expect(backend.calls.filter((c) => c.method === "POST")).toHaveLength(0); // nothing created yet
    expect(screen.getByText(/Physics · Thermodynamics · Intermediate/)).toBeInTheDocument();

    await user.type(composer(), "What is entropy?{Enter}");
    await screen.findByText("Answer to: What is entropy?");
    expect(post(backend.calls, "/conversations")[0]!.body).toEqual({ subject: "Physics", topic: "Thermodynamics", level: "intermediate" });
  });

  it("on an existing conversation, saving context updates it on the server", async () => {
    useBackend({ conversations: [conv(1, { subject: "Maths" })], messages: { [uid(1)]: [] } });
    const { user } = renderTutor(`/tutor/${uid(1)}`);
    await user.click(await screen.findByRole("button", { name: /Context: Maths/ }));
    await user.type(screen.getByLabelText("Topic"), "Integration");
    await user.click(screen.getByRole("button", { name: "Save context" }));
    await waitFor(() => expect(backend.calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(backend.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ subject: "Maths", topic: "Integration", level: null });
    expect(await screen.findByRole("button", { name: /Context: Maths · Integration/ })).toBeInTheDocument();
  });
});

describe("conversations and history", () => {
  it("loads a saved conversation from the URL and shows its history correctly, in order, after a reload", async () => {
    const c = conv(1, { title: "Entropy basics", subject: "Physics" });
    const mk = backend.mk;
    useBackend({
      conversations: [c],
      messages: { [c.id]: [mk(c.id, "user", "What is entropy?", { mode: "explain_simply" }), mk(c.id, "assistant", "A measure of **disorder**."), mk(c.id, "user", "Give an example"), mk(c.id, "assistant", "Ice melting.")] },
    });
    renderTutor(`/tutor/${c.id}`);
    const log = await screen.findByRole("log", { name: "Conversation" });
    await within(log).findByText("Ice melting.");
    const articles = within(log).getAllByRole("article");
    expect(articles.map((a) => a.getAttribute("aria-label"))).toEqual(["You said", "Tutor replied", "You said", "Tutor replied"]);
    expect(within(log).getByText("disorder").tagName).toBe("STRONG"); // Markdown rendered
    expect(screen.getByRole("heading", { level: 1, name: "Entropy basics" })).toBeInTheDocument();
    expect(within(log).getByText("Explain simply")).toBeInTheDocument();
  });

  it("multiple conversations are independent: switching shows each one's own messages", async () => {
    const [c1, c2] = [conv(1, { title: "Alpha topic" }), conv(2, { title: "Beta topic" })];
    const mk = backend.mk;
    useBackend({
      conversations: [c1, c2],
      messages: {
        [c1.id]: [mk(c1.id, "user", "alpha question"), mk(c1.id, "assistant", "alpha answer")],
        [c2.id]: [mk(c2.id, "user", "beta question"), mk(c2.id, "assistant", "beta answer")],
      },
    });
    const { user } = renderTutor(`/tutor/${c1.id}`);
    await screen.findByText("alpha answer");
    await user.click(within(screen.getByRole("navigation", { name: "Conversation history" })).getByRole("link", { name: /Beta topic/ }));
    await screen.findByText("beta answer");
    expect(screen.queryByText("alpha answer")).not.toBeInTheDocument();
    expect(currentPath).toBe(`/tutor/${c2.id}`);
  });

  it("does not refetch the conversation list for every message", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "one{Enter}");
    await screen.findByText("Answer to: one");
    await user.type(composer(), "two{Enter}");
    await screen.findByText("Answer to: two");
    expect(backend.calls.filter((c) => c.method === "GET" && c.url === "/api/tutor/conversations")).toHaveLength(1);
    // and the conversation we just created is not re-downloaded
    expect(backend.calls.filter((c) => c.method === "GET" && /conversations\/[^/]+$/.test(c.url))).toHaveLength(0);
  });

  it("New conversation returns to a blank tutor and clears the composer", async () => {
    const c = conv(1);
    const mk = backend.mk;
    useBackend({ conversations: [c], messages: { [c.id]: [mk(c.id, "user", "hi"), mk(c.id, "assistant", "hello there")] } });
    const { user } = renderTutor(`/tutor/${c.id}`);
    await screen.findByText("hello there");
    await user.type(composer(), "draft text");
    await user.click(screen.getAllByRole("button", { name: /New conversation/ })[0]!);
    expect(await screen.findByRole("heading", { name: "What are you studying today?" })).toBeInTheDocument();
    expect(currentPath).toBe("/tutor");
    expect(screen.queryByText("hello there")).not.toBeInTheDocument();
  });

  it("deleting a conversation asks first, then removes it from the list", async () => {
    const [c1, c2] = [conv(1, { title: "Keep me" }), conv(2, { title: "Delete me" })];
    useBackend({ conversations: [c1, c2], messages: {} });
    const { user } = renderTutor();
    const nav = await screen.findByRole("navigation", { name: "Conversation history" });
    await within(nav).findByText("Delete me");
    await user.click(within(nav).getByRole("button", { name: "Delete conversation: Delete me" }));
    expect(within(nav).getByText("Delete this conversation?")).toBeInTheDocument();
    expect(backend.calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(nav).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(within(nav).queryByText("Delete me")).not.toBeInTheDocument());
    expect(within(nav).getByText("Keep me")).toBeInTheDocument();
    expect(backend.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("shows a helpful message for a conversation that does not exist", async () => {
    renderTutor(`/tutor/${uid(999)}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(/doesn't exist or was deleted/);
    expect(screen.getByRole("button", { name: "Start a new conversation" })).toBeInTheDocument();
  });
});

describe("errors, retry, regenerate and copy", () => {
  it("shows a provider error from the stream with Retry; Retry answers the same saved message", async () => {
    let first = true;
    backend.knobs.reply = () => {
      if (!first) return null;
      first = false;
      return [{ type: "error", code: "unavailable", message: "The AI service is temporarily unavailable.", retryable: true }];
    };
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "Help me{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("The AI service is temporarily unavailable.");
    expect(within(screen.getByRole("log")).getByText("Help me")).toBeInTheDocument(); // not lost

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Answer to: Help me")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(post(backend.calls, "/messages")).toHaveLength(1);
    expect(post(backend.calls, "/regenerate")).toHaveLength(1);
  });

  it("a non-retryable error offers no Retry button", async () => {
    backend.knobs.reply = () => [{ type: "error", code: "refused", message: "The AI declined to answer this request.", retryable: false }];
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "x{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("declined");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("surfaces server rejections (429 / 500) before streaming with the server's safe message", async () => {
    backend.knobs.failWith = { status: 429, message: "Too many requests. Please slow down and try again shortly." };
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "hi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a network failure shows a connection error and Retry re-sends the message that never arrived", async () => {
    const { user } = renderTutor();
    const box = await screen.findByRole("textbox", { name: "Message your tutor" });
    // conversation creation works, then the network drops for the message itself
    backend.knobs.networkDown = true;
    await user.type(box, "are you there?{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach the server/);
    backend.knobs.networkDown = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Answer to: are you there?")).toBeInTheDocument();
    // exactly one visible copy of the student's message
    expect(within(screen.getByRole("log")).getAllByText("are you there?")).toHaveLength(1);
  });

  it("an expired session (401) tells the student to sign in again", async () => {
    backend.knobs.failWith = { status: 401, message: "Sign in to continue." };
    const { user, signOut } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "hi{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Your session has expired. Please sign in again.");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(signOut).toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
  });

  it("Copy puts the tutor's reply on the clipboard and confirms", async () => {
    const c = conv(1);
    const mk = backend.mk;
    useBackend({ conversations: [c], messages: { [c.id]: [mk(c.id, "user", "q"), mk(c.id, "assistant", "Copy this **answer**")] } });
    const { user } = renderTutor(`/tutor/${c.id}`);
    await screen.findByText("answer");
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe("Copy this **answer**");
  });

  it("Regenerate is offered only on the latest reply, and replaces it with a fresh one", async () => {
    const c = conv(1);
    const mk = backend.mk;
    useBackend({
      conversations: [c],
      messages: { [c.id]: [mk(c.id, "user", "first"), mk(c.id, "assistant", "reply one"), mk(c.id, "user", "second"), mk(c.id, "assistant", "reply two")] },
    });
    const { user } = renderTutor(`/tutor/${c.id}`);
    await screen.findByText("reply two");
    expect(screen.getAllByRole("button", { name: "Regenerate" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    await screen.findByText("Answer to: second");
    expect(screen.queryByText("reply two")).not.toBeInTheDocument(); // superseded, not shown twice
    expect(screen.getByText("reply one")).toBeInTheDocument();
    expect(post(backend.calls, "/regenerate")).toHaveLength(1);
    expect(post(backend.calls, "/messages")).toHaveLength(0);
  });

  it("labels demo (mock) replies so they are never mistaken for real AI", async () => {
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "hi{Enter}");
    expect(await screen.findByText(/Demo response - not from a real AI model/)).toBeInTheDocument();
  });

  it("does not show the demo label when the server uses the real provider", async () => {
    useBackend({ mock: false });
    const { user } = renderTutor();
    await user.type(await screen.findByRole("textbox", { name: "Message your tutor" }), "hi{Enter}");
    await screen.findByText("Answer to: hi");
    expect(screen.queryByText(/Demo response/)).not.toBeInTheDocument();
    expect(screen.queryByText("Demo AI (mock)")).not.toBeInTheDocument();
  });
});

describe("markdown rendering is safe and useful", () => {
  async function renderReply(markdown: string) {
    const c = conv(1);
    const mk = backend.mk;
    useBackend({ conversations: [c], messages: { [c.id]: [mk(c.id, "user", "q"), mk(c.id, "assistant", markdown)] } });
    renderTutor(`/tutor/${c.id}`);
    await screen.findByRole("log", { name: "Conversation" });
    return within(screen.getByRole("log"));
  }

  it("renders lists, code blocks and math", async () => {
    const log = await renderReply("1. Step one\n2. Step two\n\n```python\nprint('hi')\n```\n\nEnergy: $E = mc^2$");
    expect(await log.findByText("Step two")).toBeInTheDocument();
    expect(log.getByText("print('hi')").closest("pre")).not.toBeNull();
    await waitFor(() => expect(document.querySelector(".katex")).not.toBeNull());
  });

  it("never renders raw HTML or script from a reply", async () => {
    const log = await renderReply('Hello <img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> <b>bold-html</b>');
    await log.findByText(/Hello/);
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector(".tutor-prose b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("drops unsafe link schemes and opens safe links safely", async () => {
    const log = await renderReply("[bad](javascript:alert(1)) and [good](https://example.com/page)");
    await log.findByText("good");
    expect(log.getByText("bad").closest("a")?.getAttribute("href") ?? "").not.toMatch(/javascript:/i);
    const good = log.getByRole("link", { name: "good" });
    expect(good).toHaveAttribute("href", "https://example.com/page");
    expect(good).toHaveAttribute("target", "_blank");
    expect(good.getAttribute("rel")).toContain("noopener");
  });
});
