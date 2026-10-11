"use client";

import type { ReactNode } from "react";

/**
 * État vide réutilisable du Studio : icône flottante, titre,
 * description et action optionnelle. Garantit une présentation
 * cohérente quand une liste n'a pas encore de contenu.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "violet",
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  tone?: "violet" | "sky" | "emerald" | "amber";
}) {
  const toneClasses: Record<string, string> = {
    violet: "border-[var(--g3-primary-soft)] bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]",
    sky: "border-[var(--g3-secondary-soft)] bg-[var(--g3-secondary-soft)] text-[var(--g3-info)]",
    emerald: "border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]",
    amber: "border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]",
  };

  return (
    <div className="g3-card p-10 text-center">
      <div className={`anim-float mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border ${toneClasses[tone]}`}>
        {icon}
      </div>
      <h3 className="mt-4 font-bold">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[var(--g3-muted)]">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
