"use client";

import type { ReactNode } from "react";

/**
 * En-tête unifié des pages du Studio.
 * Garantit la même hiérarchie visuelle (eyebrow → titre serif → description)
 * et le même alignement sur toutes les pages, avec un slot d'actions.
 */
export function StudioHeader({
  eyebrow,
  title,
  highlight,
  description,
  actions,
  meta,
}: {
  eyebrow: string;
  title: string;
  highlight?: string;
  description?: string;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="g3-eyebrow">{eyebrow}</div>
          {meta}
        </div>
        <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight md:text-4xl">
          {title}
          {highlight ? <span className="gradient-text"> {highlight}</span> : null}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--g3-muted)] md:text-base">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
