/**
 * Logique pure du CADRE DE PROGRESSION MÉDIA — Task 1-c (Mission utilisateur 2 :
 * « à chaque génération d'image ou de vidéo, un cadre qui montre la progression
 * RÉELLE en temps réel »).
 *
 * Fichier séparé du composant JSX pour rester exécutable en environnement Node
 * (convention du dépôt : vitest sans jsdom ni testing-library) et réutilisable
 * par les autres surfaces de génération (studio image, chat agent — Phase 2).
 */

/** États d'exécution d'une génération de média. */
export type MediaProgressStatus =
  | "queued"
  | "running"
  | "paused"
  | "complete"
  | "failed"
  | "cancelled";

/** Thème visuel : « dark » = atelier par défaut, « light » = thème crème (.g3-agent-light). */
export type MediaProgressTone = "dark" | "light";

/** Libellés français des pastilles de statut (verrouillés par les tests). */
export const MEDIA_PROGRESS_STATUS_LABELS: Record<MediaProgressStatus, string> = {
  queued: "En file",
  running: "En cours",
  paused: "En pause",
  complete: "Terminé",
  failed: "Échec",
  cancelled: "Annulé",
};

/**
 * Borne un pourcentage affiché dans l'intervalle 0..100 (arrondi à l'unité).
 * null/undefined/NaN → null = mode indéterminé.
 * Défense en profondeur : les appelants normalisent déjà l'échelle serveur
 * (0..1 historique ou 0..100) avant de passer la prop `percent`.
 */
export function clampPercent(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Chronomètre réel écoulé (le composant tique chaque seconde tant qu'il est
 * monté) : < 60 s → « X s » ; < 1 h → « X min Y s » ; sinon « X h Y min ».
 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes} min ${seconds} s`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

/**
 * Progression réelle côté client pour les lots multi-éléments (storyboard…) :
 * ready / total exprimé en pourcentage borné 0..100, null si total invalide.
 */
export function ratioToPercent(ready: number, total: number): number | null {
  if (!Number.isFinite(ready) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((ready / total) * 100)));
}
