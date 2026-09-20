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
    violet: "border-violet-200 bg-violet-100 text-violet-700",
    sky: "border-sky-200 bg-sky-100 text-sky-700",
    emerald: "border-emerald-200 bg-emerald-100 text-emerald-600",
    amber: "border-amber-200 bg-amber-100 text-amber-700",
  };

  return (
    <div className="g3-card p-10 text-center">
      <div className={`anim-float mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border ${toneClasses[tone]}`}>
        {icon}
      </div>
      <h3 className="mt-4 font-bold">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-neutral-500">{description}</p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}
