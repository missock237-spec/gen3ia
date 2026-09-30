import type { RuntimePlan } from "@/lib/agents/runtime/types";

/**
 * HONNÊTETÉ DE LIVRAISON (étape 3 du plan 20) : une mission dont des étapes
 * ont échoué ne doit JAMAIS être annoncée comme « livrée ». Cette fonction
 * construit le texte final à partir des statuts RÉELS du plan — jamais de
 * la promesse du modèle. Utilisée par /api/agent/chat, /approve et /continue
 * pour une règle unique sur tous les chemins runtime.
 */

export interface FinalResponse {
  /** Texte final affiché à l'utilisateur (honnête sur les échecs). */
  text: string;
  /** true uniquement si AUCUNE étape n'a échoué. */
  ok: boolean;
  /** Titres des étapes en échec (liste explicite, sans invention). */
  failedSteps: string[];
}

const DELIVERABLE_TYPES = ["llm", "document", "media", "research"];
const DELIVERABLE_PREVIEW_LIMIT = 8_000;

function deliverableOutput(plan: RuntimePlan, outputs: Record<string, unknown>): string | undefined {
  const candidates = [...plan.steps].reverse().filter((step) => DELIVERABLE_TYPES.includes(step.type));
  for (const step of candidates) {
    const value = outputs[step.id];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function buildFinalResponse(
  plan: RuntimePlan,
  outputs: Record<string, unknown>,
  options: { completedFallback?: string } = {},
): FinalResponse {
  const failedSteps = plan.steps
    .filter((step) => step.status === "failed")
    .map((step) => step.description || step.name || step.id);
  const ok = failedSteps.length === 0;
  const deliverable = deliverableOutput(plan, outputs);

  if (ok) {
    return {
      ok: true,
      failedSteps: [],
      text: deliverable
        ?? options.completedFallback
        ?? "Le plan de l'agent a été exécuté. Consultez les étapes et résultats ci-dessous.",
    };
  }

  // Échecs présents : le texte nomme ce qui n'a PAS été livré et ce qui
  // existe réellement. Aucune formulation du type « livré / terminé ».
  const failedList = failedSteps.slice(0, 5).map((title) => `• ${title}`).join("\n");
  const producedSection = deliverable
    ? `\n\nCe qui a été produit malgré tout :\n\n${deliverable.slice(0, DELIVERABLE_PREVIEW_LIMIT)}${deliverable.length > DELIVERABLE_PREVIEW_LIMIT ? "…" : ""}`
    : "\n\nAucun livrable n'a été produit par les étapes réussies.";
  return {
    ok: false,
    failedSteps,
    text: `Mission incomplète : ${failedSteps.length} étape(s) en échec — ${failedSteps.length === 1 ? "elle n'a pas" : "elles n'ont pas"} été livrée(s) :\n${failedList}${producedSection}\n\nUtilisez « Continuer la mission » pour reprendre : les étapes réussies et leurs résultats sont conservés.`,
  };
}
