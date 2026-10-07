import type { NoteChunk, NoteFileType } from "@copilot/shared";
import { Alert } from "../../components/ui/Alert";
import { Button } from "../../components/ui/Button";
import { Spinner } from "../../components/ui/Spinner";
import { RichText } from "../tutor/RichText";

interface Props {
  fileType: NoteFileType;
  chunks: NoteChunk[];
  first: number;
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  /** Chunk to highlight after a citation was followed. */
  highlight: number | null;
  onLoadMore: () => void;
  onLoadEarlier: () => void;
  onRetry: () => void;
}

export const chunkDomId = (index: number) => `chunk-${index}`;

/** The document's text, in sections, with page numbers and headings from the file itself. */
export function DocumentPane({ fileType, chunks, first, total, hasMore, loading, error, highlight, onLoadMore, onLoadEarlier, onRetry }: Props) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-8" id="document-scroller" tabIndex={-1}>
      <div className="mx-auto max-w-3xl">
        {first > 0 && (
          <div className="mb-4 text-center">
            <Button variant="secondary" loading={loading} onClick={onLoadEarlier}>
              Show earlier sections
            </Button>
          </div>
        )}

        {chunks.length === 0 && loading && (
          <div role="status" className="space-y-3" aria-busy="true">
            <span className="sr-only">Loading document</span>
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-100" />
            ))}
          </div>
        )}

        {chunks.map((chunk) => {
          const active = highlight === chunk.index;
          const pageLabel = chunk.page === null ? null : chunk.pageEnd && chunk.pageEnd !== chunk.page ? `pp. ${chunk.page}-${chunk.pageEnd}` : `p. ${chunk.page}`;
          return (
            <section
              key={chunk.index}
              id={chunkDomId(chunk.index)}
              aria-label={chunk.heading ?? `Section ${chunk.index + 1}`}
              className={`scroll-mt-4 rounded-xl px-3 py-3 transition-colors duration-500 ${active ? "bg-amber-50 ring-2 ring-amber-300" : ""}`}
            >
              {(chunk.heading || pageLabel) && (
                <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  {chunk.heading && <h3 className="text-base font-semibold text-slate-900">{chunk.heading}</h3>}
                  {pageLabel && <span className="text-xs font-medium text-slate-600">{pageLabel}</span>}
                </div>
              )}
              {fileType === "md" ? (
                <div className="text-[15px] leading-relaxed text-slate-800">
                  <RichText text={chunk.content} />
                </div>
              ) : (
                <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-slate-800">{chunk.content}</p>
              )}
            </section>
          );
        })}

        {error && (
          <div className="my-4 space-y-3">
            <Alert tone="error">{error}</Alert>
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}

        {chunks.length > 0 && hasMore && !error && (
          <div className="mt-4 text-center">
            <Button variant="secondary" loading={loading} onClick={onLoadMore}>
              {loading ? <Spinner className="h-4 w-4" /> : null}
              Show more
            </Button>
          </div>
        )}
        {chunks.length > 0 && !hasMore && (
          <p className="mt-6 text-center text-xs text-slate-600">End of document · {total} {total === 1 ? "section" : "sections"}</p>
        )}
      </div>
    </div>
  );
}
