import { randomUUID } from "node:crypto";

import { applyEarning, releaseReservation, reserveFunds, settleReservation } from "@/lib/billing/wallet";
import { computeRevenueSplit } from "@/lib/extensions/pricing";
import { adminDb } from "@/lib/firebase/admin";
import {
  HIRE_BY_EXECUTION_COLLECTION,
  HIRES_COLLECTION,
  AgentHireSchema,
  type AgentHire,
  canHireListing,
  getAgentListing,
} from "@/lib/marketplace/agent-listings";
import { buildAgentCharter } from "@/lib/agents/charter";
import { policyForAgent } from "@/lib/agents/personalized-plan";
import { getAgentForOwner } from "@/lib/agents/repository";
import { planUniversalAgent } from "@/lib/agents/runtime/unified-agent";
import type { RuntimePlan } from "@/lib/agents/runtime/types";
import { createQueuedMission, markMissionEnqueueFailed } from "@/lib/queue/mission-queue";
import { missionQueueConfigured, publishMissionTick } from "@/lib/queue/qstash";
import type { AIProvider } from "@/lib/ai/models";

/**
 * MARKETPLACE D'AGENTS — LOCATION (« hire ») (V2, Task 114-c).
 *
 * Un locataire loue l'agent publié d'un propriétaire pour UNE mission :
 *  1. le loyer (prix fixe du listing, XAF minor) est RÉSERVÉ sur le wallet du
 *     locataire (escrow, référence canonique `hire_<hireId>` — idempotence
 *     par doc-ID ledger, primitives wallet NON modifiées) ;
 *  2. la mission est planifiée avec le config SÉCURISÉ de l'agent du
 *     PROPRIÉTAIRE (charte + whitelist d'outils persona, JAMAIS ses
 *     sous-agents privés) mais s'EXÉCUTE sous l'uid du LOCATAIRE — mémoire,
 *     fichiers et facturation d'outils restent naturellement isolés par
 *     utilisateur ;
 *  3. au tick final, settleAgentHireByExecution CAPTURE le loyer et le
 *     SCINDE (commission plateforme / gain propriétaire crédité via
 *     applyEarning) sur réussite, ou LIBÈRE la réservation sur échec.
 *
 * FAIL-SOFT : le règlement (settle) ne lève JAMAIS vers mission-tick — un
 * incident de marketplace ne peut ni bloquer une livraison, ni casser une
 * mission ordinaire (absence de mapping = sortie immédiate « skipped »).
 */

/** Commission plateforme par défaut : 2 000 bps = 20 %. */
const DEFAULT_MARKETPLACE_FEE_BPS = 2_000;
/** Plafond de la commission : 5 000 bps = 50 % (jamais plus de la moitié). */
const MAX_MARKETPLACE_FEE_BPS = 5_000;

/** Plafond défensif des scans r2fs (locations « mes locations »). */
const SCAN_CAP = 100;

/**
 * Commission marketplace lue à l'appel (env GEN3IA_MARKETPLACE_FEE_BPS,
 * défaut 2 000, clamp 0..5 000 bps).
 */
export function marketplaceFeeBps(): number {
  const parsed = Number(process.env.GEN3IA_MARKETPLACE_FEE_BPS);
  if (!Number.isFinite(parsed)) return DEFAULT_MARKETPLACE_FEE_BPS;
  return Math.max(0, Math.min(MAX_MARKETPLACE_FEE_BPS, Math.floor(parsed)));
}

/** Référence canonique du loyer d'une location (doc-ID ledger idempotents). */
function hireReference(hireId: string): string {
  return `hire_${hireId}`;
}

function isInsufficientFundsMessage(message: string): boolean {
  return /insufficient wallet balance|balance is 0/i.test(message);
}

/** Contrainte de contexte ajoutée à la charte du propriétaire (location). */
const TENANT_CONTEXT_RULE =
  "CONTEXTE DE LOCATION : tu travailles actuellement pour un client qui loue cet agent sur la marketplace Gen3ia. Ne mentionne jamais de données privées du propriétaire (fichiers, souvenirs, conversations, API personnelles) : elles ne sont pas accessibles dans cette mission et ne doivent jamais être évoquées.";

