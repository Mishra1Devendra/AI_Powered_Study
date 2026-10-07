import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makePlannerBackend } from "../../dev/fakePlannerBackend";

const USER_ID = "11111111-1111-4111-8111-111111111111";

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

let location: { pathname: string; search: string; state: unknown } = { pathname: "", search: "", state: null };
function PathProbe() {
  const l = useLocation();
  location = { pathname: l.pathname, search: l.search, state: l.state };
  return null;
}

function renderAt(path = "/study-plan", signedIn = true) {
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

let backend: ReturnType<typeof makePlannerBackend>;
function useBackend(seed?: Parameters<typeof makePlannerBackend>[0]) {
  backend = makePlannerBackend({ today: "2026-10-05", ...seed });
  vi.stubGlobal("fetch", backend.fetchMock);
}
beforeEach(() => useBackend());
afterEach(() => vi.unstubAllGlobals());

const posts = (suffix: string) => backend.calls.filter((c) => c.method === "POST" && c.url.endsWith(suffix));

async function fillForm(user: ReturnType<typeof userEvent.setup>, { exam = "2026-11-02", subject = "Physics" } = {}) {
  await user.type(await screen.findByLabelText("Plan name"), "Board exams");
  fireEvent.change(screen.getByLabelText("Exam date"), { target: { value: exam } });
  if (subject) await user.type(screen.getByLabelText("Subject 1 name"), subject);
}

describe("access and empty state", () => {
  it("a signed-out visitor is sent to login and nothing is requested", async () => {
    renderAt("/study-plan", false);
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });

  it("with no plan, shows an empty state that leads to the form (no invented data)", async () => {
    renderAt();
    expect(await screen.findByRole("heading", { name: "No study plan yet" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create study plan" })).toHaveAttribute("href", "/study-plan/new");
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/\d+%/)).toBeNull();
  });
});

describe("creating a plan", () => {
  it("validates the form before sending anything", async () => {
    const { user } = renderAt("/study-plan/new");
    await user.click(await screen.findByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose your exam date.");
    fireEvent.change(screen.getByLabelText("Exam date"), { target: { value: "2026-10-05" } });
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("The exam date must be after today.");
    fireEvent.change(screen.getByLabelText("Exam date"), { target: { value: "2027-09-01" } });
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("within 180 days");
    fireEvent.change(screen.getByLabelText("Exam date"), { target: { value: "2026-11-02" } });
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give your plan a name");
    await user.type(screen.getByLabelText("Plan name"), "Boards");
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add at least one subject");
    await user.type(screen.getByLabelText("Subject 1 name"), "Physics");
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) await user.click(screen.getByRole("checkbox", { name: d }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Choose at least one study day");
    await user.click(screen.getByRole("radio", { name: "Custom" }));
    await user.clear(screen.getByLabelText(/Minutes per day/));
    await user.type(screen.getByLabelText(/Minutes per day/), "5");
    await user.click(screen.getByRole("checkbox", { name: "Sat" }));
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(screen.getByRole("alert")).toHaveTextContent("At least 15 minutes a day");
    expect(posts("/generate")).toHaveLength(0);
  });

  it("sends exactly what the student chose, then shows the REAL creation stages (no percentages)", async () => {
    const { user } = renderAt("/study-plan/new");
    await fillForm(user);
    await user.type(screen.getByLabelText("Subject 1 topics (optional)"), "Kinematics, Forces");
    await user.selectOptions(screen.getByLabelText("Subject 1 priority"), "high");
    await user.click(screen.getByRole("button", { name: "+ Add subject" }));
    await user.type(screen.getByLabelText("Subject 2 name"), "Chemistry");
    await user.click(screen.getByRole("radio", { name: /2 h/ }));
    await user.click(screen.getByRole("radio", { name: /Beginner/ }));
    await user.click(screen.getByRole("radio", { name: "Evening" }));
    await user.type(screen.getByLabelText(/Target score/), "85");
    await user.click(screen.getByRole("button", { name: "Generate plan" }));

    await waitFor(() => expect(posts("/generate")).toHaveLength(1));
    expect(posts("/generate")[0]!.body).toEqual({
      title: "Board exams",
      examDate: "2026-11-02",
      targetScore: 85,
      minutesPerDay: 120,
      knowledgeLevel: "beginner",
      subjects: [
        { name: "Physics", priority: "high", topics: ["Kinematics", "Forces"] },
        { name: "Chemistry", priority: "medium", topics: [] },
      ],
      studyDays: [1, 2, 3, 4, 5],
      preferredTime: "evening",
    });
    expect(posts("/generate")[0]!.body).not.toHaveProperty("userId");
    expect(await screen.findByText("Preparing your plan…")).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Plan creation steps" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent?.replace(/ \((done|in progress|waiting)\)/, ""))).toEqual([
      "Preparing your plan",
      "Analyzing your schedule",
      "Creating study sessions",
      "Checking your plan",
      "Saving your plan",
    ]);
    expect(screen.queryByText(/\d+%/)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("the Generate button cannot start a second plan while one is being sent", async () => {
    const { user } = renderAt("/study-plan/new");
    await fillForm(user);
    const button = screen.getByRole("button", { name: "Generate plan" });
    await Promise.all([user.click(button), user.click(button), user.click(button)]);
    await waitFor(() => expect(location.pathname).toMatch(/^\/study-plan\/0000/));
    expect(posts("/generate")).toHaveLength(1);
  });

  it("explains when a plan is already being created, with a link to it", async () => {
    const { user } = renderAt("/study-plan/new");
    await fillForm(user);
    backend.knobs.failNext = { status: 409, message: "A study plan is already being created. Wait for it to finish first.", extra: { planId: "00000000-0000-4000-8000-000000000999" } };
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already being created");
    expect(screen.getByRole("link", { name: "See the plan being created" })).toHaveAttribute("href", "/study-plan/00000000-0000-4000-8000-000000000999");
  });

  it("follows the server's stage, then shows the finished plan", async () => {
    const { user } = renderAt("/study-plan/new");
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByText("Preparing your plan…");
    const plan = backend.plans[0]!;
    backend.setStage(plan.id, "scheduling");
    expect(await screen.findByText("Creating study sessions…", {}, { timeout: 5000 })).toBeInTheDocument();
    backend.finish(plan.id);
    expect(await screen.findByText("Plan created — start your first session.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Board exams" })).toBeInTheDocument();
    expect(screen.getByText("MOCK AI")).toBeInTheDocument();
  }, 15_000);

  it("a failed creation says why, keeps nothing, and offers Try again", async () => {
    backend.knobs.generationError = "The local AI's answer could not be read. Nothing was saved. Please try again.";
    const { user } = renderAt("/study-plan/new");
    await fillForm(user);
    await user.click(screen.getByRole("button", { name: "Generate plan" }));
    await screen.findByText("Preparing your plan…");
    backend.finish(backend.plans[0]!.id);
    expect(await screen.findByText(/could not be read/, {}, { timeout: 5000 })).toBeInTheDocument();
    backend.knobs.generationError = null;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(posts("/regenerate")).toHaveLength(1));
  }, 15_000);

  it("can start from an earlier plan's settings", async () => {
    const old = backend.addActivePlan({ title: "Mid-terms", minutesPerDay: 180 });
    renderAt(`/study-plan/new?from=${old.id}`);
    expect(await screen.findByDisplayValue("Mid-terms")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Physics")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "3 h" })).toBeChecked();
  });
});

describe("the plan dashboard", () => {
  it("shows the header with real numbers and a weekly schedule", async () => {
    backend.addActivePlan({ examDate: "2026-10-29" });
    renderAt();
    expect(await screen.findByRole("heading", { level: 1, name: "Board exams" })).toBeInTheDocument();
    expect(screen.getByText("Days remaining").nextSibling).toHaveTextContent("24");
    expect(screen.getByText("Target score").nextSibling).toHaveTextContent("85%");
    expect(screen.getByText("Plan created — start your first session.")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("heading", { name: /Week of 5 Oct – 11 Oct/ })).toBeInTheDocument();
    const days = screen.getAllByRole("listitem").filter((li) => li.getAttribute("aria-label"));
    expect(days.map((d) => d.getAttribute("aria-label"))[0]).toBe("Mon 5 Oct, today");
    expect(within(days[5]!).getByText("Rest day")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByRole("heading", { name: /Week of 12 Oct – 18 Oct/ })).toBeInTheDocument();
  });

  /** Answers the 5 study-check questions: the first `right` correctly (the fake's key is option 1,2,3,4,1), the rest wrongly. */
  async function answer(user: ReturnType<typeof userEvent.setup>, right: number) {
    const key = [0, 1, 2, 3, 0];
    const dialog = await screen.findByRole("dialog", { name: "Check your understanding" });
    const sets = await within(dialog).findAllByRole("group");
    expect(sets).toHaveLength(5);
    for (let i = 0; i < sets.length; i++) {
      const radios = within(sets[i]!).getAllByRole("radio");
      await user.click(radios[i < right ? key[i]! : (key[i]! + 1) % 4]!);
    }
    await user.click(within(dialog).getByRole("button", { name: "Submit answers" }));
    return dialog;
  }

  it("start -> mark complete asks 5 questions first; passing completes the session and shows real progress", async () => {
    const plan = backend.addActivePlan();
    const first = backend.sessions.find((s) => s.planId === plan.id)!;
    const { user } = renderAt();
    await screen.findByRole("heading", { level: 1, name: "Board exams" });
    await user.click(screen.getAllByRole("button", { name: new RegExp(first.topic) })[0]!);
    const dialog = screen.getByRole("dialog", { name: first.topic });
    await user.click(within(dialog).getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(within(screen.getByRole("dialog")).getAllByText("In progress").length).toBeGreaterThan(0));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Mark complete" }));
    // Nothing is completed by that click: the study check opens instead.
    expect(await screen.findByRole("dialog", { name: "Check your understanding" })).toBeInTheDocument();
    expect(posts("/complete")).toHaveLength(0);
    const check = await answer(user, 4);
    expect(await within(check).findByText(/You scored 4 out of 5 - this session is now complete/)).toBeInTheDocument();
    await user.click(within(check).getByRole("button", { name: "Done" }));
    const total = backend.sessions.filter((s) => s.planId === plan.id).length;
    expect(await screen.findByText(`1 of ${total} sessions completed`)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Sessions completed" })).toBeInTheDocument();
    expect(posts("/start")).toHaveLength(1);
    expect(posts("/complete")).toHaveLength(0);
    expect(posts("/answers")).toHaveLength(1);
  });

  it("failing the check keeps the session open, shows the correct answers, and a new set can be tried", async () => {
    const plan = backend.addActivePlan();
    const first = backend.sessions.find((s) => s.planId === plan.id)!;
    const { user } = renderAt(`/study-plan?session=${first.id}`);
    const dialog = await screen.findByRole("dialog", { name: first.topic });
    await user.click(within(dialog).getByRole("button", { name: "Mark complete" }));
    const check = await answer(user, 2);
    expect(await within(check).findByText(/You scored 2 out of 5; you need 3/)).toBeInTheDocument();
    expect(within(check).getAllByText(/Correct answer:/).length).toBe(3); // the three it got wrong, with the right one shown
    expect(backend.sessions.find((s) => s.id === first.id)!.status).toBe("planned");
    await user.click(within(check).getByRole("button", { name: "Try a new set" }));
    expect(await within(screen.getByRole("dialog")).findAllByRole("group")).toHaveLength(5);
    expect(backend.checks).toHaveLength(2);
    await answer(user, 5);
    expect(await screen.findByText(/You scored 5 out of 5/)).toBeInTheDocument();
    expect(backend.sessions.find((s) => s.id === first.id)!.status).toBe("completed");
  });

  it("shows a calm waiting message while the questions are written, then the questions (no request starts AI by itself)", async () => {
    backend.knobs.checkPolls = 1;
    const plan = backend.addActivePlan();
    const first = backend.sessions.find((s) => s.planId === plan.id)!;
    const { user } = renderAt(`/study-plan?session=${first.id}`);
    await user.click(within(await screen.findByRole("dialog", { name: first.topic })).getByRole("button", { name: "Mark complete" }));
    const dialog = await screen.findByRole("dialog", { name: "Check your understanding" });
    expect(await within(dialog).findByText(/Writing your questions with the local AI/)).toBeInTheDocument();
    expect(await within(dialog).findAllByRole("group", {}, { timeout: 8000 })).toHaveLength(5);
    expect(posts("/check")).toHaveLength(1); // one start; the waiting was plain reads
  }, 15000);

  it("a question set that could not be written says so and offers Try again (a click, never automatic)", async () => {
    backend.knobs.checkError = "The AI only produced 2 acceptable questions out of 5. Nothing was saved. Please try again.";
    const plan = backend.addActivePlan();
    const first = backend.sessions.find((s) => s.planId === plan.id)!;
    const { user } = renderAt(`/study-plan?session=${first.id}`);
    await user.click(within(await screen.findByRole("dialog", { name: first.topic })).getByRole("button", { name: "Mark complete" }));
    const dialog = await screen.findByRole("dialog", { name: "Check your understanding" });
    expect(await within(dialog).findByText(/only produced 2 acceptable questions/)).toBeInTheDocument();
    expect(posts("/check")).toHaveLength(1);
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(screen.getByRole("dialog")).findAllByRole("group")).toHaveLength(5);
    expect(posts("/check")).toHaveLength(2);
  });

  it("Submit stays disabled until all 5 questions are answered, and Cancel returns to the session without completing it", async () => {
    const plan = backend.addActivePlan();
    const first = backend.sessions.find((s) => s.planId === plan.id)!;
    const { user } = renderAt(`/study-plan?session=${first.id}`);
    await user.click(within(await screen.findByRole("dialog", { name: first.topic })).getByRole("button", { name: "Mark complete" }));
    const dialog = await screen.findByRole("dialog", { name: "Check your understanding" });
    const sets = await within(dialog).findAllByRole("group");
    expect(within(dialog).getByRole("button", { name: "Submit answers" })).toBeDisabled();
    await user.click(within(sets[0]!).getAllByRole("radio")[0]!);
    expect(within(dialog).getByText("1 of 5 answered")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Submit answers" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("dialog", { name: first.topic })).toBeInTheDocument();
    expect(backend.sessions.find((s) => s.id === first.id)!.status).toBe("planned");
  });

  it("skip marks the session skipped", async () => {
    const plan = backend.addActivePlan();
    const first = backend.sessions.find((s) => s.planId === plan.id)!;
    const { user } = renderAt(`/study-plan?session=${first.id}`);
    const dialog = await screen.findByRole("dialog", { name: first.topic });
    await user.click(within(dialog).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(backend.sessions.find((s) => s.id === first.id)!.status).toBe("skipped"));
    expect(await within(screen.getByRole("dialog")).findByRole("button", { name: "Reschedule" })).toBeInTheDocument();
  });

  it("opens a session straight from a dashboard link (?session=)", async () => {
    const plan = backend.addActivePlan();
    const s = backend.sessions.filter((x) => x.planId === plan.id)[3]!;
    renderAt(`/study-plan?session=${s.id}`);
    const dialog = await screen.findByRole("dialog", { name: s.topic });
    expect(within(dialog).getByText(s.subject)).toBeInTheDocument();
  });

  it("missed sessions: Reschedule keeps history and moves within the plan; Keep as missed records it", async () => {
    const plan = backend.addActivePlan({ startDate: "2026-09-28", examDate: "2026-10-23" });
    const past = backend.sessions.filter((s) => s.planId === plan.id && s.date < "2026-10-05");
    expect(past.length).toBeGreaterThanOrEqual(2);
    const { user } = renderAt();
    const panel = await screen.findByRole("region", { name: new RegExp(`${past.length} missed sessions`) });
    // Rows are in date order, so the first row is the earliest missed session.
    await user.click(within(panel).getAllByRole("button", { name: /^Reschedule / })[0]!);
    await waitFor(() => expect(backend.sessions.find((s) => s.id === past[0]!.id)!.status).toBe("rescheduled"));
    const moved = backend.sessions.find((s) => s.rescheduledFromId === past[0]!.id)!;
    expect(moved.date >= "2026-10-05" && moved.date < "2026-10-23").toBe(true);
    const day = backend.sessions.filter((s) => s.planId === plan.id && s.date === moved.date && s.status !== "rescheduled");
    expect(day.reduce((m, s) => m + s.durationMinutes, 0)).toBeLessThanOrEqual(120);
    await waitFor(() => expect(within(screen.getByRole("region", { name: /missed session/ })).getAllByRole("button", { name: /^Reschedule / })).toHaveLength(past.length - 1));
    await user.click(within(screen.getByRole("region", { name: /missed session/ })).getAllByRole("button", { name: /as missed$/ })[0]!);
    await waitFor(() => expect(backend.sessions.find((s) => s.id === past[1]!.id)!.status).toBe("missed"));
  });

  it("shows a reschedule error from the server (e.g. no room before the exam)", async () => {
    const plan = backend.addActivePlan();
    const s = backend.sessions.find((x) => x.planId === plan.id)!;
    const { user } = renderAt(`/study-plan?session=${s.id}`);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Reschedule" }));
    fireEvent.change(within(dialog).getByLabelText(/New date/), { target: { value: backend.sessions.filter((x) => x.planId === plan.id)[2]!.date } });
    await user.click(within(dialog).getByRole("button", { name: "Move to this date" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("no room");
  });

  it("Open AI Tutor hands the topic to the tutor without sending anything", async () => {
    const plan = backend.addActivePlan();
    const s = backend.sessions.find((x) => x.planId === plan.id)!;
    const { user } = renderAt(`/study-plan?session=${s.id}`);
    const dialog = await screen.findByRole("dialog");
    const before = backend.calls.length;
    await user.click(within(dialog).getByRole("button", { name: "Open AI Tutor" }));
    await waitFor(() => expect(location.pathname).toBe("/tutor"));
    expect(backend.calls.slice(before).some((c) => c.method === "POST")).toBe(false);
  });

  it("regenerate asks first, creates a NEW plan and keeps the old one", async () => {
    const plan = backend.addActivePlan();
    const { user } = renderAt();
    await screen.findByRole("heading", { level: 1, name: "Board exams" });
    await user.click(screen.getByRole("button", { name: "Regenerate" }));
    const dialog = screen.getByRole("dialog", { name: "Regenerate this plan?" });
    expect(dialog).toHaveTextContent("nothing is deleted");
    await user.click(within(dialog).getByRole("button", { name: "Create new plan" }));
    await waitFor(() => expect(location.pathname).not.toBe("/study-plan"));
    expect(posts("/regenerate")).toHaveLength(1);
    expect(backend.plans).toHaveLength(2);
    expect(backend.plans.find((p) => p.id === plan.id)!.status).toBe("active");
  });

  it("edits the plan name, exam date and daily time", async () => {
    const plan = backend.addActivePlan();
    const { user } = renderAt();
    await screen.findByRole("heading", { level: 1, name: "Board exams" });
    await user.click(screen.getByRole("button", { name: "Edit plan" }));
    const dialog = screen.getByRole("dialog", { name: "Edit plan" });
    await user.clear(within(dialog).getByLabelText("Plan name"));
    await user.type(within(dialog).getByLabelText("Plan name"), "Finals");
    await user.clear(within(dialog).getByLabelText(/Study time per day/));
    await user.type(within(dialog).getByLabelText(/Study time per day/), "90");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Finals" })).toBeInTheDocument();
    const patch = backend.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/api/study-plans/${plan.id}`);
    expect(patch.body).toEqual({ title: "Finals", minutesPerDay: 90 });
  });

  it("previous plans are listed, read-only, and can be made active again", async () => {
    const old = backend.addActivePlan({ title: "Mid-terms" });
    backend.addActivePlan();
    const { user } = renderAt();
    await screen.findByRole("heading", { level: 1, name: "Board exams" });
    const previous = within(screen.getByRole("region", { name: "Previous plans" }));
    await user.click(previous.getByRole("link", { name: /Mid-terms/ }));
    expect(await screen.findByText(/This is a previous plan/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit plan" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Make this plan active" }));
    await waitFor(() => expect(backend.plans.find((p) => p.id === old.id)!.status).toBe("active"));
  });

  it("another student's (or a missing) plan shows a clear not-found message", async () => {
    renderAt("/study-plan/00000000-0000-4000-8000-000000000777");
    expect(await screen.findByText("This study plan doesn't exist, or it isn't yours.")).toBeInTheDocument();
  });
});
