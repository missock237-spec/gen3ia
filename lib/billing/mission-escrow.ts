import { adminDb } from "@/lib/firebase/admin";

import { reserveFunds, releaseReservation, settleReservation } from "./wallet";

/**
 * ESCROW DE MISSION (V2 « Résultat en tant que Produit » — Task 114-a).
 *
 * Chaque mission lancée RÉSERVE un frais de résultat (resultFee, XAF minor)
 * sur le portefeuille de l'utilisateur AU MOMENT DU LANCEMENT :
 *  - mission « completed » → le frais est CAPTURÉ (settle de la réservation) ;
 *  - mission « failed » / « cancelled » → le frais est LIBÉRÉ (release) ;
 *  - mission « paused » / « queued » / « running » → rien (décision reportée
 *    au tick final qui verra un statut terminal) ;
 *  - hold resté « held » au-delà du TTL → libéré par le reaper quotidien
 *    (releaseExpiredEscrows, branché sur le cron agent-schedules).
 *
 * PRIMITIVES (lib/billing/wallet.ts, NON modifiées) : reserveFunds /
 * settleReservation / releaseReservation — idempotence par doc-ID ledger
 * (reservation_/settlement_/release_ + référence canonique `escrow_<executionId>`).
 *
 * Un REGISTRE requêtable `walletHolds/{executionId}` décrit chaque hold
 * (état, montant, TTL) : c'est lui qui pilote la décision de capture et la
 * purge TTL. Les missions SANS registre (escrow désactivé à leur lancement,
 * infra en panne) sont rattrapées à la capture : le frais courant est réglé
 * directement via le couple reserve+settle sur la MÊME référence (idempotent).
 *
 * FAIL-SOFT TOTAL : aucune fonction I/O ne lève vers l'appelant — un échec
 * d'escrow ne doit JAMAIS bloquer une mission, sa livraison ou son avoir.
 * Les fonctions de DÉCISION (missionResultFeeMinor, decideEscrowAction)
 * sont PURES et testées sans dépendance.
 */

const HOLDS_COLLECTION = "walletHolds";
const ESCROW_METADATA_KIND = "mission_escrow";

/** Frais de résultat par défaut : 5 000 minor = 50 FCFA. */
const DEFAULT_FEE_MINOR = 5000;
/** Plafond par défaut du frais : 50 000 minor = 500 FCFA. */
const DEFAULT_FEE_CAP_MINOR = 50_000;
/** TTL par défaut d'un hold : 7 jours (purge par le cron quotidien). */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Nombre lu dans l'environnement (valeur absente/non numérique → repli). */
function envNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Frais de résultat d'une mission (XAF minor). PUR :
 *  - env GEN3IA_MISSION_RESULT_FEE_MINOR (défaut 5 000) ;
 *  - clamp ≥ 0 (0 = escrow désactivé) ;
 *  - plafond env GEN3IA_MISSION_RESULT_FEE_MAX_MINOR (défaut 50 000).
 */
export function missionResultFeeMinor(): number {
  const cap = Math.max(0, Math.floor(envNumber("GEN3IA_MISSION_RESULT_FEE_MAX_MINOR", DEFAULT_FEE_CAP_MINOR)));
  const raw = Math.max(0, Math.floor(envNumber("GEN3IA_MISSION_RESULT_FEE_MINOR", DEFAULT_FEE_MINOR)));
  return Math.min(raw, cap);
}

/** Durée de vie d'un hold (ms) — env GEN3IA_ESCROW_TTL_MS, défaut 7 jours. */
export function missionEscrowTtlMs(): number {
  return Math.max(0, Math.floor(envNumber("GEN3IA_ESCROW_TTL_MS", DEFAULT_TTL_MS)));
}

/** États du registre walletHolds. */
export type MissionEscrowState = "held" | "captured" | "released" | "skipped";

export interface MissionEscrowDecision {
  action: "capture" | "release" | "skip";
  reason: string;
}

