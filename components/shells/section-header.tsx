"use client";

import Link from "next/link";

import { matchNavRoute } from "./nav-registry";

/**
 * SectionHeader — en-tête de section unifié :
 * fil d'Ariane (dérivé du NavRegistry), titre, description et action principale.
 * Avant : chaque page avait son propre header avec des hiérarchies différentes.
 */
export function SectionHeader({
  eyebrow,
  title,
  highlight,
  description,
  action,
  breadcrumbs,
}: {
  /** Sur-label en petites capitales (ex. "GEN3IA / DEVELOPER"). */
  eyebrow?: string;
  title: string;
  /** Suite du titre mise en avant (italique serif, ex. "d'agents IA"). */
  highlight?: string;
  description?: string;
  /** Action principale (bouton(s)) affichée à droite. */
  action?: React.ReactNode;
  /** Fil d'Ariane explicite ; sinon dérivé automatiquement du NavRegistry. */
  breadcrumbs?: Array<{ label: string; href?: string }>;
}) {
  return (
    <header className="mb-7">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Fil d'Ariane" className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-[var(--g3-faint)]">
          {breadcrumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && <span aria-hidden="true">/</span>}
              {crumb.href ? (
                <Link href={crumb.href} className="transition hover:text-[var(--g3-text-secondary)]">
                  {crumb.label}
                </Link>
              ) : (
                <span className="font-medium text-[var(--g3-muted)]">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      {eyebrow && (
        <div className="text-[11px] font-semibold uppercase tracking-[.28em] text-[var(--g3-faint)]">{eyebrow}</div>
      )}
      <div className="mt-1.5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--g3-text)] md:text-3xl">
          {title}
          {highlight && (
            <>
              {" "}
              <em className="font-serif font-medium text-[var(--g3-muted)]">{highlight}</em>
            </>
          )}
        </h1>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
      {description && <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--g3-muted)]">{description}</p>}
    </header>
  );
}

/**
 * Fil d'Ariane automatique : [Espace, route courante] à partir du NavRegistry.
 */
export function autoBreadcrumbs(pathname: string, spaceLabel: string, spaceHref: string) {
  const matched = matchNavRoute(pathname);
  const crumbs: Array<{ label: string; href?: string }> = [{ label: spaceLabel, href: spaceHref }];
  if (matched && matched.href !== spaceHref) {
    crumbs.push({ label: matched.label });
  }
  return crumbs;
}
