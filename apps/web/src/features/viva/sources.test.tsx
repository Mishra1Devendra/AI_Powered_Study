import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthProvider";
import { makeVivaBackend } from "../../dev/fakeVivaBackend";

/** Phase 11 on the Viva screen: questions based on "My notes" or one specific document. */
const USER_ID = "11111111-1111-4111-8111-111111111111";
const DOC = { id: "00000000-0000-4000-8000-0000000000d1", title: "Thermodynamics.pdf", chunkCount: 12 };

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

function renderViva() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={["/viva"]}>
      <AuthProvider client={makeClient()}>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { user };
}

let backend: ReturnType<typeof makeVivaBackend>;
function useBackend(opts?: Parameters<typeof makeVivaBackend>[0]) {
  backend = makeVivaBackend(opts);
  vi.stubGlobal("fetch", backend.fetchMock);
}
beforeEach(() => {
  sessionStorage.clear();
  useBackend({ documents: [DOC] });
});
afterEach(() => vi.unstubAllGlobals());
const posts = () => backend.calls.filter((c) => c.method === "POST" && c.url.endsWith("/sessions"));

describe("viva sources", () => {
  it("offers General knowledge, My notes and Specific document - general is the default", async () => {
    renderViva();
    expect(await screen.findByRole("radio", { name: /General knowledge/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /My notes/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Specific document/ })).not.toBeChecked();
    expect(screen.queryByLabelText("Document")).toBeNull();
  });

  it("without any processed notes, the notes sources are explained and cannot be chosen", async () => {
    useBackend({ documents: [] });
    const { user } = renderViva();
    const mine = await screen.findByRole("radio", { name: /My notes/ });
    await user.click(mine);
    expect(screen.getByRole("radio", { name: /General knowledge/ })).toBeChecked();
    expect(screen.getAllByText("Upload notes first").length).toBeGreaterThan(0);
  });

  it("a viva from 'My notes' names the source and shows 'Based on: your notes' without revealing any key points", async () => {
    const { user } = renderViva();
    await user.click(await screen.findByRole("radio", { name: /My notes/ }));
    await user.type(screen.getByLabelText("Subject"), "Physics");
    await user.click(screen.getByRole("button", { name: "Start Viva" }));
    expect(await screen.findByText("Question 1 of 5", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(posts()[0]!.body).toEqual({ subject: "Physics", difficulty: "medium", questionCount: 5, sourceType: "notes" });
    expect(screen.getByText("Based on: your notes")).toBeInTheDocument();
    expect(screen.queryByText(/Activation energy/)).toBeNull();
  });

  it("a viva on one document sends its id, needs a choice, and shows 'Based on: <document>'", async () => {
    const { user } = renderViva();
    await user.click(await screen.findByRole("radio", { name: /Specific document/ }));
    await user.click(screen.getByRole("button", { name: "Start Viva" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Choose a document/);
    expect(posts()).toHaveLength(0);

    await user.selectOptions(screen.getByLabelText("Document"), DOC.id);
    await user.click(screen.getByRole("button", { name: "Start Viva" })); // no subject typed: the document's name is used
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ subject: "Thermodynamics.pdf", difficulty: "medium", questionCount: 5, sourceType: "document", documentId: DOC.id });
    expect(await screen.findByText("Based on: Thermodynamics.pdf", {}, { timeout: 3000 })).toBeInTheDocument();
  });

  it("when nothing relevant is in the material, the student gets a plain explanation and can fix the form", async () => {
    const { user } = renderViva();
    await user.click(await screen.findByRole("radio", { name: /My notes/ }));
    await user.type(screen.getByLabelText("Subject"), "Roman history");
    // armed after the page has loaded its options, so only the start request fails
    backend.knobs.failNext = { status: 422, message: "I couldn't find relevant information in this material.", error: "no_material" };
    await user.click(screen.getByRole("button", { name: "Start Viva" }));
    expect(await screen.findByText("I couldn't find relevant information in this material.")).toBeInTheDocument();
    expect(screen.getByLabelText("Subject")).toHaveValue("Roman history"); // nothing the student typed is lost
  });
});
