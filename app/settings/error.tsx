"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /settings : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="settings").
 */
export default function SettingsError({
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
      segment="settings"
      titre="Les paramètres n&apos;ont pas pu s&apos;afficher complètement"
      message="Une erreur technique est survenue pendant l&apos;affichage des réglages. Vos préférences enregistrées restent intactes — réessayez ou revenez au tableau de bord."
      retourHref="/dashboard"
      retourLabel="Tableau de bord"
    />
  );
}
