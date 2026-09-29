import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { listMemories } from "./user-memory";
import { exportFeedbackData, purgeFeedbackData } from "@/lib/ai/feedback";
import { exportToolConsents, purgeToolConsents } from "@/lib/security/tool-consents";

/**
 * VIE PRIVÉE — MÉMOIRE LONGUE DURÉE (Task 42, axe 6).
 *
 * La mémoire personnalisée n'est utile que si l'utilisateur en garde le
 * contrôle. Ce module fournit les trois droits fondamentaux :
 *
 *   1. PORTABILITÉ  : exportUserData — tout ce que Gen3ia retient sur ce
 *      compte (souvenirs, retours IA, leçons, consentements) dans un JSON
 *      portable, horodaté, auto-descriptif.
 *   2. EFFACEMENT   : purgeUserData — suppression irréversible et complète
 *      (souvenirs + retours + leçons + consentements + drapeau de
 *      consentement). Les contenus de conversations restent gouvernés par
 *      leurs propres surfaces (hors périmètre mémoire).
 *   3. CONSENTEMENT : memoryConsent — drapeau explicite d'utilisation de la
 *      mémoire personnalisée ; les surfaces de lecture mémoire doivent le
 *      respecter (défaut : consenti — comportement historique — mais
 *      révocable à tout moment).
 *
 * Sécurité : chaque fonction opère STRICTEMENT sur le userId authentifié ;
 * la purge exige le drapeau `confirm: true` côté appelant (double
 * validation applicative en plus de l'UI).
 */

const PRIVACY_COLLECTION = "userPrivacy";

export interface MemoryConsentState {
  /** La mémoire personnalisée peut-elle être lue pour personnaliser les réponses ? */
  memoryProcessing: boolean;
  updatedAtMs: number | null;
}

export async function getMemoryConsent(userId: string): Promise<MemoryConsentState> {
  if (!userId?.trim()) return { memoryProcessing: true, updatedAtMs: null };
  try {
    const snap = await adminDb.collection(PRIVACY_COLLECTION).doc(userId).get();
    if (!snap.exists) return { memoryProcessing: true, updatedAtMs: null };
    const updatedAt = snap.get("updatedAt");
    return {
      memoryProcessing: snap.get("memoryProcessing") !== false,
      updatedAtMs: typeof updatedAt?.toMillis === "function" ? updatedAt.toMillis() : null,
    };
  } catch {
    return { memoryProcessing: true, updatedAtMs: null };
  }
}

export async function setMemoryConsent(userId: string, memoryProcessing: boolean): Promise<MemoryConsentState> {
  if (!userId?.trim()) throw new Error("Consent requires userId.");
  const { FieldValue } = await import("firebase-admin/firestore");
  await adminDb
    .collection(PRIVACY_COLLECTION)
    .doc(userId)
    .set({ userId, memoryProcessing, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { memoryProcessing, updatedAtMs: Date.now() };
}

/* ------------------------------------------------------------------ */
/* Export (portabilité)                                                */
/* ------------------------------------------------------------------ */

export interface MemoryExport {
  format: "gen3ia.memory-export";
  version: 1;
  exportedAt: string;
  userId: string;
  memories: Array<{ key: string; value: string; source: string; updatedAt?: string }>;
  aiFeedback: Awaited<ReturnType<typeof exportFeedbackData>>["feedback"];
  aiFeedbackLessons: Awaited<ReturnType<typeof exportFeedbackData>>["lessons"];
  toolConsents: Record<string, string>;
}

export async function exportUserData(userId: string): Promise<MemoryExport> {
  const [memories, feedback, toolConsents] = await Promise.all([
    listMemories(userId, 200),
    exportFeedbackData(userId),
    exportToolConsents(userId),
  ]);
  return {
    format: "gen3ia.memory-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    userId,
    memories,
    aiFeedback: feedback.feedback,
    aiFeedbackLessons: feedback.lessons,
    toolConsents: toolConsents as Record<string, string>,
  };
}

/* ------------------------------------------------------------------ */
/* Purge (effacement)                                                  */
/* ------------------------------------------------------------------ */

export interface PurgeReport {
  memoriesDeleted: number;
  feedbackAndLessonsDeleted: number;
  toolConsentsDeleted: boolean;
  consentReset: boolean;
}

export async function purgeUserData(userId: string): Promise<PurgeReport> {
  if (!userId?.trim()) throw new Error("Purge requires userId.");

  // Souvenirs : suppression par lots de 300 (limite transactionnelle
  // confortable), bouclée jusqu'à épuisement.
  let memoriesDeleted = 0;
  for (;;) {
    const snap = await adminDb
      .collection("userMemories")
      .where("userId", "==", userId)
      .limit(300)
      .get();
    if (snap.empty) break;
    const batch = adminDb.batch();
    for (const doc of snap.docs) batch.delete(doc.ref);
    await batch.commit();
    memoriesDeleted += snap.size;
    if (snap.size < 300) break;
  }

  const feedbackAndLessonsDeleted = await purgeFeedbackData(userId);
  await purgeToolConsents(userId);

  // Réinitialisation du drapeau de consentement (état par défaut) après
  // purge — le compte repart sur les réglages d'usine.
  await adminDb.collection(PRIVACY_COLLECTION).doc(userId).delete().catch(() => undefined);

  return {
    memoriesDeleted,
    feedbackAndLessonsDeleted,
    toolConsentsDeleted: true,
    consentReset: true,
  };
}
