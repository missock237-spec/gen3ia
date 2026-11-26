/**
 * PONT VOCAL ↔ VISION (mission LOT 5 : « L'utilisateur peut montrer une
 * scène à Gen3ia, poser une question et obtenir une réponse basée sur ce
 * qui est réellement visible »). Le cerveau vocal reçoit le CONTEXTE
 * VISUEL réel du vision-engine (mesures de la dernière frame analysée :
 * scène structurelle, temporalité, OCR si branché, confiance) — aucune
 * description fabriquée : le contexte transmis est le texte borné produit
 * par le moteur vision. Le pont publie aussi les événements sur le bus
 * commun (un seul historique — mission LOT 9).
 */

import { obtenirBusEvenements, type StoreEvenementsLive } from "../core/live-event-bus";
import type { CerveauVocal } from "./conversation-vocale";
import type { DescriptionVisuelle, VisionEngine } from "../vision/vision-engine";

/** Résumé visuel honnête transmis au cerveau vocal (jamais plus que mesuré). */
export function contexteDepuisDescription(desc: DescriptionVisuelle | null): string | undefined {
  if (!desc) return undefined;
  const ocrTxt = desc.ocr.disponible && desc.ocr.textes?.length
    ? ` textes lus : ${desc.ocr.textes.slice(0, 5).map((t) => t.contenu).join(" | ")}.`
    : " texte non lu.";
  return `Vision de la scène — ${desc.interpretation}.${ocrTxt} Confiance ${(desc.confiance.score * 100).toFixed(0)} %.`;
}

/** Cerveau vocal contextualisé : Gen3ia Core + contexte visuel réel. */
export function creerCerveauVocalContextualise(params: {
  /** Le cerveau de base (Gen3ia Core — moteur interne). */
  cerveau: CerveauVocal;
  /** Le moteur vision de la session (mémoire temporelle réelle). */
  vision: VisionEngine;
  /** Store événements optionnel (persistant selon la session). */
  storeEvenements?: StoreEvenementsLive;
  sessionId: string;
}): CerveauVocal & { derniereDescription(): DescriptionVisuelle | null } {
  const bus = obtenirBusEvenements(params.storeEvenements);
  let derniere: DescriptionVisuelle | null = null;
  return {
    derniereDescription: () => derniere,
    async repondre(texteUtilisateur: string, contexteExterne?: string) {
      // Le contexte visuel vient du moteur vision RÉEL de la session.
      const contexteVisuel = contexteDepuisDescription(derniere);
      const reponse = await params.cerveau.repondre(texteUtilisateur, contexteVisuel ?? contexteExterne);
      await bus.publier({
        sessionId: params.sessionId,
        type: "vocal.echange",
        source: "vocal",
        charge: {
          question: texteUtilisateur.slice(0, 300),
          reponse: reponse.slice(0, 300),
          contexteVisuelPresent: Boolean(contexteVisuel),
        },
      });
      return reponse;
    },
  };
}
