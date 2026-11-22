import { randomUUID } from "node:crypto";

import { estTacheRecherchable, evalueDifficulte } from "@/lib/ai/raisonnement-profond";
import { executeTool } from "@/lib/tools/executor";
import type { ExecutionPolicy } from "@/lib/security/execution-policy";

/**
 * RECHERCHE WEB SYSTÉMATIQUE DU CHAT (demande produit 2026-11-22).
 *
 * Toute TÂCHE reçue par Gen3 (pas une salutation ni une micro-question)
 * déclenche AVANT la réponse une recherche web approfondie multi-pages :
 * l'objectif est double — comprendre EN DÉTAIL ce que l'utilisateur demande
 * (intention, contexte, terminologie du domaine) et fonder le raisonnement
 * sur des sources réelles. Le nombre de pages croît avec la difficulté du
 * prompt (plancher absolu : 10 pages réellement lues via web.deep_research).
 *
 * Fail-soft TOTAL : une panne de moteur de recherche ne bloque JAMAIS le
 * tour — le bloc porte alors les échecs explicites (honnêteté) ou disparaît.
 */

/** Budget temps du contexte systématique d'un tour chat (latence bornée). */
export const RECHERCHE_SYSTEMATIQUE_BUDGET_MS = 55_000;

/** Caractères maximum injectés dans le prompt du tour (budget contexte). */
export const RECHERCHE_SYSTEMATIQUE_MAX_CHARS = 12_000;

export interface SystematicResearchOptions {
  userId: string;
  projectId?: string;
  policy?: ExecutionPolicy;
  signal?: AbortSignal;
}

/**
 * Le tour doit-il déclencher la recherche web systématique ? Déterministe :
 * tâche (verbe d'action / question substantielle ≥ 30 caractères) et pas de
 * salutation pure. Le composant importe ce garde pour éviter tout appel
 * réseau sur « Bonjour ».
 */
export function tourExigeRechercheSystematique(message: string): boolean {
  return estTacheRecherchable(message);
}

/**
 * Exécute la recherche approfondie (outil web.deep_research — pipeline
 * sécurisé complet : autorisation, quotas, audit) et formate le bloc de
 * contexte injecté au modèle. Toute erreur est avalée en "" (fail-soft).
 */
export async function loadSystematicResearchContext(
  message: string,
  options: SystematicResearchOptions,
): Promise<string> {
  if (!tourExigeRechercheSystematique(message)) return "";
  const evaluation = evalueDifficulte(message);
  try {
    const result = await executeTool({
      userId: options.userId,
      executionId: randomUUID(),
      projectId: options.projectId,
      toolName: "web.deep_research",
      input: {
        objective: message.slice(0, 5_000),
        minPages: evaluation.pagesRequises,
        budgetMs: RECHERCHE_SYSTEMATIQUE_BUDGET_MS,
      },
      signal: options.signal,
      ...(options.policy ? { policy: options.policy } : {}),
    });
    if (!result.success) return "";
    const output = result.output as { synthese?: string; pagesOuvertes?: number; pagesRequises?: number } | undefined;
    const synthese = typeof output?.synthese === "string" ? output.synthese.trim() : "";
    if (!synthese) return "";
    return [
      "[RECHERCHE WEB SYSTÉMATIQUE — pages réellement lues pour comprendre ta demande :",
      ...(typeof output?.pagesOuvertes === "number" && typeof output?.pagesRequises === "number"
        ? `${output.pagesOuvertes}/${output.pagesRequises} (difficulté « ${evaluation.niveau} »)]`
        : "]"),
      synthese,
    ].join("\n").slice(0, RECHERCHE_SYSTEMATIQUE_MAX_CHARS);
  } catch {
    return ""; // jamais bloquant : le tour continue sans contexte web
  }
}
