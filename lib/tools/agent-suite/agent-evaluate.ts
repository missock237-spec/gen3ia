import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";

/**
 * OUTIL « agent.evaluate » — évaluation de compétence d'un outillage
 * (vague post-audit v2.1, audit outils §3 : « agent.evaluate — tester les
 * compétences et la fiabilité des agents » ; et « Prochaine étape
 * recommandée : produire un registre de conformité avec quatre statuts »).
 *
 * RÉEL et DÉTERMINISTE : pour chaque outil demandé, vérifie les TROIS
 * registres canoniques de la plateforme (aucune opinion, aucun LLM) :
 *  1. registre d'EXÉCUTION (createDefaultToolRegistry) — l'outil a-t-il un
 *     exécuteur réel enregistré ?
 *  2. catalogue du PLANIFICATEUR (GEN3IA_TOOLS) — le planner le voit-il ?
 *  3. définition de SÉCURITÉ (TOOL_SECURITY / KNOWN_TOOL_SECURITY_NAMES) —
 *     authorizeTool lèvera-t-il « Unknown tool security definition » ?
 * Plus le libellé FR (invariant garde) et la classification de risque
 * HITL (niveauRisqueOutil, amendement v2.1). Score de couverture + statut
 * par outil : "fonctionnel" | "partiel" | "bloque" | "manquant".
 */

export const AgentEvaluateInput = z
  .object({
    outils: z
      .array(z.string().min(1))
      .min(1)
      .max(40)
      .describe("Noms d'outils à évaluer (ex. « web.search », « file.delete »)"),
  })
  .strict();

export type AgentEvaluateInputType = z.infer<typeof AgentEvaluateInput>;

export interface AgentEvaluateOutil {
  outil: string;
  /** Statut de conformité réel sur les trois registres. */
  statut: "fonctionnel" | "partiel" | "bloque" | "manquant";
  /** Registre d'exécution (exécuteur réel disponible). */
  executeur: boolean;
  /** Catalogue du planificateur (visible par le planner). */
  catalogue: boolean;
  /** Définition de sécurité (authorizeTool possible). */
  securite: boolean;
  /** Libellé FR présent (jamais le slug brut à l'utilisateur). */
  libelleFr: boolean;
  /** Niveau de risque HITL (amendement v2.1). */
  niveau: "faible" | "moyen" | "eleve" | "inconnu";
  /** Cause FR précise quand le statut n'est pas "fonctionnel". */
  cause?: string;
}

export interface AgentEvaluateOutput {
  outils: AgentEvaluateOutil[];
  /** Fraction d'outils "fonctionnel" (0..1). */
  score: number;
  /** Recommandations FR déterministes (registre à corriger, par outil). */
  recommandations: string[];
}

export const agentEvaluateTool: ToolDefinition<AgentEvaluateInputType, AgentEvaluateOutput> = {
  id: "agent.evaluate",
  name: "Évaluation des capacités d'un agent",
  description:
    "Évalue une liste d'outils contre les trois registres réels (exécution, catalogue planificateur, sécurité) + libellé FR + niveau de risque : statut par outil, score de couverture et recommandations de correction.",
  category: "system",
  risk: "low",
  inputSchema: AgentEvaluateInput,
  async execute(input): Promise<AgentEvaluateOutput> {
    // Import paresseux : chaque registre est la SOURCE CANONIQUE réelle.
    const { createDefaultToolRegistry } = await import("@/lib/tools/default-registry");
    const { GEN3IA_TOOLS } = await import("@/lib/tools/registry");
    const { KNOWN_TOOL_SECURITY_NAMES } = await import("@/lib/security/tool-permissions");
    const { toolLabel } = await import("@/lib/tools/labels");
    const { niveauRisqueOutil } = await import("@/lib/agents/approval-policy");

    const registre = createDefaultToolRegistry();
    const catalogue = new Set(GEN3IA_TOOLS.map((t) => t.name));

    const outils: AgentEvaluateOutil[] = input.outils.map((nom) => {
      const executeur = registre.get(nom) !== undefined;
      const dansCatalogue = catalogue.has(nom);
      const securite = KNOWN_TOOL_SECURITY_NAMES.has(nom);
      const libelle = toolLabel(nom);
      const libelleFr = libelle.length > 0 && libelle !== nom;
      const niveau: AgentEvaluateOutil["niveau"] = securite
        ? niveauRisqueOutil(nom)
        : "inconnu";

      let statut: AgentEvaluateOutil["statut"];
      const causes: string[] = [];
      if (executeur && dansCatalogue && securite) {
        statut = "fonctionnel";
      } else if (executeur && securite) {
        statut = "partiel";
        causes.push("invisible du planificateur (absent du catalogue GEN3IA_TOOLS)");
      } else if (executeur) {
        statut = "bloque";
        causes.push("aucune définition de sécurité — authorizeTool le rejettera à l'exécution");
      } else if (dansCatalogue || securite) {
        statut = "partiel";
        causes.push("annoncé mais AUCUN exécuteur enregistré (capacité fantôme)");
      } else {
        statut = "manquant";
        causes.push("inconnu des trois registres");
      }
      if (!libelleFr) causes.push("libellé FR absent (le slug brut fuirait à l'utilisateur)");

      return {
        outil: nom,
        statut,
        executeur,
        catalogue: dansCatalogue,
        securite,
        libelleFr,
        niveau,
        ...(causes.length > 0 ? { cause: causes.join(" ; ") } : {}),
      };
    });

    const fonctionnels = outils.filter((o) => o.statut === "fonctionnel").length;
    const score = outils.length > 0 ? fonctionnels / outils.length : 0;

    const recommandations = outils
      .filter((o) => o.statut !== "fonctionnel")
      .map((o) => `« ${o.outil} » (${o.statut}) : ${o.cause ?? "conformité incomplète"} — corriger le(s) registre(s) concerné(s).`);

    return { outils, score: Number(score.toFixed(4)), recommandations };
  },
};
