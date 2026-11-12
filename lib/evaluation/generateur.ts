import "server-only";

import { z } from "zod";

import { generateStructuredForUser } from "@/lib/tools/agent-suite/llm-json";

/**
 * ASSESSMENT ENGINE (système n°15 — feuille de route propriétaire) :
 * « Générer des tests, évaluations et questionnaires ».
 *
 * Cascade HONNÊTE (motif « repli structuré » 7c6e432) :
 *   1) génération STRUCTURÉE contrainte (generateStructuredForUser :
 *      requiresStructuredOutput + validation zod QUIZ_SCHEMA + relance
 *      corrective injectant l'écart, facturée au wallet du propriétaire) ;
 *   2) repli DÉTERMINISTE possible UNIQUEMENT quand un corpus est fourni :
 *      questions « compléter » fabriquées depuis le texte (masquage de
 *      mots porteurs) — zéro fait inventé ;
 *   3) sans corpus ET sans moteur exploitable → ÉCHEC honnête (l'appelant
 *      demande le contenu) — jamais de quiz au hasard déguisé en succès.
 */

export const QUIZ_SCHEMA = z.object({
  title: z.string().min(3).max(200),
  questions: z
    .array(
      z.object({
        question: z.string().min(3).max(600),
        /** QCM : libellés des choix (2 à 6). Absent pour « réponse courte ». */
        choices: z.array(z.string().min(1).max(300)).min(2).max(6).optional(),
        /** QCM : index du bon choix (0-based). Null pour « réponse courte ». */
        correctIndex: z.number().int().min(0).max(5).nullable().optional(),
        /** Réponse attendue (texte libre) pour « réponse courte ». */
        expectedAnswer: z.string().max(600).optional(),
        explanation: z.string().max(800).optional(),
      }),
    )
    .min(1)
    .max(30),
});

export type Quiz = z.infer<typeof QUIZ_SCHEMA>;
export type Question = Quiz["questions"][number];

export interface GenererQuizParams {
  userId: string;
  /** Sujet OU corpus à évaluer (cours, notes, texte fourni). */
  sujet: string;
  /** Corpus fourni verbatim (≥400 caractères) — active le repli déterministe. */
  corpus?: string;
  nombre: number;
  format: "qcm" | "court" | "mixte";
  langue?: string;
}

const SYSTEME_QUIZ = (langue: string, nombre: number, format: string): string =>
  `Tu es l'ASSESSMENT ENGINE de Gen3ia : tu génères des évaluations pédagogiques de qualité professionnelle.
Tu réponds STRICTEMENT en JSON selon ce schéma :
{ "title": string, "questions": [ { "question": string, "choices": string[] (2-6, QCM uniquement), "correctIndex": number (0-based, QCM uniquement), "expectedAnswer": string (réponse courte uniquement), "explanation": string } ] }
Règles :
- Langue : ${langue}. EXACTEMENT ${nombre} question(s).
- Format demandé : ${format === "qcm" ? "QCM (choices + correctIndex obligatoires)" : format === "court" ? "réponses courtes (expectedAnswer obligatoire, pas de choices)" : "mixte (mélange QCM et réponses courtes)"}.
- Chaque question évalue une notion DISTINCTE et significative du sujet.
- « explanation » : pourquoi la réponse est correcte (1-2 phrases).
- Distracteurs plausibles mais clairement faux ; jamais de « toutes les réponses ».
- AUCUN texte hors JSON.`;

export interface QuizGenere {
  quiz: Quiz;
  /** Moteur réellement utilisé — tracé honnêtement dans la livraison. */
  moteur: "structured" | "deterministe-corpus";
}

