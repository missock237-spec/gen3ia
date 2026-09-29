import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";

/**
 * BOUCLE DE FEEDBACK UTILISATEUR → APPRENTISSAGE CONTINU SÛR
 * (Task 42, axe 2).
 *
 * Les retours 👍/👎 sur les réponses de l'agent alimentent un registre de
 * leçons PAR CATÉGORIE avec pipeline de validation :
 *   - 1er retour négatif  → leçon « proposée » (non injectée) ;
 *   - 2e retour négatif de même catégorie (même utilisateur ou conversation
 *     différente) → leçon « active », injectée dans le contexte de
 *     planification (auto-amélioration Gen IA).
 *
 * Pourquoi ce seuil : un seul retour peut être une incompréhension ; deux
 * signaux concordants forment un pattern exploitable. Aucune leçon n'est
 * générée par le LLM — uniquement des formulations déterministes dérivées
 * du retour (anti-hallucination). Confidentialité : les retours sont
 * cloisonnés par utilisateur, jamais partagés entre comptes ; export et
 * purge RGPD exposés via lib/memory/privacy.ts.
 */

const FEEDBACK_COLLECTION = "aiFeedback";
const LESSONS_COLLECTION = "aiFeedbackLessons";

export type FeedbackRating = "up" | "down";

export type FeedbackCategory =
  | "hallucination"
  | "incorrect"
  | "incomplet"
  | "hors-sujet"
  | "style"
  | "autre";

export const FEEDBACK_CATEGORIES: readonly FeedbackCategory[] = [
  "hallucination",
  "incorrect",
  "incomplet",
  "hors-sujet",
  "style",
  "autre",
];

/** Seuil de confirmation avant qu'une leçon ne devienne active. */
export const LESSON_ACTIVATION_THRESHOLD = 2;

const LESSON_TEXTS: Record<FeedbackCategory, string> = {
  hallucination:
    "L'utilisateur a signalé des affirmations non fondées : n'avance AUCUN fait qui ne vient ni de la conversation, ni des sources fournies, ni d'un outil — signale explicitement l'incertitude.",
  incorrect:
    "Des réponses jugées incorrectes ont été signalées : vérifie les faits clés (relecture systématique avant de répondre) et corrige-toi explicitement en cas de doute.",
  incomplet:
    "Des réponses jugées incomplètes ont été signalées : couvre TOUTES les parties de la demande avant de conclure, et liste ce qui n'a pas été traité.",
  "hors-sujet":
    "Des réponses jugées hors-sujet ont été signalées : reformule le besoin dans ta réponse pour confirmer ta compréhension avant de développer.",
  style:
    "Le style des réponses a été signalé : privilégie la clarté, la concision et la structure demandée par l'utilisateur.",
  autre:
    "Des retours négatifs ont été signalés : demande une clarification plutôt que de deviner l'attente.",
};

export interface FeedbackInput {
  userId: string;
  conversationId: string;
  messageId: string;
  rating: FeedbackRating;
  category?: FeedbackCategory;
  reason?: string;
}

export interface LessonRecord {
  category: FeedbackCategory;
  status: "proposée" | "active";
  occurrences: number;
  updatedAtMs: number;
}

/* ------------------------------------------------------------------ */
/* Enregistrement d'un retour                                          */
/* ------------------------------------------------------------------ */

