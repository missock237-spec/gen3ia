import { randomUUID } from "crypto";
import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { getAgentForOwner } from "@/lib/agents/repository";
import type { AgentRecord } from "@/lib/agents/schema";
import { buildAgentCharter } from "@/lib/agents/charter";
import { generateForUser } from "@/lib/billing/ai-execution";
import { generate } from "@/lib/ai/router";

/**
 * Evals Studio Gen3ia — évaluation réelle des agents.
 *
 * Un Test Set contient des cas ({input, expected}) ; l'exécution génère la
 * réponse de l'agent (même charte que le chat), puis un juge LLM note la
 * conformité (0–1) face au résultat attendu. Chaque cas est facturé au
 * wallet du propriétaire (generateForUser, référence = runId).
 * Les ensembles et runs sont persistés (agentTestSets / agentTestRuns).
 */

export const MAX_CASES_PER_SET = 20;

export const TestCaseSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  input: z.string().trim().min(2).max(2000),
  expected: z.string().trim().max(2000).default(""),
  criteria: z.string().trim().max(500).default(""),
});
export type EvalTestCase = z.infer<typeof TestCaseSchema>;

export const TestSetSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).default(""),
  cases: z.array(TestCaseSchema).min(1).max(MAX_CASES_PER_SET),
});
export type EvalTestSet = z.infer<typeof TestSetSchema>;

export interface TestRunResult {
  caseId: string;
  input: string;
  expected: string;
  output: string;
  score: number;
  passed: boolean;
  judgeFeedback: string;
  latencyMs: number;
  chargeMinor: number;
}

export interface TestRunSummary {
  runId: string;
  testSetId: string;
  agentId: string;
  status: "completed" | "failed";
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  totalChargeMinor: number;
  durationMs: number;
  results: TestRunResult[];
  error?: string;
  createdAt: string;
}

const JUDGE_SYSTEM = `Tu es un évaluateur QA rigoureux. On te donne : la demande initiale, la réponse d'un agent IA et le résultat attendu. Tu notes la conformité de la réponse de 0 à 1 (0 = hors sujet / faux, 0.5 = partiellement conforme, 1 = conforme au résultat attendu). Tu réponds UNIQUEMENT avec un JSON {"score": number, "feedback": "explication courte en français"}.`;

function buildJudgePrompt(input: { question: string; answer: string; expected: string; criteria: string }): string {
  return JSON.stringify({
    demande: input.question,
    reponse_agent: input.answer.slice(0, 6000),
    resultat_attendu: input.expected || "(non précisé — juge la pertinence et la qualité de la réponse)",
    criteres_supplementaires: input.criteria || "(aucun)",
    format_reponse: { score: "number entre 0 et 1", feedback: "string" },
  });
}

async function loadAgentForEval(userId: string, agentId: string): Promise<AgentRecord> {
  const agent = await getAgentForOwner(userId, agentId);
  if (!agent) throw new Error("Agent introuvable.");
  if (agent.status !== "active") throw new Error(`L'agent est ${agent.status}. Activez-le avant de lancer une évaluation.`);
  return agent;
}

export async function createTestSet(userId: string, agentId: string, input: EvalTestSet): Promise<{ id: string }> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const cases = input.cases.map((testCase) => ({ ...testCase, id: testCase.id || randomUUID() }));
  await adminDb.collection("agentTestSets").doc(id).set({
    userId, agentId, name: input.name, description: input.description, cases,
    createdAt: now, updatedAt: now,
  });
  return { id };
}

export async function deleteTestSet(userId: string, testSetId: string): Promise<boolean> {
  const ref = adminDb.collection("agentTestSets").doc(testSetId);
  const doc = await ref.get();
  if (!doc.exists || (doc.data() as { userId?: string } | undefined)?.userId !== userId) return false;
  await ref.delete();
  return true;
}

export async function listTestSets(userId: string, agentId: string): Promise<Array<{ id: string; name: string; description: string; cases: EvalTestCase[]; createdAt: string }>> {
  const snapshot = await adminDb.collection("agentTestSets")
    .where("userId", "==", userId)
    .where("agentId", "==", agentId)
    .limit(50)
    .get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() as { name: string; description: string; cases: EvalTestCase[]; createdAt: string }) }))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export async function listTestRuns(userId: string, testSetId: string, limit = 10): Promise<Array<{ id: string; summary: Omit<TestRunSummary, "results"> | undefined }>> {
  const snapshot = await adminDb.collection("agentTestRuns")
    .where("userId", "==", userId)
    .where("testSetId", "==", testSetId)
    .limit(limit)
    .get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data() as { summary?: Omit<TestRunSummary, "results"> };
      return { id: doc.id, summary: data.summary };
    })
    .filter((entry): entry is { id: string; summary: Omit<TestRunSummary, "results"> } => Boolean(entry.summary))
    .sort((a, b) => (b.summary.createdAt ?? "").localeCompare(a.summary.createdAt ?? ""));
}

