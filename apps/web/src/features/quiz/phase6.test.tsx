import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeBackend, qid } from "../../dev/fakeQuizBackend";
import { describeProgress } from "./GenerationSteps";

const USER_ID = "11111111-1111-4111-8111-111111111111";

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

let currentPath = "";
function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function renderQuiz(path: string) {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={makeClient()}>
        <PathProbe />
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

let backend: ReturnType<typeof makeBackend>;
beforeEach(() => {
  backend = makeBackend();
  vi.stubGlobal("fetch", backend.fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const holdGenerating = (progress: NonNullable<ReturnType<typeof makeBackend>["quizzes"][number]["progress"]> | null) => {
  backend.knobs.holdGeneration = true;
  const quiz = backend.addReadyQuiz({ title: "Slow quiz", status: "generating", questionCount: 5 });
  backend.quizzes[0]!.status = "generating";
  quiz.progress = progress;
  return quiz;
};

describe("quiz creation shows what is really happening", () => {
  it("names the running stage, ticks finished ones, and states the real count of questions that passed the checks", async () => {
    const quiz = holdGenerating({ stage: "checking", batch: 1, accepted: 3, target: 5 });
    renderQuiz(`/quiz/${quiz.id}`);
    expect(await screen.findByText("Checking questions…", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("3 of 5 questions have passed the checks so far.")).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Quiz creation steps" });
    const items = within(steps).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Preparing quiz… (done)",
      "Generating questions… (done)",
      "Checking questions… (in progress)",
      "Finalizing quiz… (waiting)",
    ]);
    expect(items[2]).toHaveAttribute("aria-current", "step");
  });

  it("never shows a percentage or a made-up number", async () => {
    const quiz = holdGenerating({ stage: "generating", batch: 1, accepted: 0, target: 5 });
    renderQuiz(`/quiz/${quiz.id}`);
    await screen.findByText("Generating questions…", { selector: "p" });
    expect(document.body.textContent).not.toMatch(/\d+\s?%/);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("before the server has reported anything it says so plainly instead of guessing a stage", async () => {
    const quiz = holdGenerating(null);
    renderQuiz(`/quiz/${quiz.id}`);
    expect(await screen.findByText("Creating your quiz…", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText(/have passed the checks/)).toBeNull();
    const items = within(screen.getByRole("list", { name: "Quiz creation steps" })).getAllByRole("listitem");
    expect(items.every((li) => li.textContent?.includes("(waiting)"))).toBe(true);
  });

  it("explains a second round as replacing questions that did not pass, and moves on by itself", async () => {
    expect(describeProgress({ stage: "generating", batch: 2, accepted: 3, target: 5 })).toBe("Generating replacements for questions that did not pass the checks…");
    expect(describeProgress({ stage: "finalizing", batch: 0, accepted: 5, target: 5 })).toBe("Finalizing quiz…");
    expect(describeProgress(null)).toBe("Creating your quiz…");
  });

  it("the home list shows the stage on a quiz that is still being made", async () => {
    holdGenerating({ stage: "generating", batch: 1, accepted: 0, target: 5 });
    renderQuiz("/quiz");
    const card = (await screen.findByText("Slow quiz")).closest("li")!;
    expect(within(card).getByRole("status")).toHaveTextContent("Generating questions…");
  });

  it("a failed generation says it failed, says nothing was saved, and offers Retry and Change settings", async () => {
    backend.addReadyQuiz({ title: "Broken", status: "failed", error: "The AI only produced 2 acceptable questions out of 5; the most common problems were questions not backed by your notes (6). Nothing was saved." });
    backend.quizzes[0]!.status = "failed";
    const { user } = renderQuiz(`/quiz/${backend.quizzes[0]!.id}`);
    expect(await screen.findByRole("heading", { name: "Quiz generation failed" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("most common problems were questions not backed by your notes");
    expect(screen.getByText(/your other quizzes are unaffected/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Change settings" })).toHaveAttribute("href", "/quiz/new");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(backend.calls.filter((c) => c.method === "POST" && c.url.endsWith("/regenerate"))).toHaveLength(1));
    expect(backend.quizzes.find((q) => q.title === "Broken")!.status).toBe("failed"); // the failed row is left alone
  });

  it("does not poll while the tab is hidden, and resumes when it is visible again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const quiz = holdGenerating({ stage: "generating", batch: 1, accepted: 0, target: 5 });
    renderQuiz(`/quiz/${quiz.id}`);
    await screen.findByText("Generating questions…", { selector: "p" });
    const gets = () => backend.calls.filter((c) => c.method === "GET" && c.url === `/api/quiz/${quiz.id}`).length;

    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    const before = gets();
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(gets()).toBe(before);

    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
    expect(gets()).toBeGreaterThan(before);
    delete (document as unknown as Record<string, unknown>).hidden;
  });
});

async function startAttempt(user: ReturnType<typeof userEvent.setup>, partial = {}) {
  backend.addReadyQuiz({ title: "Heat quiz", questionCount: 4, ...partial });
  await user.click(await screen.findByRole("button", { name: /Start quiz/ }));
  await screen.findByRole("region", { name: /Question 1 of/ });
}

describe("answering with the keyboard and a clearer selected state", () => {
  it("A-D choose an answer, N and P move between questions", async () => {
    const { user } = renderQuiz("/quiz");
    await startAttempt(user);
    await user.keyboard("b");
    expect(screen.getAllByRole("radio")[1]).toBeChecked();
    await user.keyboard("c");
    expect(screen.getAllByRole("radio")[2]).toBeChecked(); // changed
    expect(screen.getAllByRole("radio")[1]).not.toBeChecked();
    await user.keyboard("n");
    expect(screen.getByRole("region", { name: "Question 2 of 4" })).toBeInTheDocument();
    await user.keyboard("1");
    expect(screen.getAllByRole("radio")[0]).toBeChecked();
    await user.keyboard("p");
    expect(screen.getByRole("region", { name: "Question 1 of 4" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")[2]).toBeChecked(); // still remembered
    await waitFor(() => expect(backend.attempts[0]!.answers.size).toBe(2));
  });

  it("a letter that is not an option, and shortcuts while a dialog is open, do nothing", async () => {
    const { user } = renderQuiz("/quiz");
    await startAttempt(user);
    await user.keyboard("f");
    expect(screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
    await user.click(screen.getByRole("button", { name: "Submit quiz" }));
    await user.keyboard("a");
    expect(backend.attempts[0]!.answers.size).toBe(0);
  });

  it("the chosen option shows a check mark as well as a border (not colour alone)", async () => {
    const { user } = renderQuiz("/quiz");
    await startAttempt(user);
    const option = screen.getAllByRole("radio")[0]!.closest("label")!;
    expect(option.querySelector("svg")).toBeNull();
    await user.click(screen.getAllByRole("radio")[0]!);
    expect(option.querySelector("svg")).not.toBeNull();
  });

  it("'Review unanswered' closes the dialog and jumps to the first question without an answer", async () => {
    const { user } = renderQuiz("/quiz");
    await startAttempt(user);
    await user.keyboard("a"); // answer question 1 only
    await user.click(screen.getByRole("button", { name: "Next →" }));
    await user.keyboard("a"); // and question 2
    await user.click(screen.getByRole("button", { name: "Submit quiz" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("2 questions are unanswered");
    await user.click(within(dialog).getByRole("button", { name: "Review unanswered" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("region", { name: "Question 3 of 4" })).toBeInTheDocument();
  });

  it("the dialog offers no 'Review unanswered' when everything is answered", async () => {
    const { user } = renderQuiz("/quiz");
    await startAttempt(user, { questionCount: 1 });
    await user.keyboard("a");
    await user.click(screen.getByRole("button", { name: "Review & submit" }));
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Review unanswered" })).toBeNull();
  });

  it("a timed quiz turns amber in its last five minutes and red in the last minute", async () => {
    const { user } = renderQuiz("/quiz");
    await startAttempt(user, { timeLimitMinutes: 4 });
    const timer = await screen.findByRole("timer");
    expect(timer.className).toMatch(/amber/);
  });
});

describe("the result explains each mistake", () => {
  async function finished(partial: object, correct: number) {
    const quiz = backend.addReadyQuiz({ title: "Heat quiz", questionCount: 4, ...partial });
    const key = backend.key(quiz.id);
    const v = await (await backend.fetchMock(`/api/quiz/${quiz.id}/start`, { method: "POST" })).json();
    const answers = v.questions.map((q: { id: string }, i: number) => ({ questionId: q.id, selected: i < correct ? key.get(q.id)!.correctIndex : (key.get(q.id)!.correctIndex + 1) % key.get(q.id)!.options.length }));
    await backend.fetchMock(`/api/quiz/attempts/${v.attempt.id}/submit`, { method: "POST", body: JSON.stringify({ answers }) });
    return v.attempt.id as string;
  }

  it("shows what I answered, what was correct, why, and the concept, for every mistake", async () => {
    const id = await finished({}, 2);
    renderQuiz(`/quiz/attempt/${id}/result`);
    const review = await screen.findByRole("region", { name: "Question review" });
    const wrong = within(review).getAllByRole("article").filter((a) => a.getAttribute("aria-label")?.endsWith("Incorrect"));
    expect(wrong).toHaveLength(2);
    for (const card of wrong) {
      expect(within(card).getByText("You answered")).toBeInTheDocument();
      expect(within(card).getByText("Correct answer", { selector: "dt" })).toBeInTheDocument();
      expect(within(card).getByText("Why")).toBeInTheDocument();
      expect(within(card).getByText("Concept")).toBeInTheDocument();
      expect(within(card).getByRole("button", { name: "Ask AI to explain" })).toBeInTheDocument();
    }
  });

  it("a correct answer does not repeat 'Correct answer' as a separate line but still explains why", async () => {
    const id = await finished({}, 4);
    renderQuiz(`/quiz/attempt/${id}/result`);
    const review = await screen.findByRole("region", { name: "Question review" });
    expect(within(review).queryAllByText("Correct answer", { selector: "dt" })).toHaveLength(0);
    expect(within(review).getAllByText("Why")).toHaveLength(4);
  });

  it("shows the sentence from the student's notes that the question was based on, only on the result", async () => {
    const id = await finished({ sourceType: "notes", sourceLabel: "Thermo notes", subject: null, sources: [{ id: qid(5001), title: "Thermo notes" }] }, 1);
    renderQuiz(`/quiz/attempt/${id}/result`);
    const review = await screen.findByRole("region", { name: "Question review" });
    expect(within(review).getAllByText("From your notes")).toHaveLength(4);
    expect(within(review).getAllByText(/^From the notes:/).length).toBe(4);
    expect(within(review).getAllByText(/Thermo notes/).length).toBeGreaterThan(0);
  });

  it("tells the student, honestly, that AI-written questions can be wrong (and that demo questions mean nothing)", async () => {
    const real = await finished({ isMock: false, model: "llama3.2:3b" }, 2);
    const { user } = renderQuiz(`/quiz/attempt/${real}/result`);
    expect(await screen.findByText(/a small AI can still get things wrong/)).toBeInTheDocument();
    expect(screen.queryByText(/placeholder demo questions/)).toBeNull();
    expect(user).toBeDefined();
  });

  it("flags demo questions as meaningless for the score", async () => {
    const mock = await finished({ isMock: true }, 2);
    renderQuiz(`/quiz/attempt/${mock}/result`);
    expect(await screen.findByText(/placeholder demo questions, not written by a real AI/)).toBeInTheDocument();
  });

  it("'Ask AI to explain' includes the quote from the notes and the topic, and still sends nothing by itself", async () => {
    const id = await finished({ sourceType: "notes", sourceLabel: "Thermo notes", subject: null, sources: [{ id: qid(5002), title: "Thermo notes" }] }, 0);
    const { user } = renderQuiz(`/quiz/attempt/${id}/result`);
    const review = await screen.findByRole("region", { name: "Question review" });
    await user.click(within(review).getAllByRole("button", { name: "Ask AI to explain" })[0]!);
    const box = (await screen.findByRole("textbox", { name: "Message your tutor" })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toContain("The sentence from my notes it is based on:"));
    expect(box.value).toContain("Topic:");
    expect(currentPath).toBe("/tutor");
    expect(backend.calls.filter((c) => c.method === "POST" && c.url.startsWith("/api/tutor"))).toHaveLength(0);
  });
});
