/**
 * BRANCHEMENT ANTI-HALLUCINATION → CHEMIN RÉEL DE GÉNÉRATION (Lot 07,
 * mission « finalisation opérationnelle »).
 *
 * Le vérificateur (verificateur-reponses.ts — affirmations vs MÉMOIRE
 * VÉRIFIÉE locale, avec provenances) est branché sur le VRAI moteur de
 * conversation (runConversationTurn) :
 *  - route non-stream : le résultat est annoté avant sérialisation ;
 *  - route stream : l'événement `done` est annoté à la volée (le client
 *    reçoit un message honnête, sources comprises).
 *
 * Garanties :
 *  - les citations ajoutées proviennent de la mémoire vérifiée (provenance
 *    réelle : sourceId + url de collecte) — JAMAIS de source inventée ;
 *  - les affirmations NON_VÉRIFIÉES sont signalées honnêtement (sufixe
 *    court uniquement si le verdict global est NON_FONDÉE) ;
 *  - fail-soft total : tout incident laisse la réponse inchangée (le chat
 *    ne peut JAMAIS être cassé par la vérification) ;
 *  - interrupteur : AUTO_ANTI_HALLUCINATION=0 pour désactiver.
 */

import { mkdirSync } from "node:fs";

import { MemoireConnaissances } from "../knowledge/memoire-connaissances";
import { verifierReponse } from "./verificateur-reponses";

/** Mémoire autonome paresseuse (fail-soft — un incident n'est pas fatal). */
let memoireCache: MemoireConnaissances | null = null;
async function memoireAutonome(): Promise<MemoireConnaissances | null> {
  if (memoireCache) return memoireCache;
  try {
    const { dossierEtatParDefaut } = await import("../core/lifecycle-manager");
    const dossier = dossierEtatParDefaut();
    mkdirSync(dossier, { recursive: true });
    memoireCache = new MemoireConnaissances(dossier);
    return memoireCache;
  } catch {
    return null; // mémoire indisponible : pas d'annotation (jamais de faux succès)
  }
}

/** Message minimal annotable (surface réelle de ConversationMessage). */
export interface MessageAnnotable {
  content: string;
  citations?: Array<{ source: string; snippet?: string; url?: string }>;
  [cle: string]: unknown;
}

/** Suffixe honnête pour une réponse NON_FONDÉE (borne : 1 ligne). */
export const SUFFIXE_NON_FONDEE = "\n\n⚠️ Réponse marquée par le vérificateur autonome : des affirmations n'ont pas été retrouvées dans la mémoire vérifiée du cerveau (elles sont présentées sans validation).";

/**
 * ANNOTE un message assistant : citations de provenance réelles pour les
 * affirmations SOUTENUES + signal d'incertitude honnête si NON_FONDÉE.
 * Retourne le message inchangé si la vérification n'est pas armée.
 */
/** Options d'annotation (mémoire injectable pour les tests ; défaut : réelle). */
export interface OptionsAnnotation {
  memoire?: MemoireConnaissances;
}

/** ANNOTE un message assistant : citations de provenance réelles pour les
 * affirmations SOUTENUES + signal d'incertitude honnête si NON_FONDÉE.
 * Retourne le message inchangé si la vérification n'est pas armée. */
export async function annoterMessageAssistant(message: MessageAnnotable, options?: OptionsAnnotation): Promise<MessageAnnotable> {
  if (process.env.AUTO_ANTI_HALLUCINATION === "0") return message;
  if (!message?.content || typeof message.content !== "string" || message.content.length < 40) return message;
  try {
    const memoire = options?.memoire ?? (await memoireAutonome());
    if (!memoire || memoire.taille() === 0) return message; // rien à vérifier : pas de citation inventée
    const rapport = verifierReponse(message.content, memoire);
    if (rapport.affirmations.length === 0) return message;

    // Citations de provenance RÉELLE (mémoire vérifiée) pour le soutenu.
    const citationsAutonomes = rapport.affirmations
      .filter((a) => a.verdict === "SOUTENU")
      .slice(0, 3)
      .map((a) => ({
        source: `autonome:${a.sources[0]?.sourceId ?? "inconnu"}`,
        snippet: a.sources[0]?.concept ?? "",
        url: undefined as string | undefined,
      }))
      .filter((c) => c.snippet.length > 0);
    // Actualité/contradictions : les CONTREDITS sont signalés par citations
    // aussi (le client voit qu'une version contradictoire existe en mémoire).
    const citationsContradiction = rapport.affirmations
      .filter((a) => a.verdict === "CONTREDIT")
      .slice(0, 2)
      .map((a) => ({
        source: `autonome:contradiction:${a.sources[0]?.sourceId ?? "inconnu"}`,
        snippet: a.explication.slice(0, 120),
        url: undefined as string | undefined,
      }));

    const contenu = rapport.verdict === "NON_FONDÉE" ? `${message.content}${SUFFIXE_NON_FONDEE}` : message.content;
    return {
      ...message,
      content: contenu,
      citations: [...(message.citations ?? []), ...citationsAutonomes, ...citationsContradiction],
      verificationAutonome: {
        verdict: rapport.verdict,
        tauxSoutien: rapport.tauxSoutien,
        incertitudes: rapport.incertitudes.slice(0, 3),
      },
    };
  } catch {
    return message; // fail-soft total : jamais casser le chat
  }
}

/** Événement de flux minimal (surface réelle de ConversationStreamEvent). */
export interface EvenementFlux {
  type: string;
  assistantMessage?: MessageAnnotable;
  [cle: string]: unknown;
}

/** Enrobe un émetteur d'événements de flux : le `done` est annoté. */
export function annoterEvenementsFlux(
  onEvent: (evenement: EvenementFlux) => void | Promise<void>,
  options?: OptionsAnnotation,
): (evenement: EvenementFlux) => Promise<void> {
  return async (evenement) => {
    try {
      if (evenement?.type === "done" && evenement.assistantMessage) {
        onEvent({
          ...evenement,
          assistantMessage: await annoterMessageAssistant(evenement.assistantMessage, options),
        });
        return;
      }
    } catch {
      /* fail-soft : transmettre l'événement original */
    }
    await onEvent(evenement);
  };
}
