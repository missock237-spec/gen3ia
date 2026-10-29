"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /billing : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="billing").
 */
export default function BillingError({
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
      segment="billing"
      titre="La facturation n&apos;a pas pu s&apos;afficher complètement"
      message="Une erreur technique est survenue pendant l&apos;affichage de la facturation. Vos abonnements et vos paiements restent intacts — réessayez ou revenez au tableau de bord."
      retourHref="/dashboard"
      retourLabel="Tableau de bord"
    />
  );
}