export async function recordFeedback(input: FeedbackInput): Promise<{ ok: true; lessonStatus: LessonRecord["status"] | null }> {
  const userId = input.userId?.trim();
  const conversationId = input.conversationId?.trim();
  const messageId = input.messageId?.trim();
  if (!userId || !conversationId || !messageId) throw new Error("Feedback requires userId, conversationId and messageId.");
  if (input.rating !== "up" && input.rating !== "down") throw new Error("Invalid rating.");
  const category: FeedbackCategory = input.category && FEEDBACK_CATEGORIES.includes(input.category) ? input.category : "autre";
  const reason = (input.reason ?? "").trim().slice(0, 600);

  // Garde-fou anti-abus : 60 retours / heure / utilisateur (au-delà : ignoré).
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await adminDb
    .collection(FEEDBACK_COLLECTION)
    .where("userId", "==", userId)
    .where("createdAt", ">", since)
    .count()
    .get();
  if (recent.data().count >= 60) throw new Error("Feedback rate limit reached.");

  await adminDb.collection(FEEDBACK_COLLECTION).add({
    userId,
    conversationId,
    messageId,
    rating: input.rating,
    category,
    reason,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Pipeline de validation : seuls les retours négatifs créent/confirment
  // une leçon (les positifs sont conservés comme signal de qualité).
  if (input.rating !== "down") return { ok: true, lessonStatus: null };

  const lessonRef = adminDb.collection(LESSONS_COLLECTION).doc(`${userId}_${category}`);
  let status: LessonRecord["status"] = "proposée";
  await adminDb.runTransaction(async (tx) => {
    const snap = await tx.get(lessonRef);
    const occurrences = Number(snap.get("occurrences") ?? 0) + 1;
    status = occurrences >= LESSON_ACTIVATION_THRESHOLD ? "active" : "proposée";
    tx.set(
      lessonRef,
      {
        userId,
        category,
        lessonText: LESSON_TEXTS[category],
        status,
        occurrences,
        updatedAtMs: Date.now(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });
  return { ok: true, lessonStatus: status };
}

/* ------------------------------------------------------------------ */
/* Lecture des leçons actives (injection dans la planification)         */
/* ------------------------------------------------------------------ */

export async function getActiveFeedbackLessons(userId: string, limit = 4): Promise<LessonRecord[]> {
  if (!userId?.trim()) return [];
  try {
    const snap = await adminDb
      .collection(LESSONS_COLLECTION)
      .where("userId", "==", userId)
      .where("status", "==", "active")
      .limit(Math.min(Math.max(limit, 1), 6))
      .get();
    return snap.docs
      .map((doc) => ({
        category: doc.get("category") as FeedbackCategory,
        status: "active" as const,
        occurrences: Number(doc.get("occurrences") ?? 0),
        updatedAtMs: Number(doc.get("updatedAtMs") ?? 0),
      }))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  } catch {
    return [];
  }
}

/** Section de prompt prête à injecter (vide si aucune leçon active). */
export async function buildFeedbackLessonsContext(userId: string): Promise<string> {
  const lessons = await getActiveFeedbackLessons(userId);
  if (lessons.length === 0) return "";
  const lines = lessons.map((lesson) => `- [${lesson.category}] ${LESSON_TEXTS[lesson.category]}`);
  return [
    "",
    "RETOURS UTILISATEURS CONFIRMÉS (leçons actives — RESPECTE-LES STRICTEMENT) :",
    ...lines,
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Export / purge (RGPD — utilisé par lib/memory/privacy.ts)           */
/* ------------------------------------------------------------------ */

export async function exportFeedbackData(userId: string): Promise<{
  feedback: Array<{ conversationId: string; messageId: string; rating: string; category: string; reason: string; createdAt?: string }>;
  lessons: LessonRecord[];
}> {
  const snap = await adminDb.collection(FEEDBACK_COLLECTION).where("userId", "==", userId).limit(500).get();
  const feedback = snap.docs.map((doc) => {
    const createdAt = doc.get("createdAt");
    return {
      conversationId: String(doc.get("conversationId") ?? ""),
      messageId: String(doc.get("messageId") ?? ""),
      rating: String(doc.get("rating") ?? ""),
      category: String(doc.get("category") ?? "autre"),
      reason: String(doc.get("reason") ?? ""),
      createdAt: typeof createdAt?.toMillis === "function" ? new Date(createdAt.toMillis()).toISOString() : undefined,
    };
  });
  const lessonsSnap = await adminDb.collection(LESSONS_COLLECTION).where("userId", "==", userId).get();
  const lessons = lessonsSnap.docs.map((doc) => ({
    category: doc.get("category") as FeedbackCategory,
    status: (doc.get("status") === "active" ? "active" : "proposée") as LessonRecord["status"],
    occurrences: Number(doc.get("occurrences") ?? 0),
    updatedAtMs: Number(doc.get("updatedAtMs") ?? 0),
  }));
  return { feedback, lessons };
}

export async function purgeFeedbackData(userId: string): Promise<number> {
  let purged = 0;
  for (const collection of [FEEDBACK_COLLECTION, LESSONS_COLLECTION]) {
    const snap = await adminDb.collection(collection).where("userId", "==", userId).limit(500).get();
    const docs = snap.docs;
    // Suppression par lots compatibles (commitAfterEach = vrai par défaut
    // dans runTransaction est inadapté ici : écriture directe par lot ≤ 500).
    if (docs.length > 0) {
      const batch = adminDb.batch();
      for (const doc of docs) batch.delete(doc.ref);
      await batch.commit();
      purged += docs.length;
    }
  }
  return purged;
}
