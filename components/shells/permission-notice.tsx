"use client";

import Link from "next/link";

/**
 * PermissionNotice — explique un accès manquant AVANT l'erreur.
 * Au lieu d'un 403 brut, la surface affiche ce qui manque, pourquoi, et
 * l'action pour y remédier (connexion, rôle, projet, connecteur…).
 */
export function PermissionNotice({
  tone = "warning",
  title,
  description,
  actions,
}: {
  tone?: "warning" | "danger" | "info";
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  const tones = {
    warning: "border-amber-200 bg-amber-50",
    danger: "border-red-200 bg-red-50",
    info: "border-sky-200 bg-sky-50",
  } as const;
  const icons = { warning: "⚠", danger: "⛔", info: "ⓘ" } as const;
  return (
    <section className={`rounded-3xl border p-5 ${tones[tone]}`} role="alert">
      <div className="flex items-start gap-3.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/70 text-base" aria-hidden="true">
          {icons[tone]}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-bold text-neutral-800">{title}</h2>
          {description && <p className="mt-1 text-sm leading-6 text-neutral-600">{description}</p>}
          {actions && <div className="mt-3.5 flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>
    </section>
  );
}

/** Bouton de retour standard vers l'espace de travail. */
export function BackToWorkspace({ label = "Retour à l'espace de travail", href = "/studio" }: { label?: string; href?: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-neutral-700"
    >
      <span aria-hidden="true">←</span> {label}
    </Link>
  );
}