/**
 * Décision PURE de capture/libération (testée sans dépendance) :
 *  - capture : statut « completed » ET hold actif (registre « held » ou
 *    ABSENT — les missions sans registre sont rattrapées) ;
 *  - release : statut « failed »/« cancelled » ET hold « held » ;
 *  - skip : tout le reste (déjà capturé/libéré, statut non terminal, ou
 *    échec sans hold existant).
 */
export function decideEscrowAction(input: { holdState?: string; missionStatus: string }): MissionEscrowDecision {
  const hold = typeof input.holdState === "string" && input.holdState ? input.holdState : undefined;
  const holdActive = hold === undefined || hold === "held";
  if (input.missionStatus === "completed") {
    if (holdActive) {
      return {
        action: "capture",
        reason: hold === undefined
          ? "Mission réussie sans registre : frais réglé en rattrapage."
          : "Mission réussie : frais de résultat capturé.",
      };
    }
    return { action: "skip", reason: `Hold déjà traité (${hold}) : capture ignorée (idempotence).` };
  }
  if (input.missionStatus === "failed" || input.missionStatus === "cancelled") {
    if (hold === "held") {
      return { action: "release", reason: `Mission ${input.missionStatus} : frais de résultat libéré.` };
    }
    return {
      action: "skip",
      reason: hold === undefined
        ? `Mission ${input.missionStatus} sans hold : rien à libérer.`
        : `Hold déjà traité (${hold}) : libération ignorée (idempotence).`,
    };
  }
  return { action: "skip", reason: `Statut non terminal (${input.missionStatus}) : décision reportée.` };
}

/** Référence canonique du hold d'une exécution (doc-ID ledger idempotents). */
function escrowReference(executionId: string): string {
  return `escrow_${executionId}`;
}

function isInsufficientFundsMessage(message: string): boolean {
  return /insufficient wallet balance|balance is 0/i.test(message);
}

/** Document du registre walletHolds. */
interface EscrowHoldDoc {
  executionId: string;
  userId: string;
  runId?: string;
  reference: string;
  state: MissionEscrowState;
  amountMinor: number;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  capturedAtMs?: number;
  releasedAtMs?: number;
  missionStatus?: string;
}

export interface MissionEscrowReservation {
  ok: boolean;
  holdMinor?: number;
  reason?: string;
}

/**
 * RÉSERVE le frais de résultat au lancement d'une mission.
 * Jamais de throw : fonds insuffisants → { ok:false, reason:"insufficient_funds" }
 * (l'appelant refuse de créer la mission) ; panne d'infrastructure →
 * { ok:true, holdMinor:0 } (la mission démarre — la capture rattrapera le
 * frais au réel si elle réussit).
 */
