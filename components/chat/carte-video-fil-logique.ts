/**
 * LOGIQUE PURE DE LA CARTE VIDÉO DU FIL (2026-11-13) — externalisée du
 * composant carte-video-fil.tsx pour rester testable en Node : vitest
 * tourne SANS jsdom et le tsconfig (jsx: "preserve") empêche vitest de
 * transformer un .tsx contenant du JSX — même découpage que
 * components/media/media-progress-frame.tsx + media-progress-logic.ts.
 *
 * CONTRAT DE PROGRESSION tolérant (même sémantique que la carte workspace) :
 * le serveur porte 0..1 (×100 requis) ; par défense, une valeur > 1 est
 * déjà un pourcentage — bornée 0..100 dans tous les cas.
 * Exportée pure pour les tests Node (carte-video-fil.test.tsx).
 */
export function pourcentageDepuis(valeur: unknown): number | null {
  if (typeof valeur !== "number" || !Number.isFinite(valeur)) return null;
  const pct = valeur <= 1 ? valeur * 100 : valeur;
  return Math.max(0, Math.min(100, Math.round(pct)));
}
