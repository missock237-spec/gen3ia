"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Boundary d'erreur des routes (App Router) : intercepte toute exception de
 * rendu d'une page ou d'un composant serveur/client et affiche une page
 * d'erreur soignée en français, avec réessai — au lieu de l'écran de crash
 * brut du framework. Les erreurs sont loguées en console pour le diagnostic.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[gen3ia] Erreur de rendu de page :", error);
  }, [error]);

  return (
    <div className="min-h-full bg-[var(--g3-bg)] p-5 text-neutral-900 md:p-8">
      <div className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center">
        <section className="anim-scale-in w-full rounded-3xl border border-[var(--g3-border)] bg-white p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100 text-2xl">⚠️</div>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[.25em] text-red-500">Gen3ia · erreur inattendue</p>
          <h1 className="mt-3 font-serif text-2xl font-semibold">Cette page n&apos;a pas pu s&apos;afficher</h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-neutral-500">
            Une erreur technique est survenue pendant le chargement. Vos agents, vos tâches et vos données restent intacts.
            Vous pouvez réessayer immédiatement, ou revenir au tableau de bord.
          </p>
          {error?.digest ? (
            <p className="mt-3 text-xs text-neutral-400">
              Référence : <code className="rounded bg-neutral-100 px-1.5 py-0.5">{error.digest.slice(0, 16)}</code>
            </p>
          ) : null}
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button type="button" onClick={reset} className="g3-btn g3-btn-primary rounded-full">
              Réessayer
            </button>
            <Link href="/dashboard" className="g3-btn g3-btn-ghost rounded-full">
              Tableau de bord
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
