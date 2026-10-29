"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /developer : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="developer").
 */
export default function DeveloperError({
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
      segment="developer"
      titre="L&apos;espace développeur n&apos;a pas pu s&apos;afficher complètement"
      message="Une erreur technique est survenue pendant l&apos;affichage des outils de développement. Vos intégrations restent intactes — réessayez ou revenez au tableau de bord."
      retourHref="/dashboard"
      retourLabel="Tableau de bord"
    />
  );
}
