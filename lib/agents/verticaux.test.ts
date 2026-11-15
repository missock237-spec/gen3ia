import { describe, expect, it } from "vitest";

import { buildAgentCharter, wizardTypeForKey } from "@/lib/agents/charter";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { validateWorkflow } from "@/lib/workflows/validator";
import { WorkflowSchema } from "@/lib/workflows/types";
import {
  VERTICAUX,
  construireWorkflowTemplate,
  verticalParCle,
} from "@/lib/agents/verticaux";

/**
 * PREUVE « BOUT EN BOUT » DES 3 VERTICAUX (P3) — restaurant WhatsApp,
 * prospection, contenu.
 *
 * Chaque vertical est vérifié MÉCANIQUEMENT sur toute la chaîne réelle :
 *   1. type wizard résolu (le type apparaît dans le wizard UI) ;
 *   2. charte professionnelle construite (mêmes règles de conduite que
 *      les agents de production) ;
 *   3. chaque outil déclaré EXISTE dans TOOL_REGISTRY (un outil absent
 *      ferait échouer executeToolSecurely à l'exécution) ;
 *   4. le template de workflow est conforme à WorkflowSchema ET validé par
 *      validateWorkflow (aucun cycle, arêtes connues) — donc exécutable
 *      par runWorkflowGraph ;
 *   5. les nœuds tool référencent des outils du registre et le vertical
 *      déclare bien ces outils (whitelist cohérente) ;
 *   6. les déclencheurs correspondent aux capacités P2 (webhook = token,
 *      cron = intervalle 5..1440).
 */

const CLES_ATTENDUES = ["restaurant-whatsapp", "sales", "content"];

describe("verticaux clés en main (P3)", () => {
  it("expose exactement les 3 verticaux demandés", () => {
    expect(VERTICAUX.map((v) => v.key)).toEqual(CLES_ATTENDUES);
    expect(verticalParCle("restaurant-whatsapp")).toBeDefined();
    expect(verticalParCle("inexistant")).toBeUndefined();
  });

  for (const vertical of VERTICAUX) {
    describe(`vertical « ${vertical.key} »`, () => {
      it("a un type wizard résolvable et une charte construite", () => {
        const type = wizardTypeForKey(vertical.key);
        expect(type).toBeDefined();
        expect(type!.label).toBe(vertical.label);
        // Les outils du vertical sont déclarés au type wizard (whitelist
        // complète peut être plus large pour les types existants).
        for (const outil of vertical.outils) {
          expect(type!.declaredTools).toContain(outil);
        }

        const charte = buildAgentCharter({
          name: `Agent ${vertical.label}`,
          description: vertical.description,
          type: vertical.key,
          typeLabel: vertical.label,
          skills: vertical.competences,
        });
        expect(charte.length).toBeGreaterThan(200);
        expect(charte).toContain(vertical.label);
        // Règles de conduite professionnelles héritées (anti-hallucination).
        expect(charte).toContain("RÈGLES DE CONDUITE PROFESSIONNELLE");
      });

      it("déclare uniquement des outils RÉELS du registre", () => {
        const nomsRegistre = new Set(GEN3IA_TOOLS.map((t) => t.name));
        expect(vertical.outils.length).toBeGreaterThan(0);
        for (const outil of vertical.outils) {
          expect(nomsRegistre.has(outil)).toBe(true);
        }
      });

      it("a un template de workflow valide et exécutable", () => {
        const workflow = construireWorkflowTemplate(vertical);

        // Conforme au schéma zod (même contrat que la route de création).
        const parse = WorkflowSchema.safeParse(workflow);
        expect(parse.success).toBe(true);

        // Aucun cycle, toutes les arêtes connues (validateur de production).
        const validation = validateWorkflow(workflow);
        expect(validation.errors).toEqual([]);
        expect(validation.valid).toBe(true);

        // Nœuds de sortie présents, nœuds agent avec tâche.
        expect(workflow.nodes.some((n) => n.type === "output")).toBe(true);
        for (const noeudAgent of workflow.nodes.filter((n) => n.type === "agent")) {
          expect(String(noeudAgent.config.task ?? noeudAgent.config.instructions ?? "").length).toBeGreaterThan(10);
        }
      });

      it("n'utilise dans ses nœuds tool que des outils du registre, déclarés au vertical", () => {
        const workflow = construireWorkflowTemplate(vertical);
        const nomsRegistre = new Set(GEN3IA_TOOLS.map((t) => t.name));
        const outilsNoeuds = workflow.nodes
          .filter((n) => n.type === "tool")
          .map((n) => String(n.config.toolName));
        expect(outilsNoeuds.length).toBeGreaterThan(0);
        for (const outil of outilsNoeuds) {
          expect(nomsRegistre.has(outil)).toBe(true);
          expect(vertical.outils).toContain(outil);
        }
      });

      it("a un déclencheur cohérent avec les capacités webhook/cron (P2)", () => {
        if (vertical.declencheur.type === "cron") {
          expect(vertical.declencheur.intervalMinutes).toBeGreaterThanOrEqual(5);
          expect(vertical.declencheur.intervalMinutes).toBeLessThanOrEqual(1440);
        } else {
          expect(vertical.declencheur.intervalMinutes).toBeUndefined();
        }
      });
    });
  }

  it("le vertical restaurant route la commande complète VERS la confirmation, l'incomplete VERS la relance", () => {
    const workflow = construireWorkflowTemplate(verticalParCle("restaurant-whatsapp")!);
    const condition = workflow.nodes.find((n) => n.type === "condition");
    expect(condition).toBeDefined();
    const aretes = workflow.edges.filter((e) => e.source === condition!.id);
    const conditions = aretes.map((a) => a.condition).sort();
    expect(conditions).toEqual(["false", "true"]);
    const cibleTrue = workflow.edges.find((e) => e.source === condition!.id && e.condition === "true")!;
    const cibleFalse = workflow.edges.find((e) => e.source === condition!.id && e.condition === "false")!;
    const nomCibleTrue = workflow.nodes.find((n) => n.id === cibleTrue.target)!.name;
    const nomCibleFalse = workflow.nodes.find((n) => n.id === cibleFalse.target)!.name;
    expect(nomCibleTrue).toContain("Confirmation");
    expect(nomCibleFalse).toContain("manquante");
  });
});
