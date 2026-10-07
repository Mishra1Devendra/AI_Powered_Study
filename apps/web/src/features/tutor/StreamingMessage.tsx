import { RichText } from "./RichText";
import { TutorAvatar } from "./MessageItem";

/** The reply being written right now. Shows a typing indicator until the first token arrives. */
export function StreamingMessage({ text }: { text: string }) {
  return (
    <article aria-label="Tutor is replying" aria-busy="true" className="flex gap-3">
      <TutorAvatar className="mt-0.5 h-8 w-8" />
      <div className="min-w-0 flex-1 text-[15px] leading-relaxed text-slate-800">
        {text === "" ? (
          <div role="status" className="flex h-8 items-center gap-1.5">
            <span className="sr-only">The tutor is typing</span>
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                aria-hidden="true"
                className="h-2 w-2 animate-pulse rounded-full bg-slate-400"
                style={{ animationDelay: `${i * 160}ms` }}
              />
            ))}
          </div>
        ) : (
          <RichText text={text} />
        )}
      </div>
    </article>
  );
}
