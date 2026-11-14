/**
 * INTENTION UTILISATEUR MÉDIA — détection déterministe (aucun LLM) des
 * demandes EXPLICITES portées par le texte libre du brief.
 *
 * Demande propriétaire (2026-11-14) : « les sous-titres doivent être ajoutés
 * UNIQUEMENT si l'utilisateur le demande ». Historiquement les sous-titres
 * étaient ACTIVÉS PAR DÉFAUT à trois couches (schéma de scénario, plan du
 * directeur, timeline) — cette inversion nécessite une source unique de
 * vérité sur la volonté exprimée : ce module. Les mêmes fonctions servent
 * au garant d'animation (un « plan fixe » explicitement demandé reste
 * immobile ; sinon toute scène porte un mouvement de caméra).
 *
 * Déterminisme : pures fonctions regex FR/EN, casse et accents ignorés —
 * jamais d'appel réseau, jamais de modèle. Un brief ambigu (aucun marqueur)
 * renvoie FALSE : l'absence de demande n'est pas une demande.
 *
 * ATTENTION : le texte est DÉSACCENTUÉ avant test (normalize NFD + retrait
 * des diacritiques) — tous les motifs ci-dessous s'écrivent donc SANS
 * accents (« legendes », « karaoke », « camera », « a l'ecran »).
 */

/** Marqueurs EXPLICITES de demande de sous-titres / légendes (FR + EN). */
const MOTIFS_SOUS_TITRES: readonly RegExp[] = [
  /\bsous[- ]?titr\w*\b/,
  /\bsub[- ]?titles?\b/,
  /\bcaptions?\b/,
  /\blegendes?\b/,
  /\blegend[ae]s?\b/,
  /\btexte (?:à|a) l['’]?ecran\b/,
  /\bon[- ]?screen text\b/,
  /\bkaraoke\b/,
  /\bst\s*:\s*(?:on|yes|true|1)\b/,
];

/** Marqueurs EXPLICITES d'un plan fixe / caméra immobile assumé. */
const MOTIFS_PLAN_FIXE: readonly RegExp[] = [
  /\bplan(?:s)? fixe(?:s)?\b/,
  /\bfixe(?:z)? (?:la |le |les )?camera\b/,
  /\bcamera (?:immobile|fixe|statique)\b/,
  /\bimmobile\b/,
  /\btrepied\b/,
  /\bsans (?:mouvement|zoom|camera)\b/,
  /\bno (?:camera )?motion\b/,
  /\bfixed (?:shot|camera)\b/,
  /\bstatic (?:shot|camera)\b/,
];

function normaliser(texte: string): string {
  return (texte ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * TRUE uniquement si le texte porte une demande EXPLICITE de sous-titres.
 * Utilisé par le plan du directeur (repli déterministe), la file de
 * production (défaut de l'option subtitlesEnabled) et le scénario.
 */
export function demandeSousTitres(texte: string): boolean {
  const bas = normaliser(texte);
  if (bas.length === 0) return false;
  // Un refus explicite (« sans sous-titres ») GAGNE toujours : la volonté
  // utilisateur est un contrat, dans les deux sens.
  const refus = /\bsans (?:sous[- ]?titr\w*|legendes?|captions?|subtitles?)\b|\bpas de (?:sous[- ]?titr\w*|legendes?|captions?|subtitles?|texte (?:à|a) l['’]?ecran)\b|\bno (?:subtitles?|captions?)\b|\bsubtitles? off\b/.test(bas);
  if (refus) return false;
  return MOTIFS_SOUS_TITRES.some((motif) => motif.test(bas));
}

/**
 * TRUE si l'utilisateur demande explicitement une caméra immobile
 * (« plan fixe », « sans zoom »…) — dans ce cas seulement, une scène peut
 * rester sans mouvement de caméra. Sinon FALSE : la production anime
 * systématiquement chaque plan.
 */
export function demandePlanFixe(texte: string): boolean {
  const bas = normaliser(texte);
  if (bas.length === 0) return false;
  return MOTIFS_PLAN_FIXE.some((motif) => motif.test(bas));
}
