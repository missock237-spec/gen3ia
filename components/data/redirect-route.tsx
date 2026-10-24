"use client";

import { useEffect } from "react";

/**
 * RedirectRoute — redirection client réutilisable (restructuration des
 * parcours) : replace immédiatement vers la destination fusionnée et
 * affiche un lien de secours (navigation désactivée, JS bloqué).
 */
export function RedirectRoute({ href, label, texte }: { href: string; label: string; texte: string }) {
  useEffect(() => {
    window.location.replace(href);
  }, [href]);

  return (
    <main className="grid min-h-full place-items-center px-4">
      <div className="max-w-md rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8 text-center" role="status">
        <p className="text-sm text-[var(--g3-muted)]">{texte}</p>
        <a
          href={href}
          className="mt-5 inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white"
        >
          {label}
        </a>
      </div>
    </main>
  );
}