export async function getTestRun(userId: string, runId: string): Promise<TestRunSummary | null> {
  const doc = await adminDb.collection("agentTestRuns").doc(runId).get();
  if (!doc.exists) return null;
  const data = doc.data() as { userId?: string; summary?: Omit<TestRunSummary, "results">; results?: TestRunResult[] };
  if (data.userId !== userId || !data.summary) return null;
  return { ...data.summary, results: data.results ?? [] };
}

/** Exécute tous les cas d'un test set : réponse d'agent + juge, facturés. */
export async function runTestSet(userId: string, agentId: string, testSetId: string): Promise<TestRunSummary> {
  const agent = await loadAgentForEval(userId, agentId);
  const setRef = adminDb.collection("agentTestSets").doc(testSetId);
  const setDoc = await setRef.get();
  if (!setDoc.exists || (setDoc.data() as { userId?: string } | undefined)?.userId !== userId) {
    throw new Error("Test set introuvable.");
  }
  const setData = setDoc.data() as { name?: string; cases?: EvalTestCase[] };
  const cases = (setData.cases ?? []).slice(0, MAX_CASES_PER_SET);
  if (cases.length === 0) throw new Error("Ce test set ne contient aucun cas.");

  const runId = randomUUID();
  const startedAt = Date.now();
  const results: TestRunResult[] = [];
  let totalChargeMinor = 0;
  let status: "completed" | "failed" = "completed";
  let error: string | undefined;

  const charter = buildAgentCharter(agent);

  for (const testCase of cases) {
    const caseId = testCase.id || randomUUID();
    const caseStartedAt = Date.now();
    try {
      const billed = await generateForUser({
        userId,
        executionId: `eval_${runId}`,
        request: {
          task: "chat",
          messages: [
            { role: "system", content: charter },
            { role: "user", content: testCase.input },
          ],
          maxTokens: 2048,
        },
      });
      totalChargeMinor += billed.chargeMinor;
      const answer = billed.response.text.trim();

      // Juge LLM : note la conformité face au résultat attendu. Le juge
      // passe par le routeur standard (coût dérisoire, non facturé wallet).
      let score = 0;
      let feedback = "Réponse vide.";
      if (answer) {
        try {
          const judge = await generate({
            task: "reasoning",
            messages: [
              { role: "system", content: JUDGE_SYSTEM },
              { role: "user", content: buildJudgePrompt({ question: testCase.input, answer, expected: testCase.expected, criteria: testCase.criteria }) },
            ],
            requiresStructuredOutput: true,
            maxTokens: 400,
          });
          const parsed = JSON.parse(judge.text.replace(/^```(?:json)?|```$/g, "").trim()) as { score?: unknown; feedback?: unknown };
          score = Math.max(0, Math.min(1, Number(parsed.score)));
          feedback = String(parsed.feedback ?? "").slice(0, 500) || "Évaluation du juge indisponible.";
        } catch {
          score = 0.5;
          feedback = "Le juge n'a pas pu évaluer précisément cette réponse.";
        }
      }
      results.push({
        caseId, input: testCase.input, expected: testCase.expected, output: answer,
        score, passed: score >= 0.7, judgeFeedback: feedback,
        latencyMs: Date.now() - caseStartedAt, chargeMinor: billed.chargeMinor,
      });
    } catch (caseError) {
      status = "failed";
      error = caseError instanceof Error ? caseError.message : "Échec d'évaluation.";
      results.push({
        caseId, input: testCase.input, expected: testCase.expected, output: "",
        score: 0, passed: false, judgeFeedback: error ?? "Échec d'exécution.",
        latencyMs: Date.now() - caseStartedAt, chargeMinor: 0,
      });
      break; // erreur wallet/infra : inutile de brûler les cas restants
    }
  }

  const passed = results.filter((result) => result.passed).length;
  const summary: TestRunSummary = {
    runId, testSetId, agentId, status,
    total: cases.length,
    passed,
    failed: results.length - passed,
    avgScore: results.length > 0 ? Number((results.reduce((total, result) => total + result.score, 0) / results.length).toFixed(3)) : 0,
    totalChargeMinor,
    durationMs: Date.now() - startedAt,
    results,
    ...(error ? { error } : {}),
    createdAt: new Date().toISOString(),
  };

  const { results: runResults, ...summaryCore } = summary;
  await adminDb.collection("agentTestRuns").doc(runId).set({
    userId, agentId, testSetId,
    summary: summaryCore,
    results: runResults,
    createdAt: summary.createdAt,
  });

  return summary;
}
