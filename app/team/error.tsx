"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /team : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="team").
 */
export default function TeamError({
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
      segment="team"
      titre="L&apos;espace équipe n&apos;a pas pu s&apos;afficher complètement"
      message="Une erreur technique est survenue pendant l&apos;affichage de l&apos;équipe. Vos espaces partagés et vos missions restent intacts — réessayez ou revenez au tableau de bord."
      retourHref="/dashboard"
      retourLabel="Tableau de bord"
    />
  );
}
