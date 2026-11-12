import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GARDES — ASSESSMENT ENGINE (système n°15 : « Générer des tests,
 * évaluations et questionnaires »).
 *
 * Trois niveaux :
 *  A. DÉTECTION DÉTERMINISTE (lib/ai/assessment-intent.ts) : FR + EN,
 *     questions méta exclues, demandes web exclues (pages, pas documents),
 *     sujets non pédagogiques exclus (test de performance…), comptes et
 *     formats extraits.
 *  B. GÉNÉRATION HONNÊTE (lib/evaluation/generateur.ts) : moteur structuré
 *     → repli déterministe UNIQUEMENT sur corpus fourni (zéro fait
 *     inventé) → null sinon.
 *  C. CÂBLAGE (engine.ts) : routage AVANT l'artefact application web.
 */

const generateForUserMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: generateForUserMock,
}));

import {
  looksLikeAssessmentRequest,
  extractAssessmentCount,
  extractAssessmentFormat,
} from "@/lib/ai/assessment-intent";
import {
  genererQuizDeterministe,
  genererQuiz,
} from "@/lib/evaluation/generateur";

// ── C. Câblage (verrou structurel) ────────────────────────────────────────

describe("câblage du tour évaluation (engine.ts)", () => {
  const moteur = readFileSync(
    "lib/domain/conversations/engine.ts", "utf8",
  );

  it("le routage évaluation est câblé AVANT l'artefact application web (quiz documentaire ≠ page)", () => {
    const posEvaluation = moteur.indexOf("looksLikeAssessmentRequest(input.message)");
    const posApp = moteur.indexOf("detectAppCreationIntent(input.message)");
    expect(posEvaluation).toBeGreaterThan(0);
    expect(posApp).toBeGreaterThan(0);
    expect(posEvaluation).toBeLessThan(posApp);
  });

  it("le tour évaluation est appelé avec la même base que les autres tours média", () => {
    expect(moteur).toContain("runEvaluationTurn({ ...input, conversation, project, projectId, userMessage, priorHistory })");
  });
});

// ── A. Détection ──────────────────────────────────────────────────────────

describe("detection évaluation (déterministe, zéro variance)", () => {
  it("les demandes FR de quiz/questionnaire/évaluation sont ROUTÉES", () => {
    expect(looksLikeAssessmentRequest("Crée un quiz de 8 questions sur la Révolution française")).toBe(true);
    expect(looksLikeAssessmentRequest("Génère un questionnaire sur la photosynthèse")).toBe(true);
    expect(looksLikeAssessmentRequest("Prépare une évaluation du texte suivant")).toBe(true);
    expect(looksLikeAssessmentRequest("Génère un QCM sur les fractions")).toBe(true);
  });

  it("les demandes EN sont routées", () => {
    expect(looksLikeAssessmentRequest("Create a quiz about the water cycle")).toBe(true);
    expect(looksLikeAssessmentRequest("Generate an assessment on World War II")).toBe(true);
  });

  it("les QUESTIONS MÉTA ne déclenchent PAS", () => {
    expect(looksLikeAssessmentRequest("C'est quoi un bon quiz pédagogique ?")).toBe(false);
    expect(looksLikeAssessmentRequest("Comment créer un questionnaire efficace ?")).toBe(false);
    expect(looksLikeAssessmentRequest("What is a good assessment?")).toBe(false);
  });

  it("les demandes WEB (pages/app) ne déclenchent PAS — artefact application", () => {
    expect(looksLikeAssessmentRequest("Crée un quiz en ligne interactif")).toBe(false);
    expect(looksLikeAssessmentRequest("Fais un site web avec un questionnaire html")).toBe(false);
    expect(looksLikeAssessmentRequest("Crée une page web de quiz")).toBe(false);
  });

  it("les évaluations NON pédagogiques ne déclenchent PAS", () => {
    expect(looksLikeAssessmentRequest("Fais un test de performance de l'API")).toBe(false);
    expect(looksLikeAssessmentRequest("Lance une évaluation des risques")).toBe(false);
  });

  it("le comptage est DÉTERMINISTE (8 questions → 8 ; défaut 5 ; borné)", () => {
    expect(extractAssessmentCount("Crée un quiz de 8 questions sur Napoléon")).toBe(8);
    expect(extractAssessmentCount("Génère un questionnaire avec 12 items")).toBe(12);
    expect(extractAssessmentCount("Crée un quiz sur les fractions")).toBe(5);
    expect(extractAssessmentCount("Crée un quiz de 99 questions")).toBe(30);
    expect(extractAssessmentCount("Crée un quiz de trois questions")).toBe(3);
  });

  it("le format est déterministe (qcm défaut, court, mixte)", () => {
    expect(extractAssessmentFormat("Crée un quiz sur les Vikings")).toBe("qcm");
    expect(extractAssessmentFormat("Crée un quiz à réponses courtes sur les Vikings")).toBe("court");
    expect(extractAssessmentFormat("Crée un quiz mixte sur les Vikings")).toBe("mixte");
  });
});

