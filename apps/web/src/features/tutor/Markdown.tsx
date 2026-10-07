import "katex/dist/katex.min.css";
import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { SourceRef } from "@copilot/shared";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

/**
 * Renders the tutor's Markdown (with LaTeX math). Raw HTML in the source is NOT rendered
 * (react-markdown escapes it), and unsafe URL schemes such as `javascript:` are dropped by its
 * default URL sanitiser, so a model or a pasted message cannot inject script or markup.
 */
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
  table: ({ node: _node, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table {...props} />
    </div>
  ),
};

const SOURCE_HREF = "#source-";

/**
 * Turns "[S2]" into a link ONLY when S2 is one of the passages the server actually gave the model
 * for this answer. A "[S9]" the model made up stays plain text, so a citation is never clickable
 * unless it points at real material.
 */
function linkCitations(text: string, keys: Set<string>): string {
  return text.replace(/\[(S\d{1,2})\]/g, (whole, key: string) => (keys.has(key) ? `[${key}](${SOURCE_HREF}${key})` : whole));
}

interface MarkdownProps {
  children: string;
  sources?: SourceRef[] | undefined;
  onSource?: ((source: SourceRef) => void) | undefined;
}

export default function Markdown({ children, sources, onSource }: MarkdownProps) {
  const linked = sources && sources.length > 0 && onSource;
  const text = useMemo(() => (linked ? linkCitations(children, new Set(sources.map((s) => s.key))) : children), [children, sources, linked]);
  const comps = useMemo<Components>(() => {
    if (!linked) return components;
    return {
      ...components,
      a: ({ node: _node, href, children: label, ...props }) => {
        const source = href?.startsWith(SOURCE_HREF) ? sources.find((s) => s.key === href.slice(SOURCE_HREF.length)) : undefined;
        if (!source) return <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow">{label}</a>;
        return (
          <button
            type="button"
            onClick={() => onSource(source)}
            aria-label={`Source ${source.key}${source.page ? `, page ${source.page}` : ""}`}
            title="Show this in the document"
            className="mx-0.5 rounded bg-brand-50 px-1.5 py-0.5 align-baseline text-xs font-semibold text-brand-700 ring-1 ring-brand-100 hover:bg-brand-100"
          >
            {label}
          </button>
        );
      },
    };
  }, [linked, sources, onSource]);
  return (
    <div className="tutor-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={comps}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