export async function reserveMissionEscrow(params: {
  userId: string;
  executionId: string;
  runId?: string;
}): Promise<MissionEscrowReservation> {
  if (!params.userId?.trim() || !params.executionId?.trim()) {
    return { ok: false, reason: "Paramètres d'escrow invalides (userId/executionId requis)." };
  }
  const fee = missionResultFeeMinor();
  if (fee <= 0) {
    return { ok: true, holdMinor: 0, reason: "Escrow désactivé (frais de résultat nul)." };
  }
  const reference = escrowReference(params.executionId);
  try {
    await reserveFunds({
      userId: params.userId,
      amountMinor: fee,
      reference,
      metadata: { kind: ESCROW_METADATA_KIND, ...(params.runId ? { runId: params.runId } : {}) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInsufficientFundsMessage(message)) {
      return { ok: false, reason: "insufficient_funds" };
    }
    console.error("[mission-escrow] réservation indisponible (fail-soft) :", message);
    return { ok: true, holdMinor: 0, reason: "Réservation indisponible (fail-soft) : capture en rattrapage prévue." };
  }
  const now = Date.now();
  try {
    await adminDb.collection(HOLDS_COLLECTION).doc(params.executionId).set(
      {
        executionId: params.executionId,
        userId: params.userId,
        ...(params.runId ? { runId: params.runId } : {}),
        reference,
        state: "held" satisfies MissionEscrowState,
        amountMinor: fee,
        createdAtMs: now,
        expiresAtMs: now + missionEscrowTtlMs(),
        updatedAtMs: now,
      } satisfies EscrowHoldDoc,
      { merge: true },
    );
  } catch (error) {
    // Le hold WALLET est pris (ledger idempotent) ; le registre est
    // secondaire — la capture rattrape via la référence canonique.
    console.error("[mission-escrow] registre walletHolds non écrit (fail-soft) :", error instanceof Error ? error.message : error);
  }
  return { ok: true, holdMinor: fee };
}

export interface MissionEscrowCaptureResult {
  action: MissionEscrowState;
  reason?: string;
}

function metadataFor(params: { missionStatus: string; runId?: string; mode?: string }): Record<string, string> {
  return {
    kind: ESCROW_METADATA_KIND,
    missionStatus: params.missionStatus.slice(0, 40),
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

/**
 * Rattrapage SANS registre : le frais courant est réglé directement via le
 * couple reserve+settle sur la référence canonique (idempotent par doc-ID
 * ledger — un règlement déjà écrit ne se rejoue jamais). Si le règlement
 * échoue après la réservation, la réservation est libérée (jamais de fond
 * bloqué par un hold fantôme).
 */
async function reglerFraisEnRattrapage(params: {
  userId: string;
  executionId: string;
  amountMinor: number;
  metadata: Record<string, string>;
}): Promise<void> {
  const reference = escrowReference(params.executionId);
  await reserveFunds({
    userId: params.userId,
    amountMinor: params.amountMinor,
    reference,
    metadata: params.metadata,
  });
  try {
    await settleReservation({
      userId: params.userId,
      reference,
      reservedMinor: params.amountMinor,
      actualChargeMinor: params.amountMinor,
      metadata: params.metadata,
    });
  } catch (error) {
    await releaseReservation({ userId: params.userId, reference, reservedMinor: params.amountMinor }).catch(() => undefined);
    throw error;
  }
}

/**
 * CAPTURE (mission réussie) ou LIBÈRE (mission échouée) le frais de résultat.
 * Décision via decideEscrowAction (registre walletHolds lu au moment T),
 * tolère un settle/release déjà fait (idempotence wallet), FAIL-SOFT total :
 * ne lève JAMAIS, ne bloque jamais la livraison de la mission.
 */
export async function captureMissionEscrow(params: {
  userId: string;
  executionId: string;
  missionStatus: string;
  runId?: string;
}): Promise<MissionEscrowCaptureResult> {
  try {
    const holdRef = adminDb.collection(HOLDS_COLLECTION).doc(params.executionId);
    const snap = await holdRef.get();
    const doc = snap.exists ? (snap.data() as Partial<EscrowHoldDoc> | undefined) : undefined;
    const decision = decideEscrowAction({ holdState: doc?.state, missionStatus: params.missionStatus });

    if (decision.action === "skip") {
      const state = doc?.state === "captured" ? "captured" : doc?.state === "released" ? "released" : "skipped";
      return { action: state, reason: decision.reason };
    }

    if (decision.action === "release") {
      const amountMinor = Math.floor(Number(doc?.amountMinor ?? 0));
      const reference = typeof doc?.reference === "string" && doc.reference ? doc.reference : escrowReference(params.executionId);
      if (amountMinor > 0) {
        await releaseReservation({ userId: params.userId, reference, reservedMinor: amountMinor });
      }
      await holdRef.set(
        {
          state: "released" satisfies MissionEscrowState,
          releasedAtMs: Date.now(),
          missionStatus: params.missionStatus.slice(0, 40),
          updatedAtMs: Date.now(),
        },
        { merge: true },
      );
      return { action: "released", reason: decision.reason };
    }

    // ── CAPTURE ────────────────────────────────────────────────────────
    if (doc) {
      const amountMinor = Math.floor(Number(doc.amountMinor ?? 0));
      if (amountMinor <= 0) {
        return { action: "skipped", reason: "Hold sans montant exploitable : capture ignorée." };
      }
      await settleReservation({
        userId: params.userId,
        reference: typeof doc.reference === "string" && doc.reference ? doc.reference : escrowReference(params.executionId),
        reservedMinor: amountMinor,
        actualChargeMinor: amountMinor,
        metadata: metadataFor(params),
      });
      await holdRef.set(
        {
          state: "captured" satisfies MissionEscrowState,
          capturedAtMs: Date.now(),
          missionStatus: params.missionStatus.slice(0, 40),
          updatedAtMs: Date.now(),
        },
        { merge: true },
      );
      return { action: "captured", reason: decision.reason };
    }

    // Registre absent (mission lancée sans escrow) : rattrapage au frais
    // courant — uniquement si l'escrow est ACTIF (frais > 0).
    const fee = missionResultFeeMinor();
    if (fee <= 0) {
      return { action: "skipped", reason: "Escrow désactivé (frais de résultat nul)." };
    }
    await reglerFraisEnRattrapage({
      userId: params.userId,
      executionId: params.executionId,
      amountMinor: fee,
      metadata: metadataFor({ ...params, mode: "catchup" }),
    });
    const now = Date.now();
    await holdRef.set(
      {
        executionId: params.executionId,
        userId: params.userId,
        ...(params.runId ? { runId: params.runId } : {}),
        reference: escrowReference(params.executionId),
        state: "captured" satisfies MissionEscrowState,
        amountMinor: fee,
        createdAtMs: now,
        expiresAtMs: now,
        updatedAtMs: now,
        capturedAtMs: now,
        missionStatus: params.missionStatus.slice(0, 40),
      } satisfies EscrowHoldDoc,
      { merge: true },
    );
    return { action: "captured", reason: decision.reason };
  } catch (error) {
    // Idempotence/fail-soft : un settle/release déjà joué (conflit ledger,
    // course concurrente) ou une panne d'infrastructure ne remontent JAMAIS.
    console.error(
      "[mission-escrow] capture/libération non appliquée (fail-soft) :",
      error instanceof Error ? error.message : error,
    );
    return { action: "skipped", reason: "Escrow indisponible (erreur d'infrastructure) — décision reportée." };
  }
}

/**
 * REAPER TTL : libère les holds encore « held » au-delà de leur expiration
 * (mission disparue, worker tué avant finalisation, bug de parcours).
 * Retourne le nombre de holds libérés. Fail-soft : un hold en échec est
 * journalisé et retenté au prochain passage.
 */
export async function releaseExpiredEscrows(limit = 50): Promise<number> {
  let released = 0;
  try {
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    const snap = await adminDb.collection(HOLDS_COLLECTION).where("state", "==", "held").limit(capped).get();
    const now = Date.now();
    for (const docSnap of snap.docs) {
      try {
        const data = docSnap.data() as Partial<EscrowHoldDoc> | undefined;
        if (!data || data.state !== "held") continue;
        const expiresAtMs = Number(data.expiresAtMs ?? 0);
        if (!(expiresAtMs > 0) || expiresAtMs > now) continue;
        const userId = typeof data.userId === "string" ? data.userId : "";
        const reference = typeof data.reference === "string" && data.reference ? data.reference : "";
        const amountMinor = Math.floor(Number(data.amountMinor ?? 0));
        if (userId && reference && amountMinor > 0) {
          await releaseReservation({ userId, reference, reservedMinor: amountMinor });
        }
        await adminDb.collection(HOLDS_COLLECTION).doc(docSnap.id).set(
          {
            state: "released" satisfies MissionEscrowState,
            releasedAtMs: now,
            missionStatus: "expired",
            updatedAtMs: now,
          },
          { merge: true },
        );
        released += 1;
      } catch (error) {
        console.error("[mission-escrow] purge TTL d'un hold impossible (retenté au prochain passage) :", error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.error("[mission-escrow] purge TTL indisponible (fail-soft) :", error instanceof Error ? error.message : error);
  }
  return released;
}
