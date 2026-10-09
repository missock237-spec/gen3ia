import {
  FieldValue,
} from "@/lib/r2fs";

import {
  adminDb,
} from "@/lib/firebase/admin";

import type {
  AIResponse,
} from "./models";

/**
 * Task 102-a — QUOTA FIRESTORE : agrégation « usageDaily ».
 *
 * AVANT : 1 nouveau document dans la collection "usage" par appel IA (ID
 * auto) → stockage illimité (N documents/jour/utilisateur) et le lecteur
 * admin /api/admin/observability devait lire 200 documents d'appels pour
 * calculer un simple total.
 *
 * APRÈS : les ÉCRITURES restent identiques (1 par appel IA — coût d'écriture
 * inchangé), mais le stockage est ÷N : un SEUL document par utilisateur et
 * par jour UTC (collection "usageDaily", ID déterministe), mis à jour par
 * FieldValue.increment en set merge — incrément atomique côté serveur, donc
 * ni lecture préalable, ni course si deux appels de l'utilisateur arrivent
 * la même seconde. 20 appels/jour/utilisateur → 1 document au lieu de 20 :
 * stockage ÷20 et lectures admin ÷20 (200 documents = 200 jours-utilisateurs
 * au lieu de 200 appels).
 *
 * TRANSITION : les anciens documents "usage" ne sont plus ni écrits ni lus —
 * l'historique par appel (dont le champ task) devient inaccessible côté
 * admin ; l'agrégat courant (appels, tokens, latence cumulée, sous-totaux
 * par modèle) est identique ou meilleur pour l'observabilité.
 */

/**
 * Clé de champ du sous-total d'un modèle : `${provider}_${model}` assainie.
 * POURQUOI : la clé est injectée dans un CHEMIN DE CHAMP POINTÉ
 * (models.<clé>.calls) — un point, slash ou deux-points parasites créeraient
 * une imbrication involontaire ; tout caractère hors [A-Za-z0-9] devient « _ »
 * (les UID et noms de modèles sont ensuite sans danger pour Firestore).
 */
export function cleModelePourChamp(
  provider: string,
  model: string,
): string {
  return `${provider}_${model}`.replace(/[^A-Za-z0-9]/g, "_");
}

/** Jour UTC au format « YYYY-MM-DD » (le compteur quotidien se réinitialise à minuit UTC). */
export function jourIsoUtc(
  instant: Date,
): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * ID déterministe du document quotidien : `${userId}_${YYYYMMDD}`.
 * Les UID Firebase sont alphanumériques → sûrs comme ID de document.
 */
export function idDocUsageDaily(
  userId: string,
  instant: Date,
): string {
  return `${userId}_${jourIsoUtc(instant).replace(/-/g, "")}`;
}

export async function recordAIUsage(
  params: {
    userId: string;
    task: string;
    response: AIResponse;
  },
) {
  // Un seul instant capturé : l'ID du document et dayIso ne peuvent pas se
  // désynchroniser si l'appel chevauche minuit UTC.
  const maintenant =
    new Date();

  const ref =
    adminDb
      .collection("usageDaily")
      .doc(
        idDocUsageDaily(
          params.userId,
          maintenant,
        ),
      );

  const cleModele =
    cleModelePourChamp(
      params.response.provider,
      params.response.model,
    );

  // Écriture unique par appel (set merge + FieldValue.increment) : les
  // compteurs sont incrémentés ATOMIQUEMENT par Firestore — pas de cycle
  // lecture-modification-écriture, donc pas de perte d'appel en concurrence.
  await ref.set(
    {
      // Identité du jour : valeurs constantes pour un même document →
      // identiques au merge, sans risque d'écrasement.
      userId:
        params.userId,

      dayIso:
        jourIsoUtc(
          maintenant,
        ),

      // Totaux du jour — latencyMs est une SOMME : moyenne = latencyMs / calls.
      calls:
        FieldValue.increment(1),

      inputTokens:
        FieldValue.increment(params.response.usage.inputTokens),

      outputTokens:
        FieldValue.increment(params.response.usage.outputTokens),

      totalTokens:
        FieldValue.increment(params.response.usage.totalTokens),

      latencyMs:
        FieldValue.increment(params.response.latencyMs),

      // Sous-totaux par modèle (chemins de champ pointés, clé assainie) :
      // savoir QUEL modèle consomme sans multiplier les documents.
      [`models.${cleModele}.calls`]:
        FieldValue.increment(1),

      [`models.${cleModele}.inputTokens`]:
        FieldValue.increment(params.response.usage.inputTokens),

      [`models.${cleModele}.outputTokens`]:
        FieldValue.increment(params.response.usage.outputTokens),

      [`models.${cleModele}.totalTokens`]:
        FieldValue.increment(params.response.usage.totalTokens),

      updatedAt:
        FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    },
  );

  return ref.id;
}
