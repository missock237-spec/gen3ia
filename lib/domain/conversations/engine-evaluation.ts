import "server-only";

import { randomUUID } from "node:crypto";

import { generateArtifact } from "@/lib/documents/engine";
import { storeArtifactBuffer } from "@/lib/documents/artifact-store";
import { createArtifact } from "@/lib/domain/artifacts/repository";
import { appendMessage } from "@/lib/chat/repository";
import { safeEmitter, type StreamEventEmitter } from "./stream-events";
import type { TurnBase } from "./engine-chat";
import type { ConversationTurnResult } from "./engine-turn";
import {
  extractAssessmentCount,
  extractAssessmentFormat,
  type AssessmentFormat,
} from "@/lib/ai/assessment-intent";
import { genererQuiz, type Question, type Quiz } from "@/lib/evaluation/generateur";

/**
 * ASSESSMENT ENGINE — tour conversationnel (système n°15 de la feuille de
 * route propriétaire : « Générer des tests, évaluations et questionnaires »).
 *
 * Demande (« Crée un quiz de 8 questions sur … », « Génère une évaluation du
 * texte suivant : … ») → génération (cascade honnête : moteur structuré
 * contraint → repli déterministe sur corpus fourni) → livrable RÉEL :
 * document PDF téléchargeable (questions + corrigé) + réponse dans le fil.
 *
 * Sans corpus ET sans moteur exploitable → demande de clarification honnête
 * (aucun quiz au hasard déguisé en succès).
 */

/** Extrait le sujet évalué (texte après le sujet demandé) du message. */
function sujetDepuisMessage(message: string): { sujet: string; corpus?: string } {
  const brut = message.trim();
  // Corpus fourni : le message entier sert de sujet ET de corpus.
  if (brut.length >= 400) return { sujet: brut.slice(0, 200), corpus: brut };
  // « sur <sujet> » / « à propos de <sujet> » / « : <sujet> ».
  const m = brut.match(/\b(?:sur|à propos de|about)\s*[:：]?\s*(.+)$/i)
    ?? brut.match(/:\s*(.+)$/);
  const sujet = (m?.[1] ?? brut).trim().slice(0, 300);
  return { sujet: sujet.length > 0 ? sujet : brut.slice(0, 300) };
}

function lettre(i: number): string {
  return String.fromCharCode(65 + Math.min(i, 25));
}

/** Blocs du document : énoncé + corrigé (séparés). */
function blocsQuiz(quiz: Quiz, format: AssessmentFormat): Array<Record<string, unknown>> {
  const blocs: Array<Record<string, unknown>> = [];
  blocs.push({ type: "title", text: quiz.title });
  blocs.push({ type: "paragraph", text: `Évaluation générée par Gen3ia — ${quiz.questions.length} question(s), format ${format === "qcm" ? "QCM" : format === "court" ? "réponses courtes" : "mixte"}.` });
  blocs.push({ type: "heading", text: "Questions", level: 1 });
  quiz.questions.forEach((q: Question, i: number) => {
    blocs.push({ type: "paragraph", text: `${i + 1}. ${q.question}` });
    if (q.choices && q.choices.length > 0) {
      blocs.push({
        type: "list",
        ordered: false,
        items: q.choices.map((c, j) => `${lettre(j)}. ${c}`),
      });
    } else if (format !== "qcm") {
      blocs.push({ type: "paragraph", text: "Réponse : ________________________________________" });
    }
  });
  blocs.push({ type: "pageBreak", text: "" });
  blocs.push({ type: "heading", text: "Corrigé", level: 1 });
  quiz.questions.forEach((q: Question, i: number) => {
    const reponse = q.choices && typeof q.correctIndex === "number"
      ? `${lettre(q.correctIndex)}. ${q.choices[q.correctIndex] ?? ""}`
      : (q.expectedAnswer ?? "—");
    const explication = q.explanation ? ` — ${q.explanation}` : "";
    blocs.push({ type: "paragraph", text: `${i + 1}. ${reponse}${explication}` });
  });
  return blocs;
}

