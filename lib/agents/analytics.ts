import "server-only";

import { FieldValue } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { logger } from "@/lib/observability/logger";

/**
 * ANALYTIQUE PAR AGENT (Task 131 — axe « Analytique »).
 *
 * AVANT : rien ne mesurait la performance d'un agent. Les compteurs globaux
 * (usageDaily, Task 102-a) agrègent par UTILISATEUR et par modèle — impossible
 * de répondre à « mon agent commercial est-il lent ? combien d'outils par
 * tour ? quel taux d'erreur ? ».
 *
 * APRÈS : chaque TOUR d'agent alimente un agrégat quotidien Firestore
 * (collection `agentAnalytics`, document `{agentId}_{YYYY-MM-DD}` — un SEUL
 * document par agent et par jour, pattern des compteurs du projet) :
 *  - compteurs atomiques (FieldValue.increment dans une transaction, comme
 *    lib/agents/evolution.ts) : messages, toolCalls, errors, tokensIn/out,
 *    somme de latence, sous-totaux par mode ;
 *  - `latencySamples` : fenêtre bornée des 500 dernières latences observées —
 *    de vrais échantillons permettent des p50/p95 exacts, et la borne évite
 *    la croissance non limitée du document (500 nombres ≈ quelques ko) ;
 *  - `getAgentAnalytics` relit N jours et calcule totaux + p50/p95.
 *
 * DOCTRINE FAIL-SOFT (contrat Task 131) : `recordAgentTurn` est appelé en
 * fire-and-forget depuis le chemin critique du chat — elle ne lève JAMAIS
 * (toute erreur est avalée avec un log warn), n'ajoute AUCUNE latence au
 * tour, et un échec d'analytique n'a strictement aucun impact sur la réponse
 * envoyée à l'utilisateur.
 */

const COLLECTION = "agentAnalytics";

/** Fenêtre des échantillons de latence conservés (p95 calculé dessus). */
export const LATENCY_SAMPLE_WINDOW = 500;

/** Nombre de jours lus par défaut par getAgentAnalytics. */
export const ANALYTICS_DEFAULT_DAYS = 7;