/** Génération par le moteur (sortie structurée contrainte). */
export async function genererQuizMoteur(params: GenererQuizParams): Promise<Quiz | null> {
  try {
    const consigne = [
      `Sujet / corpus à évaluer :`,
      (params.corpus ?? params.sujet).slice(0, 6000),
      "",
      `Génère l'évaluation (${params.nombre} question(s), format ${params.format}).`,
    ].join("\n");
    return await generateStructuredForUser({
      userId: params.userId,
      executionId: `assessment_${Date.now()}`,
      task: "reasoning",
      system: SYSTEME_QUIZ(params.langue ?? "fr", params.nombre, params.format),
      user: consigne,
      schema: QUIZ_SCHEMA,
      maxTokens: 6000,
      maxAttempts: 2,
    });
  } catch {
    return null;
  }
}

/** Mots porteurs candidats au masquage (≥4 lettres, hors stop-words FR). */
const MOTS_VIDES_EVAL = new Set([
  "cela", "cette", "dans", "avec", "pour", "sans", "sous", "entre", "aussi",
  "ainsi", "alors", "donc", "mais", "comme", "tout", "toute", "tous",
  "toutes", "etre", "avoir", "fait", "faire", "peut", "plus", "moins",
  "tres", "leurs", "leur", "nos", "vos", "elles", "ils", "nous", "vous",
  "elle", "lui", "dont", "chez", "vers", "puis", "quand", "afin", "depuis",
  "pendant", "selon", "chaque", "encore",
]);

function motsPorteurs(texte: string): string[] {
  const brut = texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z][a-z'-]{3,}/g) ?? [];
  const vus = new Set<string>();
  const resultats: string[] = [];
  for (const mot of brut) {
    if (MOTS_VIDES_EVAL.has(mot)) continue;
    if (vus.has(mot)) continue;
    vus.add(mot);
    resultats.push(mot);
  }
  return resultats;
}

/** Phrases exploitables du corpus (≥ 60 caractères, ponctuées). */
function phrasesCorpus(corpus: string): string[] {
  return corpus
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 60 && p.length <= 600);
}

/**
 * REPLI DÉTERMINISTE (zéro LLM, zéro fait inventé) : questions « compléter »
 * fabriquées depuis le corpus fourni — un mot porteur est MASQUÉ (____),
 * la réponse attendue est ce mot extrait du texte.
 */
export function genererQuizDeterministe(corpus: string, nombre: number): Quiz | null {
  const phrases = phrasesCorpus(corpus);
  if (phrases.length === 0) return null;
  const questions: Question[] = [];
  const vus = new Set<string>();
  for (const phrase of phrases) {
    if (questions.length >= Math.max(1, Math.min(30, nombre))) break;
    const candidats = motsPorteurs(phrase);
    const cible = candidats.find((m) => !vus.has(m));
    if (!cible) continue;
    vus.add(cible);
    // Mot RÉEL (accents conservés) extrait de la phrase originale.
    const motif = new RegExp(`\\b${cible.slice(0, 1)}[\\p{L}'-]*`, "iu");
    const mReel = phrase.match(motif);
    if (!mReel) continue;
    const masquee = phrase.replace(motif, "____");
    questions.push({
      question: `Complétez : « ${masquee} »`,
      correctIndex: null,
      expectedAnswer: mReel[0],
      explanation: "Le terme masqué figure littéralement dans le texte fourni.",
    });
  }
  if (questions.length === 0) return null;
  return {
    title: "Évaluation de compréhension (texte fourni)",
    questions,
  };
}

/** Cascade complète : moteur structuré puis repli déterministe (corpus). */
export async function genererQuiz(params: GenererQuizParams): Promise<QuizGenere | null> {
  const parMoteur = await genererQuizMoteur(params);
  if (parMoteur && parMoteur.questions.length > 0) {
    return { quiz: parMoteur, moteur: "structured" };
  }
  if (params.corpus && params.corpus.trim().length >= 120) {
    const deterministe = genererQuizDeterministe(params.corpus, params.nombre);
    if (deterministe) return { quiz: deterministe, moteur: "deterministe-corpus" };
  }
  return null;
}