/** Texte du message dans le fil : aperçu complet des questions. */
function apercuQuiz(quiz: Quiz, moteur: string): string {
  const lignes: string[] = [
    `Votre évaluation est prête — « ${quiz.title} » (${quiz.questions.length} question(s), moteur ${moteur === "structured" ? "génération contrainte" : "repli déterministe sur votre texte"}).`,
    "",
  ];
  quiz.questions.slice(0, 5).forEach((q, i) => {
    lignes.push(`${i + 1}. ${q.question}`);
    if (q.choices && q.choices.length > 0) {
      q.choices.slice(0, 4).forEach((c, j) => lignes.push(`   ${lettre(j)}. ${c}`));
    }
  });
  if (quiz.questions.length > 5) lignes.push(`… et ${quiz.questions.length - 5} autre(s) question(s).`);
  lignes.push("", "Le document complet (questions + corrigé) est livré en pièce jointe téléchargeable.");
  return lignes.join("\n");
}

export async function runEvaluationTurn(ctx: TurnBase): Promise<ConversationTurnResult> {
  const onEvent: StreamEventEmitter = safeEmitter(ctx.onEvent);
  const nombre = extractAssessmentCount(ctx.message);
  const format = extractAssessmentFormat(ctx.message);
  const { sujet, corpus } = sujetDepuisMessage(ctx.message);

  await onEvent({ type: "status", phase: "execution", label: "Génération de l'évaluation…" });

  const genere = await genererQuiz({
    userId: ctx.userId,
    sujet,
    ...(corpus ? { corpus } : {}),
    nombre,
    format,
  });

  if (!genere) {
    const messageClarification = await appendMessage({
      conversationId: ctx.conversationId,
      userId: ctx.userId,
      role: "assistant",
      content:
        "Je peux générer un test, un questionnaire ou une évaluation — il me faut la MATIÈRE à évaluer : " +
        "collez le cours/les notes dans votre message (même long), et je produis immédiatement l'évaluation " +
        "complète (questions « compléter » construites sur votre texte — chaque réponse figure littéralement " +
        "dans la matière fournie, plus aucune question inventée) avec le corrigé en PDF téléchargeable. " +
        "Je ne fabrique jamais des questions au hasard sans matière : elles seraient fausses.",
      generationStatus: "complete",
    });
    await onEvent({ type: "message_complete", message: messageClarification });
    return {
      conversationId: ctx.conversationId,
      userMessage: ctx.userMessage,
      assistantMessage: messageClarification,
      artifacts: [],
      approvals: [],
      intent: { mode: "chat", understanding: "Évaluation demandée sans matière : clarification honnête." },
    };
  }

  // Livrable RÉEL : PDF questions + corrigé, stocké (R2 ou inline honnête).
  const plan = {
    title: genere.quiz.title,
    format: "pdf" as const,
    description: `Évaluation générée (${genere.quiz.questions.length} question(s))`,
    blocks: blocsQuiz(genere.quiz, format),
  };
  const generated = await generateArtifact({
    userId: ctx.userId,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    executionId: `assessment_${randomUUID()}`,
    plan,
  });
  const stocke = await storeArtifactBuffer({
    ownerId: ctx.userId,
    executionId: `assessment_${randomUUID()}`,
    name: generated.filename,
    mimeType: generated.mimeType,
    data: generated.data,
  });
  const artifact = await createArtifact({
    userId: ctx.userId,
    conversationId: ctx.conversationId,
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    type: "document",
    title: genere.quiz.title,
    storagePath: stocke.storageKey,
    note: `Assessment Engine — ${genere.quiz.questions.length} question(s) (moteur ${genere.moteur})`,
  });

  const assistantMessage = await appendMessage({
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    role: "assistant",
    content: apercuQuiz(genere.quiz, genere.moteur),
    generationStatus: "complete",
  });
  await onEvent({ type: "message_complete", message: assistantMessage });
  await onEvent({ type: "artifact_created", artifact });
  return {
    conversationId: ctx.conversationId,
    userMessage: ctx.userMessage,
    assistantMessage,
    artifacts: [artifact],
    approvals: [],
    intent: { mode: "chat", understanding: `Évaluation générée (${genere.quiz.questions.length} question(s), moteur ${genere.moteur}) — PDF livré.` },
  };
}
