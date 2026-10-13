import { randomUUID } from "node:crypto";
import { z } from "zod";

import { generateForUser } from "@/lib/billing/ai-execution";
import type { TaskType } from "@/lib/ai/models";

/**
 * Task 140 — Socle partagé des outils de la suite « agent IA ».
 *
 * Deux besoins récurrents pour les 16 nouveaux outils pilotés par les
 * agents : appeler le LLM au NOM de l'utilisateur (facturation wallet via
 * generateForUser, la même voie que le runtime d'agents) avec une sortie
 * STRUCTURÉE validée par zod, et extraire le premier objet JSON d'une
 * réponse texte (fences markdown tolérées).
 *
 * Contrat d'erreur : français, explicite, jamais de masquage — si le
 * modèle ne produit pas un JSON conforme au schéma après les tentatives,
 * l'erreur nomme l'étape défaillante.
 */

/** Fenêtre de recherche d'un objet JSON dans une réponse LLM (anti-scan). */
const MAX_JSON_SCAN_LENGTH = 200_000;

/**
 * Extrait le premier objet JSON équilibré d'un texte LLM.
 * Tolère les fences ```json … ```, le texte d'introduction et de conclusion.
 * Retourne `undefined` si aucun objet complet n'est trouvé.
 */
export function extractFirstJsonObject(raw: string): unknown {
  if (!raw) return undefined;
  const text = raw.slice(0, MAX_JSON_SCAN_LENGTH);
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export interface GenerateStructuredParams<T> {
  userId: string;
  executionId?: string;
  task: TaskType;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxTokens?: number;
  /** Tentatives totales (par défaut 2 : l'appel initial + une relance corrective). */
  maxAttempts?: number;
  complexity?: number;
}

/**
 * Appel LLM facturé (wallet utilisateur) avec sortie JSON validée par zod.
 *
 * Séquence : generateForUser (réserve → appelle → settle) → extraction du
 * premier objet JSON → parse zod. En cas d'écart de schéma, UNE relance
 * corrective injecte l'erreur de validation au modèle avant d'abandonner
 * avec l'erreur française explicite.
 */
export async function generateStructuredForUser<T>(params: GenerateStructuredParams<T>): Promise<T> {
  const attempts = Math.max(1, Math.min(3, params.maxAttempts ?? 2));
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const corrective = attempt > 1 && lastError
      ? `\n\nATTENTION — ta réponse précédente était invalide pour cette raison : ${lastError}. Corrige et renvoie UNIQUEMENT le JSON valide conforme au schéma demandé.`
      : "";
    const billed = await generateForUser({
      userId: params.userId,
      executionId: params.executionId ?? `suite_${randomUUID()}`,
      request: {
        task: params.task,
        system: params.system,
        messages: [{ role: "user", content: `${params.user}${corrective}` }],
        requiresStructuredOutput: true,
        maxTokens: params.maxTokens ?? 4_000,
      },
      complexity: params.complexity,
    });

    const candidate = extractFirstJsonObject(billed.response.text);
    if (candidate === undefined) {
      lastError = "aucun objet JSON détecté dans la réponse";
      continue;
    }
    const parsed = params.schema.safeParse(candidate);
    if (parsed.success) return parsed.data;
    lastError = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "(racine)"} : ${issue.message}`)
      .join(" ; ");
  }

  throw new Error(
    `Le modèle n'a pas produit une réponse conforme au format attendu après ${attempts} tentative(s)${lastError ? ` — dernier écart : ${lastError}` : ""}.`,
  );
}
