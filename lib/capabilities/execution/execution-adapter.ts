/**
 * EXECUTION ADAPTER (UCE) — adaptateurs d'exécution par type de capacité.
 *
 * Un adaptateur déclare : quelles capacités il exécute, et comment. L'adapter
 * NATIF délègue à `executeTool()` du dépôt (arrêt d'urgence + politique +
 * consentements + audit déjà garantis par le chemin existant) — l'UCE ne
 * réimplémente JAMAIS une exécution déjà sécurisée.
 */

import "server-only";

import type { ExecutionPolicy } from "@/lib/security/execution-policy";
import type { ContexteExecutionUce } from "./execution-context";

export interface SortieAdaptateur {
  ok: boolean;
  /** Sortie sérialisable (déjà tronquée par l'appelant si besoin). */
  sortie?: unknown;
  erreur?: string;
  journaux: string[];
}

export interface AdaptateurExecution {
  /** Identifiant stable (ex. "outil-natif", "capacite-uce"). */
  id: string;
  /** Ce couple (capacité, toolName) est-il exécutable par cet adaptateur ? */
  peutExecuter(ctx: ContexteExecutionUce, cible: { type: "natif" | "uce" | "refus"; toolName?: string }): boolean;
  /** Exécution réelle — ne lève pas : retourne un échec honnête. */
  executer(ctx: ContexteExecutionUce): Promise<SortieAdaptateur>;
}

/** Adaptateur des outils NATIFS : délégation au chemin existant executeTool. */
export const adaptateurOutilNatif: AdaptateurExecution = {
  id: "outil-natif",
  peutExecuter(_ctx, cible) {
    return cible.type === "natif" && typeof cible.toolName === "string";
  },
  async executer(ctx) {
    const demande = ctx.demande;
    const { executeTool } = await import("@/lib/tools/executor");
    const resultat = await executeTool({
      userId: demande.userId,
      executionId: demande.executionId,
      projectId: demande.projectId,
      toolName: (demande.input as { toolName?: string } | undefined)?.toolName ?? "",
      input: (demande.input as { input?: unknown } | undefined)?.input ?? {},
      signal: ctx.signal,
      policy: (demande.input as { policy?: ExecutionPolicy } | undefined)?.policy,
    });
    return {
      ok: resultat.success,
      sortie: resultat.output,
      erreur: resultat.error,
      journaux: [`délégation executeTool(${(demande.input as { toolName?: string } | undefined)?.toolName}) → ${resultat.success ? "succès" : `échec : ${resultat.error}`}`],
    };
  },
};

/** Adaptateur des capacités UCE réellement intégrées (exécutables). */
export function creerAdaptateurUce(
  resolveur: (capabilityId: string) => Promise<{ executer?: (input: unknown, ctx: { userId: string }) => Promise<unknown> } | null>,
): AdaptateurExecution {
  return {
    id: "capacite-uce",
    peutExecuter(_ctx, cible) {
      return cible.type === "uce";
    },
    async executer(ctx) {
      const implementation = await resolveur(ctx.demande.capabilityId);
      if (!implementation?.executer) {
        return { ok: false, journaux: [`aucune implémentation exécutable enregistrée pour ${ctx.demande.capabilityId}`], erreur: "capacité sans exécuteur enregistré" };
      }
      const sortie = await implementation.executer(ctx.demande.input, { userId: ctx.demande.userId });
      return { ok: true, sortie, journaux: ["adaptateur UCE : exécution réelle de l'implémentation enregistrée"] };
    },
  };
}

/** Adaptateur de REFUS — capacité découverte mais jamais autorisée/intégrée. */
export const adaptateurRefusNonIntegree: AdaptateurExecution = {
  id: "refus-non-integree",
  peutExecuter(_ctx, cible) {
    return cible.type === "refus";
  },
  async executer(ctx) {
    return {
      ok: false,
      journaux: [`capacité ${ctx.demande.capabilityId} découverte mais NON intégrée : exécution refusée (mission §8 : une découverte n'est pas une autorisation)`],
      erreur: "capacité non intégrée : découvree ≠ autorisée. Passer par le cycle d'intégration UCE (autorisation humaine obligatoire).",
    };
  },
};