// ── B. Génération honnête ─────────────────────────────────────────────────

const CORPUS = `La photosynthèse est le processus biologique par lequel les plantes fabriquent leur matière organique. Ce mécanisme convertit l'énergie lumineuse en énergie chimique stockée sous forme de glucose. Les chloroplastes contiennent la chlorophylle qui absorbe la lumière solaire. L'eau absorbe les photons lors de la phase claire du processus. Le dioxyde de carbone est ensuite fixé durant la phase sombre. Cette réaction produit du glucose et libère de l'oxygène dans l'atmosphère.`;

describe("génération de quiz (cascade honnête)", () => {
  beforeEach(() => {
    generateForUserMock.mockReset();
  });

  it("moteur structuré : le JSON contraint est validé et retourné", async () => {
    generateForUserMock.mockResolvedValue({
      response: { text: JSON.stringify({
        title: "Quiz sur la Révolution française",
        questions: [
          { question: "En quelle année a eu lieu la prise de la Bastille ?", choices: ["1789", "1793", "1804", "1776"], correctIndex: 0, explanation: "La prise de la Bastille date du 14 juillet 1789." },
        ],
      }) },
    });
    const r = await genererQuiz({ userId: "u1", sujet: "Révolution française", nombre: 1, format: "qcm" });
    expect(r?.moteur).toBe("structured");
    expect(r?.quiz.questions[0].correctIndex).toBe(0);
    expect(generateForUserMock).toHaveBeenCalledTimes(1);
  });

  it("REPLI DÉTERMINISTE : le corpus fourni produit des questions « compléter » SANS LLM", async () => {
    generateForUserMock.mockRejectedValue(new Error("moteur indisponible"));
    const r = await genererQuiz({ userId: "u1", sujet: "photosynthèse", corpus: CORPUS, nombre: 3, format: "court" });
    expect(r?.moteur).toBe("deterministe-corpus");
    expect(r?.quiz.questions.length).toBeGreaterThanOrEqual(1);
    expect(r?.quiz.questions.length).toBeLessThanOrEqual(3);
    r?.quiz.questions.forEach((q) => {
      expect(q.question).toContain("____");
      // Zéro fait inventé : la réponse attendue figure DANS le corpus.
      expect(CORPUS.toLowerCase()).toContain((q.expectedAnswer ?? "").toLowerCase());
    });
  });

  it("sans corpus et sans moteur → null (jamais de quiz au hasard)", async () => {
    generateForUserMock.mockRejectedValue(new Error("moteur indisponible"));
    const r = await genererQuiz({ userId: "u1", sujet: "un sujet sans matière", nombre: 5, format: "qcm" });
    expect(r).toBeNull();
  });

  it("genererQuizDeterministe : réponses uniques et bornées", () => {
    const quiz = genererQuizDeterministe(CORPUS, 30);
    expect(quiz).not.toBeNull();
    const reponses = quiz!.questions.map((q) => (q.expectedAnswer ?? "").toLowerCase());
    expect(new Set(reponses).size).toBe(reponses.length);
    expect(quiz!.questions.length).toBeLessThanOrEqual(30);
  });
});
