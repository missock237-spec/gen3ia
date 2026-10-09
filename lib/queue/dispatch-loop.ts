import "server-only";

import { FieldValue } from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";

/**
 * Boucle de dispatch planifié auto-perpétuelle (Task 62 — priorité #5,
 * file d'attente managée pour l'exécution des planifications).
 *
 * PROBLÈME : la route /api/cron/agent-schedules est conçue pour une cadence
 * 5 minutes (claims transactionnels par slot de 5 min dans le scheduler),
 * mais Vercel plan Hobby n'autorise qu'un cron QUOTIDIEN (vercel.json
 * `0 6 * * *`) — les agents planifiés ne s'exécutaient qu'une fois par jour.
 * L'API Schedules de la build QStash de ce compte est inutilisable
 * (destination lue dans le path, corps ignoré — vérifié en sondes réelles).
 *
 * SOLUTION : une boucle de ticks QStash auto-perpétuelle. Chaque tick du
 * slot S exécute le dispatch (idempotent par claims transactionnels du
 * scheduler) puis publie le tick du slot S+1 avec un délai QStash calé sur
 * la frontière de slot. Le cron Vercel quotidien sert de sentinelle de
 * résurrection : il publie un tick si le prochain slot n'a pas encore été
 * programmé — la boucle ne peut jamais rester morte plus de 24 h.
 *
 * EXACTEMENT-UN SUCCESSEUR (sans dédup QStash — absente de cette build,
 * vérifié en sondes) : la publication du successeur est contrôlée par un
 * document Firestore `dispatchLoop/control` écrit en TRANSACTION :
 *  - `publishedSlotEpoch` : dernier slot dont le tick a ÉTÉ publié ;
 *  - `publishingSlotEpoch`/`publishingAtMs` : réservation pendant l'appel
 *    réseau (libérée après succès, ou après 60 s de staleness — kill
 *    plateforme pendant le publish).
 * Deux ticks concurrents pour le même slot : la transaction sérialise, un
 * seul publish. Un publish échoué : réservation libérée + le tick répond
 * 5xx → QStash redélivre le tick → retry du publish. Un tick killé pendant
 * le publish : réservation expirée par staleness → le cron quotidien
 * (sentinelle) repart proprement.
 */

const COLLECTION = "dispatchLoop";
const CONTROL_DOC = "control";

/** Durée d'un slot de dispatch — alignée sur les claims du scheduler. */
export const DISPATCH_SLOT_MS = 5 * 60 * 1000;

/** Âge maximal d'une réservation de publish avant qu'elle soit reprise. */
const PUBLISH_RESERVATION_MS = 60_000;

interface DispatchControl {
  publishedSlotEpoch: number;
  publishingSlotEpoch: number | null;
  publishingAtMs: number | null;
}

/** Slot (époques de 5 min) couvrant l'instant donné. */
export function slotFor(nowMs: number): number {
  return Math.floor(nowMs / DISPATCH_SLOT_MS);
}

function controlRef() {
  return adminDb.collection(COLLECTION).doc(CONTROL_DOC);
}

export type ScheduleNextTickOutcome =
  | { kind: "published"; slotEpoch: number; delaySeconds: number }
  | { kind: "already-scheduled"; slotEpoch: number }
  | { kind: "publish-conflict"; slotEpoch: number }
  | { kind: "publish-failed"; slotEpoch: number; error: string };
/**
 * Programme (exactement une fois) le tick du slot SUIVANT du slot donné,
 * via QStash. Réservation transactionnelle AVANT l'appel réseau, écriture
 * du succès APRÈS. `publish` est injecté (testabilité) — c'est
 * publishDispatchTick en production.
 */
export async function scheduleNextDispatchTick(
  origin: string,
  fromSlotEpoch: number,
  nowMs: number,
  publish: (options: { delaySeconds: number; slotEpoch: number }) => Promise<{ messageId: string } | null>,
): Promise<ScheduleNextTickOutcome> {
  const nextSlot = Math.max(fromSlotEpoch + 1, slotFor(nowMs) + 1);
  const delaySeconds = Math.max(1, Math.round((nextSlot * DISPATCH_SLOT_MS - nowMs) / 1000) + 2);

  // 1) Réservation transactionnelle : un seul publish par slot, jamais un double.
  let reserved = false;
  let alreadyScheduled = false;
  await adminDb.runTransaction(async (tx) => {
    const ref = controlRef();
    const snap = await tx.get(ref);
    const data = (snap.data() ?? {}) as Partial<DispatchControl>;
    const published = typeof data.publishedSlotEpoch === "number" ? data.publishedSlotEpoch : -1;
    if (published >= nextSlot) {
      // Déjà programmé par un concurrent (no-op bénin) — exactement-once.
      alreadyScheduled = true;
      return;
    }
    const publishing = typeof data.publishingSlotEpoch === "number" ? data.publishingSlotEpoch : null;
    const publishingAt = typeof data.publishingAtMs === "number" ? data.publishingAtMs : 0;
    if (publishing !== null && publishing >= nextSlot && nowMs - publishingAt < PUBLISH_RESERVATION_MS) {
      // Réservation vivante d'un publish concurrent : conflit transitoire.
      return;
    }
    tx.set(ref, {
      publishingSlotEpoch: nextSlot,
      publishingAtMs: nowMs,
      updatedAtMs: nowMs,
    }, { merge: true });
    reserved = true;
  });

  if (!reserved) {
    return alreadyScheduled
      ? { kind: "already-scheduled", slotEpoch: nextSlot }
      : { kind: "publish-conflict", slotEpoch: nextSlot };
  }

  // 2) Publish QStash (hors transaction).
  try {
    const result = await publish({ delaySeconds: delaySeconds, slotEpoch: nextSlot });
    if (!result) {
      // File non configurée : libère la réservation — rien n'est programmé.
      await clearReservation(nextSlot, nowMs);
      return { kind: "publish-conflict", slotEpoch: nextSlot };
    }
  } catch (error) {
    await clearReservation(nextSlot, nowMs);
    return { kind: "publish-failed", slotEpoch: nextSlot, error: error instanceof Error ? error.message : String(error) };
  }

  // 3) Succès : marque le slot comme publié et libère la réservation.
  await adminDb.runTransaction(async (tx) => {
    const ref = controlRef();
    const snap = await tx.get(ref);
    const data = (snap.data() ?? {}) as Partial<DispatchControl>;
    const published = typeof data.publishedSlotEpoch === "number" ? data.publishedSlotEpoch : -1;
    tx.set(ref, {
      publishedSlotEpoch: Math.max(published, nextSlot),
      publishingSlotEpoch: FieldValue.delete(),
      publishingAtMs: FieldValue.delete(),
      updatedAtMs: Date.now(),
    }, { merge: true });
  });

  return { kind: "published", slotEpoch: nextSlot, delaySeconds };
}

async function clearReservation(slotEpoch: number, nowMs: number): Promise<void> {
  await adminDb.runTransaction(async (tx) => {
    const ref = controlRef();
    const snap = await tx.get(ref);
    const data = (snap.data() ?? {}) as Partial<DispatchControl>;
    if (data.publishingSlotEpoch !== slotEpoch) return; // une autre réservation a pris le relais.
    tx.set(ref, {
      publishingSlotEpoch: FieldValue.delete(),
      publishingAtMs: FieldValue.delete(),
      updatedAtMs: nowMs,
    }, { merge: true });
  });
}
