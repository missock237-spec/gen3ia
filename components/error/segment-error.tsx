"use client";

import Link from "next/link";
import { useEffect } from "react";

import { captureClientException } from "@/lib/telemetry/sentry-bridge-client";

/**
 * Boundary d'erreur SEGMENTAIRE (App Router) — composant partagé consommé par
 * les app/<segment>/error.tsx (dashboard, admin, settings, team, developer,
 * live, billing, memory, neural).
 *
 * Pourquoi une boundary PAR SEGMENT : sans elle, une exception de rendu dans
 * un composant d'un segment remonte jusqu'à app/error.tsx qui remplace LA
 * PAGE ENTIÈRE (sidebar et navigation comprises). Avec elle, le crash est
 * contenu au segment : le reste de l'application (layout racine, navigation)
 * reste vivant, l'utilisateur peut réessayer ou repartir du tableau de bord.
 *
 * Sentry : capture via le pont asynchrone (zéro kB au chemin critique, même
 * convention que app/error.tsx et app/global-error.tsx). Le nom du segment
 * est passé comme tag pour router l'incident côté Sentry ; le digest Next
 * est conservé pour corréler avec les erreurs serveur.
 */

interface SegmentErrorProps {
  /** Erreur transmise par Next au fichier error.tsx du segment. */
  error: Error & { digest?: string };
  /** Réessai natif Next : re-rendu du segment. */
  reset: () => void;
  /** Identifiant du segment (tag Sentry + libellé eyebrow). */
  segment: string;
  /** Titre h1 contextuel (ex. « Le tableau de bord n'a pas pu s'afficher complètement »). */
  titre: string;
  /** Message rassurant contextuel (données intactes, action possible). */
  message: string;
  /** Lien de retour contextuel (défaut : tableau de bord). */
  retourHref?: string;
  /** Libellé du lien de retour. */
  retourLabel?: string;
}

export default function SegmentError({
  error,
  reset,
  segment,
  titre,
  message,
  retourHref = "/dashboard",
  retourLabel = "Tableau de bord",
}: SegmentErrorProps) {
  useEffect(() => {
    console.error(`[gen3ia] Erreur de rendu du segment ${segment} :`, error);
    captureClientException(error, {
      surface: "segment-error",
      segment,
      digest: error?.digest ?? "none",
    });
  }, [error, segment]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-5 text-[var(--g3-text)] md:p-8" role="alert">
      <section className="anim-scale-in w-full max-w-lg rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--g3-danger-soft)] text-2xl">
          ⚠️
        </div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[.25em] text-[var(--g3-danger-strong)]">
          Gen3ia · {segment} · erreur inattendue
        </p>
        <h1 className="mt-3 font-serif text-2xl font-semibold">{titre}</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--g3-muted)]">{message}</p>
        {error?.digest ? (
          <p className="mt-3 text-xs text-[var(--g3-faint)]">
            Référence :{" "}
            <code className="rounded bg-[var(--g3-elevated)] px-1.5 py-0.5">{error.digest.slice(0, 16)}</code>
          </p>
        ) : null}
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button type="button" onClick={reset} className="g3-btn g3-btn-primary rounded-full">
            Réessayer
          </button>
          <Link href={retourHref} className="g3-btn g3-btn-ghost rounded-full">
            {retourLabel}
          </Link>
        </div>
      </section>
    </div>
  );
}
