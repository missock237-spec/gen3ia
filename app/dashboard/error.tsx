"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /dashboard : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="dashboard").
 */
export default function DashboardError({
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
      segment="dashboard"
      titre="Le tableau de bord n&apos;a pas pu s&apos;afficher complètement"
      message="Une erreur technique est survenue pendant l&apos;affichage de la conversation. Vos conversations, vos agents et vos données restent intacts — vous pouvez réessayer tout de suite."
      retourHref="/"
      retourLabel="Accueil"
    />
  );
}