/** Jour UTC au format « YYYY-MM-DD » (l'agrégat se réinitialise à minuit UTC). */
export function jourIsoUtc(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** ID déterministe du document quotidien : `{agentId}_{YYYY-MM-DD}`. */
export function idDocAnalytics(agentId: string, instant: Date): string {
  return `${agentId}_${jourIsoUtc(instant)}`;
}

/**
 * Clé de champ du sous-total par mode : les points et slash créeraient une
 * imbrication involontaire dans le chemin de champ pointé (`modes.<clé>`) —
 * tout caractère hors [A-Za-z0-9] devient « _ » (même règle que
 * cleModelePourChamp de lib/ai/usage.ts).
 */
function cleModePourChamp(mode: string): string {
  return mode.replace(/[^A-Za-z0-9]/g, "_");
}

export interface AgentTurnInput {
  /** Agent concerné (identifiant du document agent). */
  agentId: string;
  /** Conversation du tour (utile au diagnostic, jamais requis). */
  conversationId?: string;
  /** Latence du tour en millisecondes (mesurée autour de la génération). */
  latencyMs: number;
  /** Tokens d'entrée consommés (facturation réelle du runtime si connue). */
  tokensIn?: number;
  /** Tokens de sortie consommés. */
  tokensOut?: number;
  /** Nombre d'appels d'outils du tour. */
  toolCalls?: number;
  /** Nombre d'erreurs du tour. */
  errors?: number;
  /** Mode du tour (« chat », « task »…). */
  mode?: string;
}

/**
 * Enregistre un tour d'agent dans l'agrégat quotidien — FIRE-AND-FORGET.
 *
 * Écriture atomique : une transaction unique (lecture CAS + commit
 * conditionnel) incrémente les compteurs via FieldValue.increment ET met à
 * jour la fenêtre `latencySamples` (le nouveau sample est ajouté, les plus
 * anciens au-delà de 500 sont évacués) — les deux restent cohérents dans le
 * même document, sans cycle lecture-modification-écriture concurrent. Le
 * tout passe par runFirestoreGuarded (deadline 6 s + disjoncteur quota,
 * doctrine Task 110-d).
 *
 * Ne lève JAMAIS : appelée sans await sur le chemin critique du chat, une
 * panne d'analytique est avalée avec un log warn.
 */
export async function recordAgentTurn(input: AgentTurnInput): Promise<void> {
  try {
    // Un seul instant capturé : l'ID du document et dayIso ne peuvent pas se
    // désynchroniser si l'appel chevauche minuit UTC.
    const maintenant = new Date();
    const ref = adminDb.collection(COLLECTION).doc(idDocAnalytics(input.agentId, maintenant));
    const latencyMs = Math.max(0, Math.round(input.latencyMs));

    await runFirestoreGuarded(`agent analytics record ${ref.id}`, () =>
      adminDb.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const actuel = snapshot.exists && typeof snapshot.data() === "object" && snapshot.data() !== null
          ? (snapshot.data() as Record<string, unknown>)
          : {};
        const samples = Array.isArray(actuel.latencySamples)
          ? actuel.latencySamples.filter((valeur): valeur is number => typeof valeur === "number")
          : [];
        // Fenêtre glissante bornée : le sample le plus ancien sort quand la
        // fenêtre est pleine (p95 toujours calculé sur les 500 derniers tours).
        const prochainsSamples = [...samples, latencyMs].slice(-LATENCY_SAMPLE_WINDOW);

        tx.set(ref, {
          // Identité du jour : constantes pour un même document → identiques
          // au merge, sans risque d'écrasement.
          agentId: input.agentId,
          dayIso: jourIsoUtc(maintenant),
          ...(input.conversationId ? { lastConversationId: input.conversationId } : {}),
          // Totaux du jour — latencyMsSum est une SOMME : moyenne =
          // latencyMsSum / messages.
          messages: FieldValue.increment(1),
          toolCalls: FieldValue.increment(input.toolCalls ?? 0),
          errors: FieldValue.increment(input.errors ?? 0),
          latencyMsSum: FieldValue.increment(latencyMs),
          latencySamples: prochainsSamples,
          tokensIn: FieldValue.increment(input.tokensIn ?? 0),
          tokensOut: FieldValue.increment(input.tokensOut ?? 0),
          // Sous-totaux par mode (chemin de champ pointé, clé assainie) :
          // savoir si l'agent est surtout sollicité en chat ou en tâche.
          ...(input.mode ? { [`modes.${cleModePourChamp(input.mode)}`]: FieldValue.increment(1) } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }),
    );
  } catch (error) {
    // Fail-soft strict (contrat Task 131) : l'analytique ne doit JAMAIS
    // ralentir ni casser le chat — l'échec est journalisé puis oublié.
    logger.warn(
      { err: error instanceof Error ? error.message : error, agentId: input.agentId },
      "agent_analytics_turn_not_recorded",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Lecture agrégée                                                     */
/* ------------------------------------------------------------------ */

export interface AgentAnalyticsDayPoint {
  dayIso: string;
  messages: number;
  toolCalls: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  /** Latence moyenne du jour (null si aucun tour enregistré). */
  latencyAvgMs: number | null;
}

export interface AgentAnalyticsSummary {
  agentId: string;
  /** Horizon réellement lu (borné 1-90). */
  days: number;
  messages: number;
  toolCalls: number;
  errors: number;
  tokensIn: number;
  tokensOut: number;
  /** Latence calculée depuis les échantillons stockés (fenêtre 500/jour). */
  latency: {
    samples: number;
    avgMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  /** Série quotidienne chronologique (jours sans activité inclus, à zéro). */
  daily: AgentAnalyticsDayPoint[];
}

/** Percentile (méthode du rang le plus proche) sur des valeurs TRIÉES. */
function percentile(valeursTriees: number[], rang: number): number | null {
  if (valeursTriees.length === 0) return null;
  const indice = Math.min(
    valeursTriees.length - 1,
    Math.max(0, Math.ceil((rang / 100) * valeursTriees.length) - 1),
  );
  return valeursTriees[indice]!;
}

function nombre(valeur: unknown): number {
  return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : 0;
}

function echantillons(valeur: unknown): number[] {
  return Array.isArray(valeur) ? valeur.filter((item): item is number => typeof item === "number" && Number.isFinite(item)) : [];
}

/**
 * Lit l'agrégat d'un agent sur les `days` derniers jours UTC (aujourd'hui
 * inclus). Les documents sont lus par ID déterministe (`{agentId}_{jour}`) :
 * une requête where("agentId") scannerait TOUTE la collection — chaque jour
 * est une clé exacte, une lecture par document, sous runFirestoreGuarded.
 * Les jours sans document comptent pour zéro (série continue garantie).
 */
export async function getAgentAnalytics(agentId: string, days = ANALYTICS_DEFAULT_DAYS): Promise<AgentAnalyticsSummary> {
  const horizon = Math.max(1, Math.min(90, Math.floor(days)));
  const jours: Date[] = Array.from({ length: horizon }, (_, decalage) => new Date(Date.now() - decalage * 86_400_000));

  const documents = await runFirestoreGuarded(`agent analytics read ${agentId} ${horizon}j`, () =>
    Promise.all(jours.map((jour) => adminDb.collection(COLLECTION).doc(idDocAnalytics(agentId, jour)).get())),
  );

  const daily: AgentAnalyticsDayPoint[] = [];
  const samplesCumules: number[] = [];
  let messages = 0;
  let toolCalls = 0;
  let errors = 0;
  let tokensIn = 0;
  let tokensOut = 0;

  // jours[] est antéchronologique (aujourd'hui d'abord) : la série retournée
  // est remise en ordre chronologique strict.
  for (let i = jours.length - 1; i >= 0; i--) {
    const data = documents[i]?.exists && typeof documents[i]?.data() === "object" && documents[i]?.data() !== null
      ? (documents[i]!.data() as Record<string, unknown>)
      : {};
    const jourMessages = nombre(data.messages);
    const samplesDuJour = echantillons(data.latencySamples);
    samplesCumules.push(...samplesDuJour);
    messages += jourMessages;
    toolCalls += nombre(data.toolCalls);
    errors += nombre(data.errors);
    tokensIn += nombre(data.tokensIn);
    tokensOut += nombre(data.tokensOut);
    daily.push({
      dayIso: jourIsoUtc(jours[i]!),
      messages: jourMessages,
      toolCalls: nombre(data.toolCalls),
      errors: nombre(data.errors),
      tokensIn: nombre(data.tokensIn),
      tokensOut: nombre(data.tokensOut),
      latencyAvgMs: samplesDuJour.length > 0
        ? Math.round(samplesDuJour.reduce((somme, valeur) => somme + valeur, 0) / samplesDuJour.length)
        : null,
    });
  }

  samplesCumules.sort((a, b) => a - b);
  const totalSamples = samplesCumules.reduce((somme, valeur) => somme + valeur, 0);

  return {
    agentId,
    days: horizon,
    messages,
    toolCalls,
    errors,
    tokensIn,
    tokensOut,
    latency: {
      samples: samplesCumules.length,
      avgMs: samplesCumules.length > 0 ? Math.round(totalSamples / samplesCumules.length) : null,
      p50Ms: percentile(samplesCumules, 50),
      p95Ms: percentile(samplesCumules, 95),
    },
    daily,
  };
}
