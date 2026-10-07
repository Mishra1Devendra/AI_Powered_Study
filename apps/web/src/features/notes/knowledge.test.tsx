import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { Note } from "@copilot/shared";
import { AskAiLink, tutorPathFor } from "./AskAiLink";
import { IndexChecklist } from "./IndexChecklist";
import { NoteCard } from "./NoteCard";

/** Phase 11 on the Notes screens: honest preparation status and "Ask AI About This". */
const T = "2026-10-03T10:00:00.000Z";
const note = (over: Partial<Note> = {}): Note => ({
  id: "00000000-0000-4000-8000-0000000000d1",
  title: "Thermodynamics",
  originalFilename: "Thermodynamics.pdf",
  fileType: "pdf",
  source: "upload",
  fileSize: 120_000,
  status: "ready",
  error: null,
  pageCount: 12,
  chunkCount: 30,
  indexed: true,
  createdAt: T,
  updatedAt: T,
  lastActivityAt: T,
  ...over,
});

describe("preparation status", () => {
  it("a ready, indexed document: Uploaded, Text extracted, Indexed - and 'AI-ready'", () => {
    render(<IndexChecklist note={note()} />);
    const list = screen.getByRole("list", { name: "Document preparation" });
    for (const t of ["Uploaded", "Text extracted", "Indexed"]) expect(within(list).getByText(t)).toBeInTheDocument();
    expect(screen.getByText(/AI-ready: AI can now answer questions from this document/)).toBeInTheDocument();
  });

  it("while processing, says what is really happening and shows no percentage and no 'AI-ready'", () => {
    render(<IndexChecklist note={note({ status: "processing", indexed: false, chunkCount: 0 })} />);
    expect(screen.getByText("Preparing your study material…")).toBeInTheDocument();
    expect(screen.getByText(/Extracting text and creating the knowledge index/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByText(/AI-ready/)).toBeNull();
    expect(screen.queryByText("Text extracted")).toBeNull(); // nothing is ticked before it is true
  });

  it("while uploading, nothing after the upload is claimed", () => {
    render(<IndexChecklist note={note({ status: "uploading", indexed: false, chunkCount: 0 })} />);
    expect(screen.getByText("Uploading your file…")).toBeInTheDocument();
    expect(screen.queryByText("Indexed")).toBeNull();
  });

  it("a failed document is never shown as ready", () => {
    render(<IndexChecklist note={note({ status: "failed", indexed: false, chunkCount: 0, error: "x" })} />);
    expect(screen.getByText("We couldn't prepare this document.")).toBeInTheDocument();
    expect(screen.queryByText(/AI-ready/)).toBeNull();
  });

  it("a 'ready' document that somehow has no index is not called AI-ready", () => {
    render(<IndexChecklist note={note({ indexed: false })} />);
    expect(screen.queryByText(/AI-ready/)).toBeNull();
  });
});

function Where() {
  const l = useLocation();
  return <output aria-label="where">{`${l.pathname} ${JSON.stringify(l.state)}`}</output>;
}

describe("Ask AI About This", () => {
  it("opens the tutor with the document, without sending anything", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/notes"]}>
        <Routes>
          <Route path="/notes" element={<NoteCard note={note()} now={new Date(T)} basePath="/notes" onRetry={vi.fn()} onRemove={vi.fn()} />} />
          <Route path="/tutor" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/AI-ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Ask AI about Thermodynamics" }));
    expect(screen.getByLabelText("where")).toHaveTextContent('/tutor {"documentId":"00000000-0000-4000-8000-0000000000d1","documentTitle":"Thermodynamics"}');
  });

  it("is offered only for a document that is ready", () => {
    render(
      <MemoryRouter>
        <NoteCard note={note({ status: "processing", indexed: false, chunkCount: 0 })} now={new Date(T)} basePath="/notes" onRetry={vi.fn()} onRemove={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("link", { name: /Ask AI/ })).toBeNull();
  });

  it("stays inside the preview area when used there", () => {
    expect(tutorPathFor("/notes")).toBe("/tutor");
    expect(tutorPathFor("/dev/notes")).toBe("/dev/tutor");
    render(
      <MemoryRouter>
        <AskAiLink note={note()} basePath="/dev/notes" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Ask AI about/ })).toHaveAttribute("href", "/dev/tutor");
  });
});
