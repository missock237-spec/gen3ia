"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Rendu markdown minimal et sûr pour les messages de conversation :
 * aucun dangerouslySetInnerHTML — tout est transformé en éléments React.
 * Support : titres (#…), gras, italique, code inline, blocs de code,
 * listes à puces/numérotées, citations, liens.
 */

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^\s)]+\))/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_PATTERN).filter((p) => p !== undefined && p !== "");
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (/^\*[^*\n]+\*$/.test(part)) return <em key={key}>{part.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(part)) {
      return (
        <code key={key} className="rounded bg-[var(--g3-elevated)] px-1.5 py-0.5 font-mono text-[0.85em] text-[var(--g3-text)]">
          {part.slice(1, -1)}
        </code>
      );
    }
    const link = /^\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)$/.exec(part);
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-sky-700 underline underline-offset-2">
          {link[1]}
        </a>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

interface Block {
  kind: "heading" | "paragraph" | "code" | "ul" | "ol" | "quote";
  level?: number;
  language?: string;
  lines: string[];
}

export function parseMarkdownBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { kind: "ul" | "ol"; lines: string[] } | null = null;
  let code: { language: string; lines: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: list.kind, lines: list.lines });
      list = null;
    }
  };

  for (const line of lines) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (code) {
        blocks.push({ kind: "code", language: code.language || undefined, lines: code.lines });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = { language: fence[1], lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1].length, lines: [heading[2]] });
      continue;
    }
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      if (!list || list.kind !== "ul") {
        flushList();
        list = { kind: "ul", lines: [] };
      }
      list.lines.push(bullet[1]);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      if (!list || list.kind !== "ol") {
        flushList();
        list = { kind: "ol", lines: [] };
      }
      list.lines.push(ordered[1]);
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "quote", lines: [quote[1]] });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    paragraph.push(line);
  }
  if (code) blocks.push({ kind: "code", language: code.language || undefined, lines: code.lines });
  flushParagraph();
  flushList();
  return blocks;
}

export function MarkdownContent({ content }: { content: string }) {
  const blocks = parseMarkdownBlocks(content);
  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) => {
        const key = `b-${index}`;
        switch (block.kind) {
          case "heading": {
            const className =
              block.level === 1
                ? "text-base font-semibold text-[var(--g3-text)]"
                : block.level === 2
                  ? "text-[15px] font-semibold text-[var(--g3-text)]"
                  : "text-sm font-semibold text-[var(--g3-text)]";
            return (
              <p key={key} className={className}>
                {renderInline(block.lines[0], key)}
              </p>
            );
          }
          case "code":
            return (
              <pre key={key} className="g3-code overflow-x-auto rounded-xl p-3 text-xs leading-relaxed" data-language={block.language}>
                <code>{block.lines.join("\n")}</code>
              </pre>
            );
          case "ul":
            return (
              <ul key={key} className="list-disc space-y-1 pl-5 text-sm">
                {block.lines.map((line, i) => (
                  <li key={`${key}-${i}`}>{renderInline(line, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key} className="list-decimal space-y-1 pl-5 text-sm">
                {block.lines.map((line, i) => (
                  <li key={`${key}-${i}`}>{renderInline(line, `${key}-${i}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key} className="border-l-2 border-[var(--g3-border-strong)] pl-3 text-sm italic text-[var(--g3-muted)]">
                {renderInline(block.lines[0], key)}
              </blockquote>
            );
          default:
            return (
              <p key={key} className="whitespace-pre-wrap text-sm leading-relaxed">
                {renderInline(block.lines.join("\n"), key)}
              </p>
            );
        }
      })}
    </div>
  );
}