/** Document de mapping rapide executionId → location (collection hireByExecution). */
interface HireByExecutionDoc {
  hireId: string;
  listingId: string;
  tenantId: string;
  ownerId: string;
  priceMinor: number;
  commissionBps: number;
  createdAtMs: number;
}

/* ------------------------------------------------------------------ */
/* Location                                                            */
/* ------------------------------------------------------------------ */

export interface HireAgentInput {
  listingId: string;
  objective: string;
  /** Conversation du LOCATAIRE à livrer à la fin de la mission (optionnel). */
  conversationId?: string;
}

export type HireAgentResult =
  | { hireId: string; runId: string; executionId: string; priceMinor: number }
  /** {error} porte aussi le statut HTTP canonique de la route (superset documenté). */
  | { error: string; status: number };

/**
 * LOUE l'agent publié d'un propriétaire pour une mission :
 * réserve du loyer → planification sécurisée → enfilement QStash.
 * Ne lève JAMAIS pour une erreur métier : résultat discriminé {error, status}.
 */
export async function hireAgent(tenantId: string, input: HireAgentInput): Promise<HireAgentResult> {
  if (!tenantId?.trim()) return { error: "Authentification requise.", status: 401 };
  const objective = input.objective?.trim() ?? "";
  if (!objective || objective.length > 4_000) {
    return { error: "Objectif invalide : décrivez la mission en 1 à 4 000 caractères.", status: 400 };
  }

  // 1) Annonce réelle et publiée.
  const listing = await getAgentListing(input.listingId).catch(() => null);
  if (!listing) {
    return { error: "Annonce introuvable ou retirée du catalogue.", status: 404 };
  }

  // 2) Gardes de location (annonce publiée, pas d'auto-location).
  const check = canHireListing(listing, tenantId);
  if (!check.ok) {
    if (check.reason === "self_hire") {
      return { error: "Vous ne pouvez pas louer votre propre agent.", status: 403 };
    }
    if (check.reason === "unauthenticated") {
      return { error: "Authentification requise.", status: 401 };
    }
    return { error: "Cette annonce n'est pas disponible à la location actuellement.", status: 409 };
  }

  // 3) La file de missions doit être activée (sinon la mission n'aurait
  //    AUCUN worker derrière — on refuse AVANT de prélever le moindre fonds).
  if (!missionQueueConfigured()) {
    return { error: "File de missions indisponible : la location ne peut pas être lancée pour le moment.", status: 503 };
  }

  // 4) Prix fixe du listing + commission plateforme (env, clamp).
  const hireId = randomUUID();
  const priceMinor = listing.pricing.priceMinor;
  const commissionBps = marketplaceFeeBps();
  const reference = hireReference(hireId);

  // 5) ESCROW : le loyer est réservé sur le wallet du LOCATAIRE.
  try {
    await reserveFunds({
      userId: tenantId,
      amountMinor: priceMinor,
      reference,
      metadata: { kind: "marketplace_hire", listingId: listing.listingId, hireId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInsufficientFundsMessage(message)) {
      return { error: "Solde insuffisant : rechargez votre portefeuille pour louer cet agent.", status: 402 };
    }
    console.error("[marketplace/hire] réservation du loyer impossible :", message);
    return { error: "Paiement momentanément indisponible. Réessayez dans un instant.", status: 503 };
  }

  // 6) Config runtime SÉCURISÉ de l'agent du PROPRIÉTAIRE : charte rebuild
  //    (buildAgentCharter — même voie que planAgentTask) + contrainte de
  //    location ; JAMAIS les sous-agents privés du propriétaire ; whitelist
  //    d'outils = politique persona de l'agent (resolveAllowedTools).
  const agent = await getAgentForOwner(listing.ownerId, listing.agentId).catch(() => null);
  if (!agent || agent.status !== "active") {
    await releaseReservation({ userId: tenantId, reference, reservedMinor: priceMinor }).catch(() => undefined);
    return { error: "L'agent sous-jacent n'est plus disponible à la location. La réservation a été annulée.", status: 409 };
  }

  let plan: RuntimePlan;
  try {
    const policy = policyForAgent(agent);
    // Miroir de planAgentTask : le planner doit pouvoir proposer les
    // connecteurs réellement vérifiés (composio.execute).
    const allowedTools = [...new Set([...(policy.allowedTools ?? []), "composio.execute"])];
    const fixedProvider =
      agent.modelStrategy === "fixed" && agent.preferredProvider
        ? (agent.preferredProvider as AIProvider)
        : undefined;
    plan = await planUniversalAgent(tenantId, objective, {
      agent: {
        charter: `${buildAgentCharter(agent)}\n\n${TENANT_CONTEXT_RULE}`,
        allowedTools,
        subAgents: [],
      },
      provider: fixedProvider,
      model: agent.modelStrategy === "fixed" ? agent.preferredModel : undefined,
    });
  } catch (error) {
    await releaseReservation({ userId: tenantId, reference, reservedMinor: priceMinor }).catch(() => undefined);
    console.error("[marketplace/hire] planification impossible (fonds libérés) :", error instanceof Error ? error.message : error);
    return { error: "La planification de la mission a échoué. Aucun montant n'a été retenu.", status: 503 };
  }

  // 7) Documents de location (status « held ») + mapping rapide au tick.
  const runId = randomUUID();
  const executionId = plan.executionId;
  const now = Date.now();
  const hireDoc = {
    hireId,
    listingId: listing.listingId,
    tenantId,
    ownerId: listing.ownerId,
    agentId: listing.agentId,
    executionId,
    runId,
    objective,
    priceMinor,
    commissionBps,
    status: "held" as const,
    ...(input.conversationId?.trim() ? { conversationId: input.conversationId.trim() } : {}),
    createdAtMs: now,
  };
  const mappingDoc: HireByExecutionDoc = {
    hireId,
    listingId: listing.listingId,
    tenantId,
    ownerId: listing.ownerId,
    priceMinor,
    commissionBps,
    createdAtMs: now,
  };
  try {
    await adminDb.collection(HIRES_COLLECTION).doc(hireId).set(hireDoc);
    await adminDb.collection(HIRE_BY_EXECUTION_COLLECTION).doc(executionId).set(mappingDoc);
  } catch (error) {
    await releaseReservation({ userId: tenantId, reference, reservedMinor: priceMinor }).catch(() => undefined);
    console.error("[marketplace/hire] enregistrement de la location impossible (fonds libérés) :", error instanceof Error ? error.message : error);
    return { error: "Enregistrement de la location impossible. Aucun montant n'a été retenu.", status: 503 };
  }

  // 8) Enfilement de la mission (uid = LOCATAIRE) puis publication du tick.
  try {
    await createQueuedMission({
      runId,
      executionId,
      userId: tenantId,
      objective,
      ...(input.conversationId?.trim() ? { conversationId: input.conversationId.trim() } : {}),
      plan,
    });
    const published = await publishMissionTick(runId);
    if (!published) {
      throw new Error("Publication du tick refusée (file non configurée ou origine non résolue).");
    }
  } catch (error) {
    // La mission n'a AUCUN worker derrière : libérer le loyer et figer la
    // location (status « failed ») — jamais de fonds bloqués sans mission.
    await releaseReservation({ userId: tenantId, reference, reservedMinor: priceMinor }).catch(() => undefined);
    try {
      await adminDb.collection(HIRES_COLLECTION).doc(hireId).set(
        { status: "failed", error: "File de missions indisponible — loyer restitué.", settledAtMs: Date.now() },
        { merge: true },
      );
    } catch (markError) {
      console.error("[marketplace/hire] marquage « failed » de la location impossible :", markError instanceof Error ? markError.message : markError);
    }
    await markMissionEnqueueFailed(runId, error).catch(() => undefined);
    console.error("[marketplace/hire] enfilement impossible (loyer restitué) :", error instanceof Error ? error.message : error);
    return { error: "File de missions indisponible : la location n'a pas pu être lancée et le loyer a été restitué.", status: 503 };
  }

  return { hireId, runId, executionId, priceMinor };
}

/* ------------------------------------------------------------------ */
/* Règlement au tick final                                             */
/* ------------------------------------------------------------------ */

export type SettleOutcome = "captured" | "released" | "skipped";

/**
 * RÈGLEMENT DE LA LOCATION au tick final (hook mission-tick, FAIL-SOFT TOTAL) :
 *  - mission « completed » → loyer capturé (settleReservation) puis SCINDÉ :
 *    commission plateforme (computeRevenueSplit) + gain du propriétaire
 *    (applyEarning, idempotent par doc-ID `earning_hire_<hireId>`) ;
 *    stats listing (hires) incrémentées DANS la transaction qui fige le hire
 *    (CAS : jamais de double comptage sous redélivrance QStash) ;
 *  - mission « failed »/« cancelled » → loyer LIBÉRÉ (releaseReservation),
 *    hire « failed » (mission échouée) ou « released » (annulée) ;
 *  - statuts non terminaux (queued/running/paused) → « skipped » (le tick
 *    final décidera) ;
 *  - mapping absent (mission ORDINAIRE hors marketplace — CAS GÉNÉRAL) →
 *    « skipped » immédiat (un seul GET, rapide) ;
 *  - hire déjà terminal → « skipped » (IDEMPOTENCE : une redélivrance ne
 *    re-capture jamais un loyer déjà réglé ; le wallet est de toute façon
 *    idempotent par doc-ID ledger).
 *
 * Ne lève JAMAIS vers mission-tick : tout incident est journalisé et
 * retenté au tick suivant (les montants ne bougent qu'une fois, par doc-ID).
 */
export async function settleAgentHireByExecution(params: {
  executionId: string;
  missionStatus: string;
}): Promise<SettleOutcome> {
  const executionId = params.executionId?.trim();
  if (!executionId) return "skipped";
  try {
    // Chemin rapide : la quasi-totalité des missions (hors marketplace) n'a
    // pas de mapping — un seul GET puis sortie.
    const mapSnap = await adminDb.collection(HIRE_BY_EXECUTION_COLLECTION).doc(executionId).get();
    if (!mapSnap.exists) return "skipped";
    const mappingRaw = mapSnap.data() as Partial<HireByExecutionDoc> | undefined;
    const hireId = typeof mappingRaw?.hireId === "string" ? mappingRaw.hireId : "";
    const listingId = typeof mappingRaw?.listingId === "string" ? mappingRaw.listingId : "";
    const tenantId = typeof mappingRaw?.tenantId === "string" ? mappingRaw.tenantId : "";
    const ownerId = typeof mappingRaw?.ownerId === "string" ? mappingRaw.ownerId : "";
    if (!hireId || !tenantId || !ownerId) return "skipped";

    const hireRef = adminDb.collection(HIRES_COLLECTION).doc(hireId);
    const hireSnap = await hireRef.get();
    const hire = (hireSnap.exists ? (hireSnap.data() as Record<string, unknown> | undefined) : undefined) ?? {};
    const hireStatus = typeof hire.status === "string" ? hire.status : "";
    // IDEMPOTENCE : déjà réglé (ou jamais réellement réservé) → rien à faire.
    if (hireStatus !== "held") return "skipped";

    const priceMinor = Math.floor(Number(hire.priceMinor ?? mappingRaw?.priceMinor ?? 0));
    const commissionBps = Math.max(
      0,
      Math.min(MAX_MARKETPLACE_FEE_BPS, Math.floor(Number(hire.commissionBps ?? mappingRaw?.commissionBps ?? DEFAULT_MARKETPLACE_FEE_BPS))),
    );
    const reference = hireReference(hireId);
    const metadata = {
      kind: "marketplace_hire",
      listingId: listingId || String(hire.listingId ?? ""),
      hireId,
    };

    if (params.missionStatus !== "completed" && params.missionStatus !== "failed" && params.missionStatus !== "cancelled") {
      // Statut non terminal (paused/queued/running) : décision reportée.
      return "skipped";
    }

    if (params.missionStatus === "completed") {
      if (priceMinor <= 0) {
        // Rien à régler (montant invalide) : figer le hire sans débit.
        await hireRef.set({ status: "failed", error: "Montant de location invalide — rien n'a été débité.", settledAtMs: Date.now() }, { merge: true });
        return "skipped";
      }
      // 1) Capture du loyer (idempotent par doc-ID settlement_hire_<hireId>).
      await settleReservation({
        userId: tenantId,
        reference,
        reservedMinor: priceMinor,
        actualChargeMinor: priceMinor,
        metadata,
      });
      // 2) SCINDE : commission plateforme / net propriétaire.
      const split = computeRevenueSplit(priceMinor, commissionBps);
      if (split.netAmountMinor > 0) {
        await applyEarning({
          userId: ownerId,
          amountMinor: split.netAmountMinor,
          reference,
          metadata: { ...metadata, feeMinor: String(split.feeMinor) },
        });
      }
      // 3) Fige le hire (CAS « held ») + incrément des stats listing dans la
      //    MÊME transaction — exactement-une-fois sous redélivrance.
      await adminDb.runTransaction(async (tx) => {
        const snap = await tx.get(hireRef);
        const data = (snap.exists ? (snap.data() as Record<string, unknown> | undefined) : undefined) ?? {};
        if (typeof data.status === "string" && data.status !== "held") return;
        tx.set(hireRef, { status: "completed", settledAtMs: Date.now() }, { merge: true });
        if (listingId) {
          const listingRef = adminDb.collection("agentListings").doc(listingId);
          const listingSnap = await tx.get(listingRef);
          if (listingSnap.exists) {
            const listingData = (listingSnap.data() ?? {}) as { stats?: { hires?: unknown; ratingSum?: unknown; ratingCount?: unknown } };
            tx.set(listingRef, {
              stats: {
                hires: Number(listingData.stats?.hires ?? 0) + 1,
                ratingSum: Number(listingData.stats?.ratingSum ?? 0),
                ratingCount: Number(listingData.stats?.ratingCount ?? 0),
              },
              updatedAtMs: Date.now(),
            }, { merge: true });
          }
        }
      });
      return "captured";
    }

    // Échec / annulation : le loyer est LIBÉRÉ (idempotent par doc-ID
    // release_hire_<hireId>) et le hire figé (« failed » = mission échouée,
    // « released » = annulée avant achèvement).
    if (priceMinor > 0) {
      await releaseReservation({ userId: tenantId, reference, reservedMinor: priceMinor });
    }
    const nextStatus = params.missionStatus === "cancelled" ? "released" : "failed";
    await hireRef.set(
      {
        status: nextStatus,
        settledAtMs: Date.now(),
        error: `Mission ${params.missionStatus} — loyer restitué.`.slice(0, 2_000),
      },
      { merge: true },
    );
    return "released";
  } catch (error) {
    // FAIL-SOFT : un incident (wallet, r2fs, contention CAS) ne remonte
    // JAMAIS au tick — les opérations idempotentes seront retentées au
    // prochain passage sans doubler le moindre montant.
    console.error(
      "[marketplace/hire] règlement de la location non appliqué (fail-soft) :",
      error instanceof Error ? error.message : error,
    );
    return "skipped";
  }
}

/* ------------------------------------------------------------------ */
/* Lectures (« mes locations »)                                        */
/* ------------------------------------------------------------------ */

function parseHireDoc(id: string, data: Record<string, unknown> | undefined): AgentHire | null {
  if (!data) return null;
  const parsed = AgentHireSchema.safeParse({
    ...data,
    hireId: typeof data.hireId === "string" && data.hireId ? data.hireId : id,
  });
  return parsed.success ? parsed.data : null;
}

/** Locations PASSÉES par le locataire (tous statuts). */
export async function listTenantHires(tenantId: string, limit = 50): Promise<AgentHire[]> {
  if (!tenantId?.trim()) return [];
  const snap = await adminDb
    .collection(HIRES_COLLECTION)
    .where("tenantId", "==", tenantId)
    .limit(Math.min(Math.max(1, limit), SCAN_CAP))
    .get();
  return snap.docs
    .map((doc) => parseHireDoc(doc.id, doc.data() as Record<string, unknown> | undefined))
    .filter((hire): hire is AgentHire => hire !== null)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** Locations REÇUES par le propriétaire (tous statuts). */
export async function listOwnerHires(ownerId: string, limit = 50): Promise<AgentHire[]> {
  if (!ownerId?.trim()) return [];
  const snap = await adminDb
    .collection(HIRES_COLLECTION)
    .where("ownerId", "==", ownerId)
    .limit(Math.min(Math.max(1, limit), SCAN_CAP))
    .get();
  return snap.docs
    .map((doc) => parseHireDoc(doc.id, doc.data() as Record<string, unknown> | undefined))
    .filter((hire): hire is AgentHire => hire !== null)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);
}
