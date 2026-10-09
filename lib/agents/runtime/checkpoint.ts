import {
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { RuntimeExecutionState } from "./types";

/**
 * Checkpoints runtime (collection `executions`) — source de vérité du
 * TRAVAIL (étapes, sorties, reprise). Task 110-d : chaque touche Firestore
 * passe par runFirestoreGuarded (deadline anti-stall 6 s + disjoncteur
 * quota). Cause racine 110-d : `createCheckpoint` (appelé par
 * AgentRuntime.run() AVANT toute exécution) et `loadCheckpoint` (tick) étaient
 * des appels Firestore BRUTS — sous quota Firestore, le premier pend jusqu'au
 * timeout de la fonction (écritures muettes, Task 97) et la seconde meurt
 * dans le tick : la mission ne démarre jamais ou fantomise, pendant que le
 * chat (R2) répond encore.
 *
 * Sémantiques conservées :
 *  - saveCheckpoint lève (quota-classifié, ≤ 6 s) — le runner l'absorbe en
 *    fail-soft (persistCheckpoint) : un checkpoint manquant ne condamne
 *    JAMAIS un travail déjà réussi ;
 *  - createCheckpoint / loadCheckpoint lèvent (quota-classifié, ≤ 6 s) —
 *    l'échec est HONNÊTE et rapide (503 actionnable côté chat, 500
 *    redélivrance QStash côté tick) au lieu d'un fantôme.
 */

function executionRef(executionId: string) {
  return adminDb
    .collection("executions")
    .doc(executionId);
}

export async function saveCheckpoint(
  state: RuntimeExecutionState,
): Promise<void> {
  await runFirestoreGuarded(`save executions/${state.executionId}`, () => executionRef(state.executionId).set(
    {
      ...state,
      updatedAt: FieldValue.serverTimestamp(),
    },
    {
      merge: true,
    },
  ));
}

export async function loadCheckpoint(
  executionId: string,
): Promise<RuntimeExecutionState | null> {
  const snapshot =
    await runFirestoreGuarded(`load executions/${executionId}`, () => executionRef(executionId).get());

  if (!snapshot.exists) {
    return null;
  }

  return snapshot.data() as RuntimeExecutionState;
}

export async function createCheckpoint(
  state: RuntimeExecutionState,
): Promise<void> {
  await runFirestoreGuarded(`create executions/${state.executionId}`, () => executionRef(state.executionId).set({
    ...state,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  }));
}
