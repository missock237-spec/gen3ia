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

/** Produit un objet {title,questions} depuis n'importe quelle forme
 *  plausible renvoyée par le modèle (tableau nu, question nue, wrapper). */
function normaliserBrut(brut: unknown): unknown | null {
  if (Array.isArray(brut)) {
    return brut.every((q) => typeof q === "object" && q !== null)
      ? { title: "Évaluation", questions: brut }
      : null;
  }
  if (typeof brut !== "object" || brut === null) return null;
  const rec = brut as Record<string, unknown>;
  if (Array.isArray(rec.questions)) return brut;
  // Objet question nu → emballé.
  if (typeof rec.question === "string") {
    return { title: "Évaluation", questions: [brut] };
  }
  // Wrapper avec un autre nom (quiz, evaluation, items, data).
  for (const cle of ["quiz", "evaluation", "évaluation", "items", "data", "result", "resultat"]) {
    const v = rec[cle];
    if (Array.isArray(v)) return { title: rec.title ?? "Évaluation", questions: v };
    if (typeof v === "object" && v !== null && Array.isArray((v as Record<string, unknown>).questions)) {
      return v;
    }
  }
  return null;
}

const SYSTEME_QUIZ = (langue: string, nombre: number, format: string): string =>
  `Tu rédiges le contenu d'une évaluation pédagogique professionnelle pour l'utilisateur de Gen3ia. ` +
  "Tu produis UNIQUEMENT un objet JSON valide (sans texte autour, sans bloc de code) : " +
  '{ "title": "<titre court>", "questions": [ { "question": "...", "choices": ["..."], "correctIndex": 0, "expectedAnswer": "...", "explanation": "..." } ] }. ' +
  "Contraintes : " +
  `- langue ${langue} ; EXACTEMENT ${nombre} entrée(s) dans questions ; ` +
  (format === "qcm"
    ? "- chaque entrée a choices (2 à 6 libellés) et correctIndex (position du bon choix, 0-based) ; expectedAnswer absent ; "
    : format === "court"
      ? "- chaque entrée a expectedAnswer (réponse attendue) ; ni choices ni correctIndex ; "
      : "- alternance : certaines entrées avec choices+correctIndex (QCM), d'autres avec expectedAnswer ; ") +
  "- chaque entrée évalue une notion DISTINCTE et significative du sujet ; " +
  "- explanation : pourquoi la réponse est correcte (1-2 phrases) ; " +
  "- distracteurs plausibles mais clairement faux ; " +
  "- contenu rédigé intégralement : jamais de placeholder, jamais de « … », jamais d'entrée vide.";

/** Génération par le moteur (sortie structurée contrainte). */
export async function genererQuizMoteur(params: GenererQuizParams): Promise<Quiz | null> {
  try {
    const consigne = [
      `Sujet / matière à évaluer :`,
      (params.corpus ?? params.sujet).slice(0, 6000),
      "",
      `Rédige l'évaluation complète (${params.nombre} question(s), format ${params.format}).`,
    ].join("\n");
    const brut = await generateStructuredForUser({
      userId: params.userId,
      executionId: `assessment_${Date.now()}`,
      task: "chat",
      system: SYSTEME_QUIZ(params.langue ?? "fr", params.nombre, params.format),
      user: consigne,
      schema: QUIZ_SCHEMA,
      maxTokens: 6000,
      maxAttempts: 2,
    });
    return brut;
  } catch (erreur) {
    // Relance SANS schéma après extraction tolérante : les modèles
    // enveloppent parfois (tableau nu, question nue) — on normalise PUIS on
    // revalide le schéma ; en dernier recours, observabilité honnête.
    try {
      const consigne = `Rédige l'évaluation (${params.nombre} question(s), format ${params.format}) du sujet suivant, en répondant UNIQUEMENT par un objet JSON valide : ${(params.corpus ?? params.sujet).slice(0, 3000)}`;
      const { generateForUser } = await import("@/lib/billing/ai-execution");
      const { extractFirstJsonObject } = await import("@/lib/tools/agent-suite/llm-json");
      const billed = await generateForUser({
        userId: params.userId,
        executionId: `assessment_repair_${Date.now()}`,
        request: {
          task: "chat",
          system: SYSTEME_QUIZ(params.langue ?? "fr", params.nombre, params.format),
          messages: [{ role: "user", content: consigne }],
          requiresStructuredOutput: true,
          maxTokens: 6000,
        },
      });
      const candidat = normaliserBrut(extractFirstJsonObject(billed.response.text));
      if (candidat === undefined) throw new Error("aucun objet JSON exploitable");
      const parsed = QUIZ_SCHEMA.safeParse(candidat);
      if (parsed.success) return parsed.data;
      throw new Error("schéma non respecté après normalisation");
    } catch (erreurReparation) {
      // Observabilité honnête (diagnostic production) : la cause RÉELLE de
      // l'échec est journalisée avant le repli — jamais d'échec muet.
      console.warn(
        "assessment] génération structurée indisponible :",
        erreur instanceof Error ? erreur.message : String(erreur),
        "| réparation :",
        erreurReparation instanceof Error ? erreurReparation.message : String(erreurReparation),
      );
      return null;
    }
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

/** Cascade complète : CORPUS → déterministe d'abord (garanti, zéro LLM,
 *  zéro fait inventé — voie éprouvée en production) ; SANS corpus → moteur
 *  structuré (le cerveau entraîné peut réussir) → null honnête. */
export interface QuizGenere {
  quiz: Quiz;
  /** Moteur réellement utilisé — tracé honnêtement dans la livraison. */
  moteur: "structured" | "deterministe-corpus";
}

export async function genererQuiz(params: GenererQuizParams): Promise<QuizGenere | null> {
  // Matière fournie : le repli déterministe est LA voie primaire — rapide,
  // déterministe et vérifiable (chaque réponse figure littéralement dans le
  // texte). Constat production 2026-11-12 : la génération JSON du moteur
  // est défaillante plateforme entière (sonde documentaire aussi) — le
  // déterminisme d'abord est la seule voie fiable.
  if (params.corpus && params.corpus.trim().length >= 120) {
    const deterministe = genererQuizDeterministe(params.corpus, params.nombre);
    if (deterministe) return { quiz: deterministe, moteur: "deterministe-corpus" };
  }
  const parMoteur = await genererQuizMoteur(params);
  if (parMoteur && parMoteur.questions.length > 0) {
    return { quiz: parMoteur, moteur: "structured" };
  }
  return null;
}
