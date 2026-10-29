"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /live : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="live").
 */
export default function LiveError({
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
      segment="live"
      titre="La session live n&apos;a pas pu démarrer complètement"
      message="Une erreur technique est survenue pendant l&apos;initialisation de la session vocale. Aucune conversation n&apos;est perdue — réessayez ou revenez au tableau de bord."
      retourHref="/dashboard"
      retourLabel="Tableau de bord"
    />
  );
}
