"use client";

import { Fragment, type ReactNode } from "react";

import { stripThinkTags } from "@/lib/ai/think-filter";
import { parseMarkdownBlocks } from "@/lib/ui/markdown-blocks";

/**
 * Rendu markdown minimal et sûr pour les messages de conversation :
 * aucun dangerouslySetInnerHTML — tout est transformé en éléments React.
 * Support : titres (#…), gras, italique, code inline, blocs de code,
 * listes à puces/numérotées, citations, liens, images ![alt](url),
 * tableaux (| a | b | avec ligne de séparation) et séparateurs (---).
 * Task 52 : le support des tableaux et séparateurs aligne le rendu sur les
 * réponses « qualité ChatGPT » demandées aux modèles (comparaisons lisibles).
 */

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\((?:https?:\/\/|\/)[^\s)]+\)|!\[[^\]]*\]\((?:https?:\/\/|\/)[^\s)]+\))/g;

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
    const image = /^!\[([^\]]*)\]\(((?:https?:\/\/|\/)[^\s)]+)\)$/.exec(part);
    if (image) {
      return (
        /* eslint-disable-next-line @next/next/no-img-element -- URL externe (CDN du fournisseur d'images), pas de domaine fixe pour next/image */
        <img
          key={key}
          src={image[2]}
          alt={image[1] || "Image générée"}
          loading="lazy"
          className="max-h-96 w-auto max-w-full rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] object-contain"
        />
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

// Parser extrait dans un module feuille PUR (Task 52) : testable sous Node
// (vitest, environnement node) et réutilisable sans React. Le rendu sûr
// (éléments React, jamais de dangerouslySetInnerHTML) reste ici.

export function MarkdownContent({ content }: { content: string }) {
  // Défense en profondeur : les balises de raisonnement de certains modèles
  // (<think>…) ne doivent jamais être rendues, même sur des messages anciens
  // persistés avant le filtrage à la source.
  const blocks = parseMarkdownBlocks(stripThinkTags(content));
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
          case "hr":
            return <hr key={key} className="border-0 border-t border-[var(--g3-border)]" />;
          case "table":
            return (
              <div key={key} className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      {(block.header ?? []).map((cell, i) => (
                        <th
                          key={`th-${key}-${i}`}
                          className="border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-2.5 py-1.5 text-left font-semibold text-[var(--g3-text)]"
                        >
                          {renderInline(cell, `th-${key}-${i}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(block.rows ?? []).map((row, r) => (
                      <tr key={`tr-${key}-${r}`}>
                        {row.map((cell, c) => (
                          <td
                            key={`td-${key}-${r}-${c}`}
                            className="border border-[var(--g3-border)] px-2.5 py-1.5 align-top text-[var(--g3-text)]"
                          >
                            {renderInline(cell, `td-${key}-${r}-${c}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
