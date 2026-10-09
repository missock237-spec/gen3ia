import "server-only";

import { FieldValue } from "@/lib/r2fs";
import { adminDb } from "@/lib/firebase/admin";
import { listRunsForConversation } from "@/lib/domain/runs/repository";
import { remember, recall } from "@/lib/memory/user-memory";

/**
 * AUTO-AMÉLIORATION « GEN IA » (demande utilisateur, niveau professionnel) :
 * un système qui ÉVOLUE selon les demandes des utilisateurs pour maximiser
 * le bon résultat du projet — pas un simple « prompt amélioré ».
 *
 * Fonctionnement :
 *  1. COMPLEXITÉ : chaque requête est évaluée (score + niveau). Si la
 *     demande dépasse la complexité maximale déjà maîtrisée par cet
 *     utilisateur, le moteur passe en « mode évolution » : planification
 *     plus rigoureuse, sous-agents, budget de réflexion augmenté.
 *  2. MÉMOIRE D'EXÉCUTION : l'historique réel des runs de la conversation
 *     (réussites ET échecs, étapes exactes) est injecté dans le prompt de
 *     planification — l'agent lit son passé pour maximiser la réussite.
 *  3. LEÇONS : après chaque exécution, l'issue est enregistrée ; les
 *     échecs produisent des leçons persistées (mémoire utilisateur + Firestore)
 *     que les exécutions futures reçoivent explicitement.
 *  4. PROGRESSION : compteurs par utilisateur (runs, réussites, complexité
 *     maximale gérée, leçons apprises) — le système devient objectivement
 *     plus capable au fil de l'usage.
 *
 * Plancher : aucune donnée inventée — tout est dérivé de runs réels ;
 * tout échec de lecture est silencieux (jamais bloquant).
 */

const COLLECTION = "genIAEvolution";
const MEMORY_KEY = "genia:evolution-lessons";

/* ------------------------------------------------------------------ */
/* 1. Évaluation de complexité (déterministe, sans appel LLM — rapide) */
/* ------------------------------------------------------------------ */

export type ComplexityLevel = "simple" | "avancee" | "complexe" | "extreme";

