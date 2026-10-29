"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /memory : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="memory").
 */
export default function MemoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <SegmentError
      error={error}
      reset={reset}
      segment="memory"
      titre="Les mémoires n&apos;ont pas pu s&apos;afficher complètement"
      message="Une erreur technique est survenue pendant l&apos;affichage des souvenirs permanents. Vos mémoires restent intactes — réessayez ou revenez au tableau de bord."
      retourHref="/dashboard"
      retourLabel="Tableau de bord"
    />
  );
}
