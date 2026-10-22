"use client";

/**
 * VOICE SPEAK — synthèse vocale NATIVE navigateur (Web Speech API).
 *
 * Réponse vocale du chat voix (demande utilisateur n°3 : « chat voix qui
 * peut s'activer si l'utilisateur appuie sur le bouton d'envoi sans prompt
 * écrit ») : quand un tour a été initié par la voix, la réponse de l'IA
 * est lue à voix haute via speechSynthesis — SANS dépendance externe
 * (aucun SDK, aucune clé), avec dégradation honnête :
 *  · serveur / navigateur sans speechSynthesis → speakFr retourne false,
 *    la réponse reste textuelle (jamais de faux moteur vocal) ;
 *  · plafond de caractères (défaut 1500) tronqué PROPREMENT à une fin de
 *    phrase (le texte parlé ne s'arrête pas en plein mot).
 */

/** Plafond par défaut du texte parlé (les réponses longues ne sont pas
 *  lues intégralement — l'utilisateur lit la suite dans le fil). */
export const PLAFOND_DEFAUT_TTS = 1500;

/** Nettoie un texte markdown pour la lecture vocale : les blocs de code
 *  ne sont pas épelés, les liens gardent leur libellé, la mise en forme
 *  (#, *, _, backticks) disparaît, les espaces sont compactés. */
export function nettoyerPourVoix(texte: string): string {
  return texte
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_~>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tronque proprement à une fin de phrase (.: !? … saut de ligne) sous le
 *  plafond demandé. Sans fin de phrase exploitable : coupe au dernier
 *  espace (jamais en plein mot) avec suspension « … ». */
export function tronquerFinDePhrase(texte: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (texte.length <= maxChars) return texte;
  const coupe = texte.slice(0, maxChars);
  // Dernière fin de phrase dans la portion tronquée (incluse).
  for (let i = coupe.length - 1; i >= 0; i--) {
    const caractere = coupe[i];
    if (caractere === "." || caractere === "!" || caractere === "?" || caractere === "…" || caractere === "\n") {
      const fin = i + 1;
      if (fin > maxChars / 2) return coupe.slice(0, fin).trimEnd();
      break;
    }
  }
  const espace = coupe.lastIndexOf(" ");
  if (espace > maxChars / 2) return `${coupe.slice(0, espace).trimEnd()}…`;
  return `${coupe.trimEnd()}…`;
}

/** Garde SSR/support honnête : true seulement si speechSynthesis existe. */
export function estSyntheseDisponible(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Arrête toute lecture en cours (no-op sans garde SSR qui plante). */
export function cancelSpeech(): void {
  if (!estSyntheseDisponible()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* un cancel raté ne doit jamais casser l'UI */
  }
}

/** Lecture vocale en cours ? (garde SSR : false hors navigateur) */
export function isSpeaking(): boolean {
  if (!estSyntheseDisponible()) return false;
  return window.speechSynthesis.speaking || window.speechSynthesis.pending;
}

export interface OptionsParle {
  /** Plafond de caractères (défaut PLAFOND_DEFAUT_TTS). */
  maxChars?: number;
  /** Appelé à la fin de la lecture (fin naturelle OU erreur) — l'UI
   *  retire alors l'indicateur « lecture vocale en cours ». */
  onFin?: () => void;
}

/** Lit un texte en français (voix fr si disponible). Retourne false si la
 *  synthèse est indisponible (SSR, navigateur sans speechSynthesis) — la
 *  réponse reste alors purement textuelle. */
export function speakFr(texte: string, options?: OptionsParle): boolean {
  if (!estSyntheseDisponible()) return false;
  const propre = nettoyerPourVoix(texte);
  if (!propre) return false;
  const plafond = options?.maxChars ?? PLAFOND_DEFAUT_TTS;
  const texteParle = tronquerFinDePhrase(propre, plafond);
  if (!texteParle) return false;

  const synthese = window.speechSynthesis;
  // Une nouvelle lecture remplace l'éventuelle précédente (pas de file).
  try {
    synthese.cancel();
  } catch {
    /* ignore */
  }
  const utterance = new SpeechSynthesisUtterance(texteParle);
  utterance.lang = "fr-FR";
  utterance.rate = 1;
  const voixFr = synthese.getVoices().find((voix) => voix.lang?.toLowerCase().startsWith("fr"));
  if (voixFr) utterance.voice = voixFr;
  const finir = () => options?.onFin?.();
  utterance.onend = finir;
  utterance.onerror = finir;
  synthese.speak(utterance);
  return true;
}
