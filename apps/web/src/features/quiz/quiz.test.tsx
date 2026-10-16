import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeBackend, qid } from "../../dev/fakeQuizBackend";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const NOTE = { id: qid(7001), title: "Thermodynamics notes", chunkCount: 12, pageCount: 8 };

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

function renderQuiz(path = "/quiz", signedIn = true) {
  const user = userEvent.setup();
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
}
beforeEach(() => useBackend());
afterEach(() => vi.unstubAllGlobals());

const posts = (suffix: string) => backend.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));
/** Picks an option of the question currently shown, by its text. */
const pick = async (user: ReturnType<typeof userEvent.setup>, text: string) => user.click(screen.getByRole("radio", { name: new RegExp(text) }));
const currentQuestion = () => screen.getByRole("group").querySelector("legend")?.textContent ?? "";

/* ------------------------------------------------ home ------------------------------------------------ */

describe("access", () => {
  it("a signed-in student can open /quiz and the sidebar no longer marks Quiz as upcoming", async () => {
    renderQuiz();
    expect(await screen.findByRole("heading", { level: 1, name: "Quiz" })).toBeInTheDocument();
  });

  it("a signed-out visitor is redirected to login and nothing is requested", async () => {
    renderQuiz("/quiz", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });
});

describe("quiz home", () => {
  it("first visit: a proper empty state, with no made-up numbers or history", async () => {
    renderQuiz();
    expect(await screen.findByText("Turn your notes into practice questions.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create your first quiz" })).toHaveAttribute("href", "/quiz/new");
    expect(screen.queryByText("Your performance")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("shows an error with Try again, and recovers", async () => {
    backend.knobs.networkDown = true;
    const { user } = renderQuiz();
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
    backend.knobs.networkDown = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Turn your notes into practice questions.")).toBeInTheDocument();
  });

  it("lists quizzes with source, size, difficulty and status; failed ones explain why and offer a retry", async () => {
    useBackend();
    backend.addReadyQuiz({ title: "Heat quiz", sourceLabel: "Physics · Heat", questionCount: 5, difficulty: "hard" });
    backend.addReadyQuiz({ title: "Broken quiz", status: "failed", error: "The AI only produced 2 usable questions out of 5. Nothing was saved." });
    backend.quizzes.find((q) => q.title === "Broken quiz")!.status = "failed";
    renderQuiz();
    const ready = (await screen.findByRole("link", { name: "Heat quiz" })).closest("li")!;
    expect(within(ready).getByText(/Physics · Heat · 5 questions · Hard/)).toBeInTheDocument();
    expect(within(ready).getByText("Ready")).toBeInTheDocument();
    expect(within(ready).getByText("MOCK AI")).toBeInTheDocument(); // demo questions are labelled
    expect(within(ready).getByRole("button", { name: "Start quiz" })).toBeInTheDocument();

    const failed = screen.getByRole("link", { name: "Broken quiz" }).closest("li")!;
    expect(within(failed).getByRole("alert")).toHaveTextContent("Nothing was saved");
    expect(within(failed).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(within(failed).queryByRole("button", { name: /Start/ })).toBeNull();
  });

  it("labels historical model results without claiming they ran locally", async () => {
    useBackend({ mock: false });
    backend.addReadyQuiz({ title: "Real quiz", isMock: false, model: "llama3.2:3b" });
    renderQuiz();
    expect(await screen.findByText("AI · llama3.2:3b")).toBeInTheDocument();
    expect(screen.queryByText("MOCK AI")).toBeNull();
  });

  it("Start opens the attempt; a quiz in progress is offered for resume", async () => {
    const quiz = backend.addReadyQuiz({ title: "Heat quiz" });
    const { user } = renderQuiz();
    await user.click(await screen.findByRole("button", { name: "Start quiz" }));
    await waitFor(() => expect(currentPath).toMatch(/^\/quiz\/attempt\//));
    expect(posts(`/${quiz.id}/start`)).toHaveLength(1);
  });

  it("shows the resume banner for an unfinished attempt", async () => {
    const quiz = backend.addReadyQuiz({ title: "Heat quiz" });
    await backend.fetchMock(`/api/quiz/${quiz.id}/start`, { method: "POST" });
    renderQuiz();
    const banner = await screen.findByRole("region", { name: "Quiz in progress" });
    expect(banner).toHaveTextContent("Heat quiz");
    expect(within(banner).getByRole("link", { name: "Resume" })).toHaveAttribute("href", expect.stringMatching(/^\/quiz\/attempt\//));
  });

  it("a quiz still being created shows progress (not a fake percentage) and flips to ready by itself", async () => {
    backend.knobs.holdGeneration = true;
    const quiz = backend.addReadyQuiz({ title: "Slow quiz", status: "generating" });
    backend.quizzes[0]!.status = "generating";
    renderQuiz();
    const card = (await screen.findByText("Slow quiz")).closest("li")!;
    expect(within(card).getByText("Creating")).toBeInTheDocument();
    expect(within(card).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    backend.knobs.holdGeneration = false;
    backend.finish(quiz.id);
    await waitFor(() => expect(within(card).getByText("Ready")).toBeInTheDocument(), { timeout: 9000 });
  }, 16000);

  it("shows real performance numbers from finished attempts, and a history tab", async () => {
    const quiz = backend.addReadyQuiz({ title: "Heat quiz", questionCount: 4 });
    const key = backend.key(quiz.id);
    const start = await (await backend.fetchMock(`/api/quiz/${quiz.id}/start`, { method: "POST" })).json();
    const answers = start.questions.slice(0, 3).map((q: { id: string }) => ({ questionId: q.id, selected: key.get(q.id)!.correctIndex }));
    await backend.fetchMock(`/api/quiz/attempts/${start.attempt.id}/submit`, { method: "POST", body: JSON.stringify({ answers }) });
    const { user } = renderQuiz();
    const perf = await screen.findByRole("region", { name: "Your quiz performance" });
    expect(within(perf).getAllByText("75%")).toHaveLength(2); // average and best
    expect(within(perf).getAllByText("1").length).toBeGreaterThan(0); // quizzes taken
    expect(within(perf).getByText("By topic")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "History" }));
    const row = (await screen.findByRole("link", { name: /Heat quiz/ })).closest("li")!;
    expect(row).toHaveTextContent("3/4 · 75%");
    expect(within(row).getByRole("link")).toHaveAttribute("href", `/quiz/attempt/${start.attempt.id}/result`);
  });
});

/* ----------------------------------------------- creating ----------------------------------------------- */

describe("creating a quiz", () => {
  it("only offers sources the student really has: no notes -> My notes is disabled and explained", async () => {
    renderQuiz("/quiz/new");
    expect(await screen.findByRole("heading", { name: "Create a quiz" })).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /My notes/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Specific document/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /General knowledge/ })).toBeChecked();
    expect(screen.getByRole("link", { name: "Upload notes" })).toHaveAttribute("href", "/notes");
    expect(screen.getByLabelText("Subject")).toBeInTheDocument();
  });

  it("lists the student's ready notes and builds a notes-quiz request", async () => {
    useBackend({ notes: [NOTE] });
    const { user } = renderQuiz("/quiz/new");
    await user.click(await screen.findByRole("checkbox", { name: /Thermodynamics notes/ }));
    await user.type(screen.getByLabelText(/Focus on/), "entropy");
    await user.click(screen.getByRole("radio", { name: "Hard" }));
    await user.click(screen.getByRole("radio", { name: "10 questions" }));
    await user.click(screen.getByRole("checkbox", { name: /True \/ False/ }));
    await user.selectOptions(screen.getByLabelText("Timer"), "20");
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    await waitFor(() => expect(posts("/api/quiz/generate")).toHaveLength(1));
    expect(posts("/api/quiz/generate")[0]!.body).toEqual({
      source: { type: "notes", documentIds: [NOTE.id], focus: "entropy" },
      difficulty: "hard",
      count: 10,
      questionTypes: ["mcq", "true_false"],
      timeLimitMinutes: 20,
    });
    await waitFor(() => expect(currentPath).toMatch(/^\/quiz\/0000/));
  });

  it("My notes: 'Use all my notes' selects them; Specific document sends exactly one; General knowledge sends no document", async () => {
    useBackend({ notes: [NOTE] });
    const { user } = renderQuiz("/quiz/new");
    await user.click(await screen.findByRole("button", { name: "Use all my notes" }));
    expect(screen.getByRole("checkbox", { name: /Thermodynamics notes/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    await waitFor(() => expect(posts("/api/quiz/generate")).toHaveLength(1));
    expect(posts("/api/quiz/generate")[0]!.body).toMatchObject({ source: { type: "notes", documentIds: [NOTE.id] } });
  });

  it("Specific document: choose one document, and the request names only it", async () => {
    useBackend({ notes: [NOTE] });
    const { user } = renderQuiz("/quiz/new");
    await user.click(await screen.findByRole("radio", { name: /Specific document/ }));
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose a document.");
    expect(posts("/api/quiz/generate")).toHaveLength(0);
    await user.selectOptions(screen.getByLabelText("Document"), NOTE.id);
    expect(screen.getByText("Every question comes from this document only.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    await waitFor(() => expect(posts("/api/quiz/generate")).toHaveLength(1));
    expect(posts("/api/quiz/generate")[0]!.body).toMatchObject({ source: { type: "notes", documentIds: [NOTE.id] } });
  });

  it("builds a subject/topic request, with suggestions from the tutor filling the fields", async () => {
    useBackend({ topics: [{ subject: "Physics", topic: "Thermodynamics" }] });
    const { user } = renderQuiz("/quiz/new");
    await user.click(await screen.findByRole("button", { name: "Physics · Thermodynamics" }));
    expect(screen.getByLabelText("Subject")).toHaveValue("Physics");
    expect(screen.getByLabelText(/Topic/)).toHaveValue("Thermodynamics");
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    await waitFor(() => expect(posts("/api/quiz/generate")).toHaveLength(1));
    expect(posts("/api/quiz/generate")[0]!.body).toEqual({ source: { type: "topic", subject: "Physics", topic: "Thermodynamics" }, difficulty: "medium", count: 5, questionTypes: ["mcq"], timeLimitMinutes: null });
  });

  it("validates before sending anything", async () => {
    const { user } = renderQuiz("/quiz/new");
    await user.click(await screen.findByRole("button", { name: "Generate quiz" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a subject.");
    await user.type(screen.getByLabelText("Subject"), "Physics");
    await user.click(screen.getByRole("checkbox", { name: /Multiple choice/ })); // untick the only type
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Choose at least one question type.");
    expect(posts("/api/quiz/generate")).toHaveLength(0);
  });

  it("question types that are not supported yet are visible but disabled", async () => {
    renderQuiz("/quiz/new");
    expect(await screen.findByRole("checkbox", { name: /Short answer/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Numerical/ })).toBeDisabled();
  });

  it("tells the student, with a link, when another quiz is already being created", async () => {
    backend.knobs.holdGeneration = true;
    const busy = backend.addReadyQuiz({ title: "Busy", status: "generating" });
    backend.quizzes[0]!.status = "generating";
    const { user } = renderQuiz("/quiz/new");
    await user.type(await screen.findByLabelText("Subject"), "Physics");
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already being created");
    expect(screen.getByRole("link", { name: "See the quiz being created" })).toHaveAttribute("href", `/quiz/${busy.id}`);
  });

  it("discloses Google processing and free-tier content terms before quiz generation", async () => {
    renderQuiz("/quiz/new");
    expect(await screen.findByText(/quiz prompts and relevant note passages are sent to Google Gemini/i)).toBeInTheDocument();
    expect(screen.getByText(/may be used to improve products and may be reviewed by humans/i)).toBeInTheDocument();
    expect(screen.getByText(/free-tier eligibility is unverified/i)).toBeInTheDocument();
  });

  it("after generating, the quiz page shows progress and then becomes startable on its own", async () => {
    backend.knobs.holdGeneration = true;
    const { user } = renderQuiz("/quiz/new");
    await user.type(await screen.findByLabelText("Subject"), "Physics");
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    expect(await screen.findByText("Creating your quiz…")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Quiz creation steps" })).toBeInTheDocument();
    backend.knobs.holdGeneration = false;
    backend.finish(backend.quizzes[0]!.id);
    expect(await screen.findByRole("button", { name: "Start quiz" }, { timeout: 6000 })).toBeInTheDocument();
  }, 12000);

  it("a failed generation is explained, and Try again starts a new one", async () => {
    backend.knobs.failGenerationWith = "The AI only produced 3 usable questions out of 5. Nothing was saved.";
    const { user } = renderQuiz("/quiz/new");
    await user.type(await screen.findByLabelText("Subject"), "Physics");
    await user.click(screen.getByRole("button", { name: "Generate quiz" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Nothing was saved");
    backend.knobs.failGenerationWith = null;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(posts("/regenerate")).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Start quiz" })).toBeInTheDocument();
  });
});

/* ----------------------------------------------- quiz detail ----------------------------------------------- */

describe("quiz page", () => {
  it("unknown quiz -> a safe not-found message", async () => {
    renderQuiz(`/quiz/${qid(9999)}`);
    expect(await screen.findByText("This quiz doesn't exist or was removed.")).toBeInTheDocument();
  });

  it("after an attempt: attempts are listed, and Retry reuses the questions while New questions makes a fresh quiz", async () => {
    const quiz = backend.addReadyQuiz({ title: "Heat quiz" });
    const first = await (await backend.fetchMock(`/api/quiz/${quiz.id}/start`, { method: "POST" })).json();
    await backend.fetchMock(`/api/quiz/attempts/${first.attempt.id}/submit`, { method: "POST", body: JSON.stringify({ answers: [] }) });
    const { user } = renderQuiz(`/quiz/${quiz.id}`);
    expect(await screen.findByText("Your attempts")).toBeInTheDocument();
    expect(screen.getByText("0/4 · 0%")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New questions" }));
    await waitFor(() => expect(posts("/regenerate")).toHaveLength(1));
    await waitFor(() => expect(currentPath).not.toBe(`/quiz/${quiz.id}`));
    expect(backend.quizzes).toHaveLength(2);
  });
});

/* ------------------------------------------------ taking ------------------------------------------------ */

async function startFirstQuiz(user: ReturnType<typeof userEvent.setup>, quizPartial: Parameters<typeof backend.addReadyQuiz>[0] = {}) {
  const quiz = backend.addReadyQuiz({ title: "Heat quiz", questionCount: 4, ...quizPartial });
  await user.click(await screen.findByRole("button", { name: /Start quiz/ }));
  await screen.findByRole("region", { name: /Question 1 of/ });
  return quiz;
}

describe("answering", () => {
  it("shows one question at a time with progress, and nothing that reveals the answer", async () => {
    const { user } = renderQuiz();
    const quiz = await startFirstQuiz(user);
    expect(screen.getByText("0 of 4 answered")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Question 1 of 4" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    expect(screen.getByText("Not answered yet")).toBeInTheDocument();
    // The page - and every payload the server sent for it - holds no answer key.
    const explanations = [...backend.key(quiz.id).values()].map((q) => q.explanation);
    for (const e of explanations) expect(document.body.textContent).not.toContain(e);
    expect(screen.queryByText(/correct answer/i)).toBeNull();
    const attemptCalls = backend.calls.filter((c) => /\/api\/quiz\/attempts\//.test(c.url) || c.url.endsWith("/start"));
    expect(attemptCalls.length).toBeGreaterThan(0);
  });

  it("saves choices as you go, keeps them when you move between questions, and shows what is answered", async () => {
    const { user } = renderQuiz();
    await startFirstQuiz(user);
    const q1 = currentQuestion();
    await pick(user, "The first law");
    expect(screen.getByText("1 of 4 answered")).toBeInTheDocument();
    await waitFor(() => expect(backend.calls.some((c) => c.method === "PUT")).toBe(true));
    expect(await screen.findByText("All answers saved")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next →" }));
    expect(screen.getByRole("region", { name: "Question 2 of 4" })).toBeInTheDocument();
    expect(currentQuestion()).not.toBe(q1);
    expect(screen.getByText("Not answered yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "← Previous" }));
    expect(currentQuestion()).toBe(q1);
    expect(screen.getByRole("radio", { name: /The first law/ })).toBeChecked(); // still selected

    const nav = screen.getByRole("navigation", { name: "Question navigator" });
    expect(within(nav).getByRole("button", { name: "Question 1, answered, current" })).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Question 2, not answered" })).toBeInTheDocument();
    await user.click(within(nav).getByRole("button", { name: "Question 4, not answered" }));
    expect(screen.getByRole("region", { name: "Question 4 of 4" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review & submit" })).toBeInTheDocument(); // last question
  });

  it("lets you change or clear an answer", async () => {
    const { user } = renderQuiz();
    await startFirstQuiz(user);
    await pick(user, "The first law");
    await pick(user, "The second law");
    expect(screen.getByRole("radio", { name: /The second law/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /The first law/ })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Clear my answer" }));
    expect(screen.getByText("0 of 4 answered")).toBeInTheDocument();
    await waitFor(() => expect(backend.attempts[0]!.answers.size).toBe(0));
  });

  it("answers survive a reload (they were saved on the server)", async () => {
    const { user } = renderQuiz();
    const quiz = await startFirstQuiz(user);
    await pick(user, "The first law");
    await waitFor(() => expect(backend.attempts[0]!.answers.size).toBe(1));
    const attemptPath = currentPath;
    document.body.innerHTML = "";
    renderQuiz(attemptPath);
    expect(await screen.findByText("1 of 4 answered")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /The first law/ })).toBeChecked();
    expect(quiz.id).toBeTruthy();
  });

  it("warns when saving fails and lets you retry; the answer is not lost", async () => {
    backend.knobs.failSave = true;
    const { user } = renderQuiz();
    await startFirstQuiz(user);
    await pick(user, "The first law");
    expect(await screen.findByText(/Couldn't save your latest answer/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /The first law/ })).toBeChecked();
    backend.knobs.failSave = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("All answers saved")).toBeInTheDocument();
    expect(backend.attempts[0]!.answers.size).toBe(1);
  });
});

describe("submitting", () => {
  it("asks for confirmation, says how many are unanswered, and can be cancelled without losing anything", async () => {
    const { user } = renderQuiz();
    await startFirstQuiz(user);
    await pick(user, "The first law");
    await user.click(screen.getByRole("button", { name: "Submit quiz" }));
    const dialog = screen.getByRole("dialog", { name: "Submit your quiz?" });
    expect(dialog).toHaveTextContent("answered 1 of 4 questions");
    expect(dialog).toHaveTextContent("3 questions are unanswered and will count as incorrect");
    expect(within(dialog).getByRole("button", { name: "Keep working" })).toHaveFocus(); // the safe choice has focus
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("radio", { name: /The first law/ })).toBeChecked();
    expect(posts("/submit")).toHaveLength(0);
  });

  it("submits once, the SERVER scores it, and the result page shows score, counts, topics and the full review", async () => {
    const { user } = renderQuiz();
    const quiz = await startFirstQuiz(user);
    const key = backend.key(quiz.id);
    // Answer the first question correctly, the second wrongly, leave two blank.
    const q1 = [...key.values()].find((q) => q.text === currentQuestion())!;
    await user.click(screen.getByRole("radio", { name: new RegExp(q1.options[q1.correctIndex]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }));
    await user.click(screen.getByRole("button", { name: "Next →" }));
    const q2 = [...key.values()].find((q) => q.text === currentQuestion())!;
    const wrong = q2.options.findIndex((_, i) => i !== q2.correctIndex);
    await user.click(screen.getAllByRole("radio")[wrong]!);

    await user.click(screen.getByRole("button", { name: "Submit quiz" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit quiz" }));
    await waitFor(() => expect(currentPath).toMatch(/\/result$/));

    expect(posts("/submit")).toHaveLength(1);
    // The score came from the server: the submit body only carried choices.
    expect(Object.keys(posts("/submit")[0]!.body!).sort()).toEqual(["answers"]);
    expect(await screen.findByText("25%")).toBeInTheDocument();
    const stats = screen.getByRole("region", { name: "Your score" });
    expect(stats).toHaveTextContent("1 / 4");
    expect(within(stats).getByText("Correct").nextSibling).toHaveTextContent("1");
    expect(within(stats).getByText("Incorrect").nextSibling).toHaveTextContent("1");
    expect(within(stats).getByText("Unanswered").nextSibling).toHaveTextContent("2");
    expect(screen.getByRole("region", { name: "Performance by topic" })).toBeInTheDocument();
    // No second request was needed to fetch the result.
    expect(backend.calls.filter((c) => c.url.endsWith("/result"))).toHaveLength(0);

    const review = screen.getByRole("region", { name: "Question review" });
    expect(within(review).getAllByRole("article")).toHaveLength(4);
    expect(within(review).getAllByText("Why")).toHaveLength(4);
    expect(within(review).getAllByText("Your answer")).toHaveLength(2);
    expect(within(review).getAllByText("Correct answer").length).toBeGreaterThanOrEqual(4);
    await user.click(within(review).getByRole("button", { name: "Mistakes (3)" }));
    expect(within(review).getAllByRole("article")).toHaveLength(3);
    expect(within(review).getAllByText("Skipped", { selector: "span" })).toHaveLength(2);
  });

  it("a double click on Submit sends exactly one request", async () => {
    backend.knobs.submitDelayMs = 150;
    const { user } = renderQuiz();
    await startFirstQuiz(user);
    await user.click(screen.getByRole("button", { name: "Submit quiz" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Submit quiz" });
    await user.dblClick(confirm);
    await waitFor(() => expect(currentPath).toMatch(/\/result$/));
    expect(posts("/submit")).toHaveLength(1);
  });

  it("a network failure on submit keeps the dialog open with the error and lets you try again", async () => {
    backend.knobs.failSubmitOnce = { status: 503, message: "Could not grade right now." };
    const { user } = renderQuiz();
    await startFirstQuiz(user);
    await pick(user, "The first law");
    await user.click(screen.getByRole("button", { name: "Submit quiz" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Submit quiz" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Could not grade right now.");
    expect(currentPath).toMatch(/^\/quiz\/attempt\/[^/]+$/);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(currentPath).toMatch(/\/result$/));
    expect(backend.attempts[0]!.answers.size).toBe(1); // the choice was still there
  });

  it("opening an attempt that is already finished goes straight to its result", async () => {
    const quiz = backend.addReadyQuiz({ title: "Heat quiz" });
    const v = await (await backend.fetchMock(`/api/quiz/${quiz.id}/start`, { method: "POST" })).json();
    await backend.fetchMock(`/api/quiz/attempts/${v.attempt.id}/submit`, { method: "POST", body: JSON.stringify({ answers: [] }) });
    renderQuiz(`/quiz/attempt/${v.attempt.id}`);
    await waitFor(() => expect(currentPath).toBe(`/quiz/attempt/${v.attempt.id}/result`));
    expect(await screen.findByRole("region", { name: "Your score" })).toBeInTheDocument();
  });

  it("a timed quiz shows the server-based countdown; when time has run out the result says so", async () => {
    const { user } = renderQuiz();
    const quiz = await startFirstQuiz(user, { timeLimitMinutes: 10 });
    expect(await screen.findByRole("timer")).toHaveAccessibleName(/Time remaining 09:5\d|Time remaining 10:00/);
    // The server closes the attempt when the deadline passes; the page then shows the outcome.
    backend.knobs.expireNow = true;
    document.body.innerHTML = "";
    renderQuiz(currentPath);
    await waitFor(() => expect(currentPath).toMatch(/\/result$/));
    expect(await screen.findByText("Time ran out. Your saved answers were submitted.")).toBeInTheDocument();
    expect(quiz.timeLimitMinutes).toBe(10);
  });

  it("an unknown attempt id shows a safe message", async () => {
    renderQuiz(`/quiz/attempt/${qid(9998)}`);
    expect(await screen.findByText("This quiz attempt doesn't exist.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to quizzes" })).toBeInTheDocument();
  });

  it("the result of an unsubmitted attempt is not shown; the student is sent back to the quiz", async () => {
    const quiz = backend.addReadyQuiz({ title: "Heat quiz" });
    const v = await (await backend.fetchMock(`/api/quiz/${quiz.id}/start`, { method: "POST" })).json();
    renderQuiz(`/quiz/attempt/${v.attempt.id}/result`);
    expect(await screen.findByText("Submit the quiz to see your results.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue the quiz" })).toHaveAttribute("href", `/quiz/attempt/${v.attempt.id}`);
  });
});

/* ------------------------------------------------ results ------------------------------------------------ */

async function finishedAttempt(correct: number) {
  const quiz = backend.addReadyQuiz({ title: "Heat quiz", questionCount: 4 });
  const key = backend.key(quiz.id);
  const v = await (await backend.fetchMock(`/api/quiz/${quiz.id}/start`, { method: "POST" })).json();
  const answers = v.questions.map((q: { id: string }, i: number) => ({ questionId: q.id, selected: i < correct ? key.get(q.id)!.correctIndex : (key.get(q.id)!.correctIndex + 1) % key.get(q.id)!.options.length }));
  await backend.fetchMock(`/api/quiz/attempts/${v.attempt.id}/submit`, { method: "POST", body: JSON.stringify({ answers }) });
  return { quiz, attemptId: v.attempt.id as string };
}

describe("results", () => {
  it("a perfect score has nothing to review", async () => {
    const { attemptId } = await finishedAttempt(4);
    const { user } = renderQuiz(`/quiz/attempt/${attemptId}/result`);
    expect((await screen.findAllByText("100%")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Strong").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Mistakes (0)" }));
    expect(screen.getByText(/No mistakes to review/)).toBeInTheDocument();
  });

  it("'Ask AI to explain' opens the existing AI Tutor with the question ready to send (and sends nothing itself)", async () => {
    const { attemptId } = await finishedAttempt(2);
    const { user } = renderQuiz(`/quiz/attempt/${attemptId}/result`);
    const review = await screen.findByRole("region", { name: "Question review" });
    await user.click(within(review).getByRole("button", { name: "Mistakes (2)" }));
    const buttons = within(review).getAllByRole("button", { name: "Ask AI to explain" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]!);
    await waitFor(() => expect(currentPath).toBe("/tutor"));
    const box = await screen.findByRole("textbox", { name: "Message your tutor" });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toContain("I got this quiz question wrong"));
    const text = (box as HTMLTextAreaElement).value;
    expect(text).toContain("My answer:");
    expect(text).toContain("Correct answer:");
    expect(text).toContain("The quiz's explanation:");
    expect(backend.calls.filter((c) => c.method === "POST" && c.url.startsWith("/api/tutor"))).toHaveLength(0); // not sent for them
  });

  it("Retry quiz starts a NEW attempt in a different order and keeps the old result", async () => {
    const { quiz, attemptId } = await finishedAttempt(1);
    const { user } = renderQuiz(`/quiz/attempt/${attemptId}/result`);
    await user.click(await screen.findByRole("button", { name: "Retry quiz" }));
    await waitFor(() => expect(currentPath).toMatch(/^\/quiz\/attempt\/[^/]+$/));
    expect(currentPath).not.toContain(attemptId);
    expect(posts(`/${quiz.id}/retry`)).toHaveLength(1);
    expect(backend.attempts).toHaveLength(2);
    expect(backend.attempts.find((a) => a.id === attemptId)!.status).toBe("submitted");
  });

  it("New questions creates a separate quiz", async () => {
    const { attemptId } = await finishedAttempt(1);
    const { user } = renderQuiz(`/quiz/attempt/${attemptId}/result`);
    await user.click(await screen.findByRole("button", { name: "New questions" }));
    await waitFor(() => expect(backend.quizzes).toHaveLength(2));
    await waitFor(() => expect(currentPath).toMatch(/^\/quiz\/0000/));
  });

  it("a result that cannot be loaded offers Try again", async () => {
    const { attemptId } = await finishedAttempt(1);
    backend.knobs.networkDown = true;
    const { user } = renderQuiz(`/quiz/attempt/${attemptId}/result`);
    expect(await screen.findByText(/Could not reach the server/)).toBeInTheDocument();
    backend.knobs.networkDown = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("region", { name: "Your score" })).toBeInTheDocument();
  });
});
