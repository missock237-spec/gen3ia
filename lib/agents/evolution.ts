import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";

import type { RuntimeExecutionState } from "./runtime/types";

/**
 * AUTO-ÉVOLUTION (concept post-SaaS #10 « Self-Evolving Platform ») —
 * forage de CLUSTERS D'ÉCHEC : chaque échec de mission alimente des groupes
 * (classe d'erreur × type d'étape × outil) persistés par utilisateur. Ces
 * clusters deviennent des LEÇONS injectées dans les replanifications et les
 * pulses business — la plateforme apprend de ses erreurs au lieu de les
 * répéter. Écriture FAIL-SOFT : une panne d'apprentissage ne doit jamais
 * masquer le résultat réel d'une mission.
 */

const COLLECTION = "agentFailureClusters";

const FAILURE_CLASS_RULES: Array<{ class: string; pattern: RegExp }> = [
  { class: "timeout", pattern: /timeout|délai dépassé/i },
  { class: "insufficient_funds", pattern: /insufficient (wallet|funds)|solde/i },
  { class: "permission_denied", pattern: /permission denied|non autorisé|not allowed|refusé/i },
  { class: "tool_missing", pattern: /unknown tool|outil inexistant|not registered|introuvable ou inactif/i },
  { class: "provider_error", pattern: /provider|fournisseur|rate limit|503|429/i },
  { class: "approval_pending", pattern: /approval|validation humaine/i },
  { class: "input_invalid", pattern: /requires input|schéma|invalid input|attendu/i },
];

/** Classement PUR d'un message d'échec (testé sans Firestore). */
export function classifyFailure(message: string): string {
  const normalized = (message || "").slice(0, 500);
  for (const rule of FAILURE_CLASS_RULES) {
    if (rule.pattern.test(normalized)) return rule.class;
  }
  return "other";
}

export function failureClusterId(input: { userId: string; stepType: string; toolName?: string; errorClass: string }): string {
  return createHash("sha256")
    .update(`${input.userId}|${input.stepType}|${input.toolName ?? ""}|${input.errorClass}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Enregistre les clusters d'échec d'une exécution terminée en échec.
 * Transaction par cluster (incrément atomique). NE LÈVE JAMAIS.
 */
export async function recordFailureClusters(
  state: Pick<RuntimeExecutionState, "userId" | "executionId" | "objective" | "plan" | "observations" | "error">,
  options: { agentId?: string; orgId?: string } = {},
): Promise<number> {
  try {
    const failures = state.plan.steps.filter((step) => step.status === "failed");
    if (failures.length === 0) return 0;
    const seen = new Set<string>();
    let written = 0;
    for (const step of failures.slice(0, 10)) {
      const observation = state.observations.filter((entry) => entry.stepId === step.id && !entry.success).at(-1);
      const errorClass = classifyFailure(observation?.error ?? state.error ?? "");
      const toolName = step.type === "tool" ? (step.toolName ?? "unspecified") : undefined;
      const id = failureClusterId({ userId: state.userId, stepType: step.type, toolName, errorClass });
      if (seen.has(id)) continue;
      seen.add(id);
      const ref = adminDb.collection(COLLECTION).doc(id);
      await adminDb.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const now = Date.now();
        if (!snapshot.exists) {
          tx.set(ref, {
            id,
            userId: state.userId,
            ...(options.agentId ? { agentId: options.agentId } : {}),
            ...(options.orgId ? { orgId: options.orgId } : {}),
            stepType: step.type,
            ...(toolName ? { toolName } : {}),
            errorClass,
            occurrences: 1,
            firstSeenAtMs: now,
            lastSeenAtMs: now,
            lastExecutionId: state.executionId,
            sampleMessage: (observation?.error ?? state.error ?? "").slice(0, 300),
            sampleStepName: step.name.slice(0, 200),
          });
        } else {
          tx.update(ref, {
            occurrences: FieldValue.increment(1),
            lastSeenAtMs: now,
            lastExecutionId: state.executionId,
            sampleMessage: (observation?.error ?? state.error ?? snapshot.get("sampleMessage") ?? "").slice(0, 300),
          });
        }
      });
      written++;
    }
    return written;
  } catch (error) {
    console.error("[evolution] clusters non enregistrés (fail-soft):", error instanceof Error ? error.message : error);
    return 0;
  }
}

export interface EvolutionBrief {
  /** Bloc texte compact injectable dans un prompt ("" si aucune leçon). */
  text: string;
  clusters: Array<{ errorClass: string; stepType: string; toolName?: string; occurrences: number; sample: string }>;
}

/** Brief d'écueils connus du principal (les plus récents d'abord, plafonné 8). */
export async function getEvolutionBrief(userId: string): Promise<EvolutionBrief> {
  try {
    const snapshot = await adminDb
      .collection(COLLECTION)
      .where("userId", "==", userId)
      .orderBy("lastSeenAtMs", "desc")
      .limit(8)
      .get();
    const clusters = snapshot.docs.map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        errorClass: String(data.errorClass ?? "other"),
        stepType: String(data.stepType ?? "llm"),
        ...(typeof data.toolName === "string" ? { toolName: data.toolName } : {}),
        occurrences: Number(data.occurrences ?? 1),
        sample: String(data.sampleMessage ?? "").slice(0, 160),
      };
    });
    if (clusters.length === 0) return { text: "", clusters };
    const lines = clusters.map(
      (cluster) => `- [${cluster.errorClass}] étape ${cluster.stepType}${cluster.toolName ? ` (${cluster.toolName})` : ""} : échoué ${cluster.occurrences}× — ${cluster.sample || "sans détail"}`,
    );
    return { text: `ÉCUEILS CONNUS à ne pas répéter (historique des échecs de cet utilisateur) :\n${lines.join("\n")}`, clusters };
  } catch {
    return { text: "", clusters: [] };
  }
}