const COMPLEXITY_MARKERS: ReadonlyArray<{ pattern: RegExp; weight: number }> = [
  { pattern: /\b(et puis|ensuite|après|puis|d'abord|étape|étapes|multi-étapes)\b/i, weight: 8 },
  { pattern: /\b(workflow|automatise|automatisation|planifie|schedule|pipeline)\b/i, weight: 10 },
  { pattern: /\b(api|connecteur|intègre|intégration|webhook|base de données)\b/i, weight: 9 },
  { pattern: /\b(sous-agents?|équipe d'agents|délègue|orchestre)\b/i, weight: 14 },
  { pattern: /\b(sites? web|application|app|dashboard|plateforme)\b/i, weight: 10 },
  { pattern: /\b(analys[ez]|rapport|présentation|slides?|pdf|docx|pptx)\b/i, weight: 8 },
  { pattern: /\b(publish|publie|envoie à|poste sur|emails? à)\b/i, weight: 9 },
  { pattern: /\b(compare|stratégie|audit|plan complet|de bout en bout|end-to-end)\b/i, weight: 8 },
];

export interface ComplexityAssessment {
  score: number;
  level: ComplexityLevel;
  /** Dépasse la complexité maximale déjà gérée par cet utilisateur. */
  beyondMastered: boolean;
}

export function assessComplexity(message: string, masteredMaxScore = 0): ComplexityAssessment {
  const text = message.trim();
  let score = Math.min(20, Math.floor(text.length / 120));
  for (const marker of COMPLEXITY_MARKERS) {
    if (marker.pattern.test(text)) score += marker.weight;
  }
  // Questions multiples / listes : signaux de complexité réelle.
  const questions = (text.match(/\?/g) ?? []).length;
  score += Math.min(10, questions * 3);
  const bullets = (text.match(/(^|\n)\s*([-*•]|\d+[.)])/g) ?? []).length;
  score += Math.min(12, bullets * 3);

  score = Math.max(0, Math.min(100, score));
  const level: ComplexityLevel = score >= 70 ? "extreme" : score >= 45 ? "complexe" : score >= 22 ? "avancee" : "simple";
  return { score, level, beyondMastered: score > masteredMaxScore + 8 };
}

/* ------------------------------------------------------------------ */
/* 2. Historique d'exécution réel (lecture, jamais inventé)            */
/* ------------------------------------------------------------------ */

export async function buildRunHistoryContext(userId: string, conversationId: string, limit = 5): Promise<string> {
  if (!userId?.trim() || !conversationId?.trim()) return "";
  try {
    const runs = await listRunsForConversation(userId, conversationId, limit);
    if (runs.length === 0) return "";
    const lines = runs.map((run) => {
      const done = run.steps.filter((step) => step.status === "done").length;
      const failed = run.steps.filter((step) => step.status === "failed" || step.status === "skipped");
      const failedDetail = failed
        .slice(0, 3)
        .map((step) => `« ${step.title} »${step.detail ? ` (${step.detail.slice(0, 140)})` : ""}`)
        .join("; ");
      return [
        `- Objectif : ${run.objective.slice(0, 160)} — statut ${run.status}, ${done}/${run.steps.length} étapes réussies.`,
        failed.length > 0 ? `  Écueils à ne pas répéter : ${failedDetail || "aucun détail"}` : "",
      ].filter(Boolean).join("\n");
    });
    return [
      "",
      "HISTORIQUE D'EXÉCUTION RÉCENT DE CETTE CONVERSATION (données réelles — lis-le pour maximiser la réussite, ne répète pas les échecs passés) :",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ */
/* 3. Contexte d'évolution (leçons + progression)                      */
/* ------------------------------------------------------------------ */

interface EvolutionDoc {
  totalRuns?: number;
  successes?: number;
  failures?: number;
  maxComplexityHandled?: number;
  lessons?: Array<{ text: string; atMs: number }>;
}

async function readEvolutionDoc(userId: string): Promise<EvolutionDoc> {
  const snapshot = await adminDb.collection(COLLECTION).doc(userId).get();
  if (!snapshot.exists) return {};
  const data = snapshot.data() ?? {};
  return {
    totalRuns: Number(data.totalRuns ?? 0),
    successes: Number(data.successes ?? 0),
    failures: Number(data.failures ?? 0),
    maxComplexityHandled: Number(data.maxComplexityHandled ?? 0),
    lessons: Array.isArray(data.lessons) ? data.lessons.slice(-20) : [],
  };
}

export async function buildEvolutionContext(userId: string): Promise<{ context: string; masteredMaxScore: number }> {
  if (!userId?.trim()) return { context: "", masteredMaxScore: 0 };
  try {
    const doc = await readEvolutionDoc(userId);
    const lessons = (doc.lessons ?? []).slice(-6).map((lesson) => `- ${lesson.text.slice(0, 220)}`);
    // Leçons dérivées des retours utilisateurs CONFIRMÉS (Task 42, axe 2) :
    // pipeline proposée → active (2 signaux concordants) — voir feedback.ts.
    const { buildFeedbackLessonsContext } = await import("./feedback");
    const feedbackSection = await buildFeedbackLessonsContext(userId);
    const successRate = doc.totalRuns ? Math.round(((doc.successes ?? 0) / doc.totalRuns) * 100) : null;
    const sections: string[] = [
      "",
      "AUTO-AMÉLIORATION GEN IA (système évolutif) :",
      `- Complexité maximale déjà maîtrisée par toi pour cet utilisateur : ${doc.maxComplexityHandled ?? 0}/100${successRate !== null ? `, taux de réussite historique ${successRate}%` : ""}.`,
      "- Si la demande dépasse ce niveau : passe en MODE ÉVOLUTION — planifie plus finement (étapes explicites, vérification du résultat, outils réels plutôt que suppositions), délègue à des sous-agents spécialisés si nécessaire, et annonce la montée en puissance.",
    ];
    if (lessons.length > 0) {
      sections.push("- Leçons retenues des exécutions passées (RESPECTE-LES) :", ...lessons);
    }
    if (feedbackSection) sections.push(feedbackSection);
    return { context: sections.join("\n"), masteredMaxScore: doc.maxComplexityHandled ?? 0 };
  } catch {
    return { context: "", masteredMaxScore: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* 4. Enregistrement d'issue de run (leçons + progression)             */
/* ------------------------------------------------------------------ */

export async function recordRunOutcome(params: {
  userId: string;
  objective: string;
  status: string;
  complexityScore?: number;
  failedSteps?: Array<{ title: string; detail?: string }>;
}): Promise<void> {
  const { userId } = params;
  if (!userId?.trim()) return;
  try {
    const succeeded = params.status === "completed" || params.status === "done" || params.status === "succeeded";
    const newLessons: string[] = [];
    for (const failed of (params.failedSteps ?? []).slice(0, 3)) {
      const lesson = `Pour des demandes comme « ${params.objective.slice(0, 80)} », l'étape « ${failed.title.slice(0, 80)} » a échoué${failed.detail ? ` : ${failed.detail.slice(0, 140)}` : ""} — anticipe et vérifie ce point avant d'exécuter.`;
      if (!newLessons.includes(lesson)) newLessons.push(lesson);
    }

    const ref = adminDb.collection(COLLECTION).doc(userId);
    await adminDb.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const current: EvolutionDoc = snapshot.exists
        ? {
            totalRuns: Number(snapshot.get("totalRuns") ?? 0),
            successes: Number(snapshot.get("successes") ?? 0),
            failures: Number(snapshot.get("failures") ?? 0),
            maxComplexityHandled: Number(snapshot.get("maxComplexityHandled") ?? 0),
            lessons: Array.isArray(snapshot.get("lessons")) ? snapshot.get("lessons").slice(-20) : [],
          }
        : { totalRuns: 0, successes: 0, failures: 0, maxComplexityHandled: 0, lessons: [] };
      const lessons = [...(current.lessons ?? []), ...newLessons.map((text) => ({ text, atMs: Date.now() }))].slice(-20);
      tx.set(ref, {
        totalRuns: (current.totalRuns ?? 0) + 1,
        successes: (current.successes ?? 0) + (succeeded ? 1 : 0),
        failures: (current.failures ?? 0) + (succeeded ? 0 : 1),
        maxComplexityHandled: Math.max(current.maxComplexityHandled ?? 0, params.complexityScore ?? 0),
        lastRunAtMs: Date.now(),
        ...(newLessons.length > 0 ? { lessons } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    if (newLessons.length > 0) {
      // Double persistance : mémoire utilisateur (rappel rapide par les agents).
      const existing = await recall({ userId, key: MEMORY_KEY }).catch(() => null);
      const merged = [typeof existing === "string" ? existing : "", ...newLessons].filter(Boolean).join("\n").slice(-4000);
      await remember({ userId, key: MEMORY_KEY, value: merged, source: "agent" }).catch(() => undefined);
    }
  } catch {
    /* jamais bloquant */
  }
}
