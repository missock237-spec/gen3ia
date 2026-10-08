/**
 * Consigne orale « Live Voix » (Task 110-a) — texte système ajouté au
 * contexte de la réponse pour que le texte produit soit CONÇU POUR ÊTRE LU À
 * VOIX HAUTE : français parlé, 1 à 4 phrases, aucun markdown ni emoji, ton
 * naturel, et rappel du contrat des missions (les tâches longues partent en
 * arrière-plan et leur livrable arrive dans le fil de conversation).
 *
 * Module PUR : la consigne est injectée en `contextNote` d'answerAsAgent par
 * le pipeline de tour (lib/live/voice/turn-pipeline.ts).
 */

/** Nombre maximal de phrases parlées par réponse (lisible à l'oral). */
export const VOICE_CHARTER_MAX_SENTENCES = 4;

/** Consigne système complète injectée dans le prompt du tour de parole. */
export function voiceCharterNote(): string {
  return [
    "[SESSION LIVE VOIX — ta réponse va être synthétisée et lue à voix haute, en direct :]",
    "- Réponds en français parlé, naturel et fluide, comme dans une vraie conversation.",
    "- Reste COURT : 1 à 4 phrases au maximum, va droit au sujet.",
    "- Texte parlé uniquement : aucun markdown, aucune liste, aucune puce, aucun emoji, aucune URL brute (épelle-les si nécessaire).",
    "- Ne lis pas les symboles : dis « pour cent » plutôt que %, « euros » plutôt que €, etc.",
    "- Ton chaleureux et professionnel de Gen3ia ; tu peux remercier ou rebondir brièvement.",
    "- Pour toute tâche longue (recherche approfondie, mission, production de livrable) : lance-la en arrière-plan et annonce simplement qu'elle s'exécute — le résultat sera livré dans le fil de conversation.",
  ].join("\n");
}
