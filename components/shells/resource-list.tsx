"use client";

import Link from "next/link";

import { StatusBadge } from "./status-badge";

/**
 * ResourceList — liste de ressources générique (missions, livrables, clés,
 * extensions, connecteurs, comptes). Industrialise la ligne cliquable avec
 * icône, titre, méta, badge de statut et action — avant dupliquée dans chaque
 * page avec des balises légèrement différentes.
 */

export interface ResourceRow {
  id: string;
  /** Titre principal de la ligne. */
  title: string;
  /** Icône courte (1-2 caractères) dans une tuile arrondie. */
  icon?: string;
  /** Métadonnée secondaire (dates, propriétaire, projet…). */
  meta?: string;
  /** Statut brut transmis à StatusBadge (optionnel). */
  status?: string;
  /** Libellé surchargé du badge (optionnel). */
  statusLabel?: string;
  /** Petites étiquettes additionnelles (permissions, tags). */
  tags?: string[];
  /** Action principale (bouton/lien) rendue à droite. */
  action?: React.ReactNode;
  /** Rend la ligne cliquable (navigation). */
  href?: string;
  /** Callback de clic alternatif à href. */
  onClick?: () => void;
  /** Désactive l'interaction. */
  disabled?: boolean;
  /** Contenu secondaire affiché sous la ligne (ex. message d'erreur). */
  detail?: React.ReactNode;
}

// (imports regroupés en tête de module)

function RowInner({ row }: { row: ResourceRow }) {
  return (
    <>
      {row.icon !== undefined && (
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-neutral-100 text-sm text-neutral-500" aria-hidden="true">
          {row.icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-neutral-800">{row.title}</span>
        {row.meta && <span className="mt-0.5 block truncate text-xs text-neutral-400">{row.meta}</span>}
        {row.detail && <span className="mt-1 block text-xs text-neutral-500">{row.detail}</span>}
      </span>
      {row.tags && row.tags.length > 0 && (
        <span className="hidden flex-wrap justify-end gap-1 md:flex md:max-w-[30%]">
          {row.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="rounded-md bg-neutral-100 px-1.5 py-0.5 font-mono text-[10px] text-neutral-500">
              {tag}
            </span>
          ))}
        </span>
      )}
      {(row.status || row.statusLabel) && (
        <span className="shrink-0">
          <StatusBadge status={row.status ?? "ok"} label={row.statusLabel} />
        </span>
      )}
      {row.action && <span className="shrink-0">{row.action}</span>}
    </>
  );
}

export function ResourceList({
  rows,
  ariaLabel,
  emptyState,
  className = "",
}: {
  rows: ResourceRow[];
  ariaLabel?: string;
  /** État vide affiché si rows est vide. */
  emptyState?: React.ReactNode;
  className?: string;
}) {
  if (rows.length === 0 && emptyState) return <>{emptyState}</>;
  return (
    <ul className={`space-y-2.5 ${className}`} aria-label={ariaLabel}>
      {rows.map((row) => {
        const interactive = Boolean(row.href || row.onClick) && !row.disabled;
        const classes = `flex w-full items-center gap-3.5 rounded-2xl border border-[rgba(23,23,20,0.08)] bg-white p-4 text-left shadow-[0_8px_24px_-20px_rgba(28,27,24,0.3)] transition ${
          interactive ? "hover:border-[rgba(23,23,20,0.2)] hover:shadow-[0_12px_28px_-18px_rgba(28,27,24,0.35)]" : ""
        }`;
        return (
          <li key={row.id}>
            {row.href && !row.disabled ? (
              <Link href={row.href} className={classes}>
                <RowInner row={row} />
              </Link>
            ) : row.onClick && !row.disabled ? (
              <button type="button" onClick={row.onClick} className={classes}>
                <RowInner row={row} />
              </button>
            ) : (
              <div className={`${classes} ${row.disabled ? "opacity-55" : ""}`}>
                <RowInner row={row} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
