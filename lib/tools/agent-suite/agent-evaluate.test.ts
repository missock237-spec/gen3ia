/**
 * Tests — OUTIL « agent.evaluate » (scorecard des trois registres réels).
 *
 * Aucun mock : l'outil lit les VRAIS registres de la plateforme. On vérifie
 * la classification déterministe (fonctionnel / partiel / bloqué / manquant),
 * le score et les recommandations FR.
 */

import { describe, expect, it } from "vitest";

import { agentEvaluateTool } from "./agent-evaluate";

describe("agent.evaluate — registre de conformité réel", () => {
  it("classe un outil complet comme fonctionnel (3 registres + libellé)", async () => {
    const resultat = await agentEvaluateTool.execute(
      { outils: ["decision.analyze"] },
      { userId: "u1" },
    );
    expect(resultat.outils).toHaveLength(1);
    const outil = resultat.outils[0];
    expect(outil.statut).toBe("fonctionnel");
    expect(outil.executeur).toBe(true);
    expect(outil.catalogue).toBe(true);
    expect(outil.securite).toBe(true);
    expect(outil.libelleFr).toBe(true);
    expect(outil.niveau).toBe("faible");
    expect(resultat.score).toBe(1);
    expect(resultat.recommandations).toHaveLength(0);
  });

  it("classe un outil inconnu comme manquant avec recommandation FR", async () => {
    const resultat = await agentEvaluateTool.execute(
      { outils: ["outil.inexistant"] },
      { userId: "u1" },
    );
    const outil = resultat.outils[0];
    expect(outil.statut).toBe("manquant");
    expect(outil.executeur).toBe(false);
    expect(outil.niveau).toBe("inconnu");
    expect(resultat.score).toBe(0);
    expect(resultat.recommandations[0]).toContain("« outil.inexistant » (manquant)");
  });

  it("évalue un lot mixte : score = fraction fonctionnelle, ordre conservé", async () => {
    const resultat = await agentEvaluateTool.execute(
      { outils: ["decision.analyze", "outil.inexistant", "knowledge.graph", "database.query"] },
      { userId: "u1" },
    );
    expect(resultat.outils.map((o) => o.outil)).toEqual([
      "decision.analyze",
      "outil.inexistant",
      "knowledge.graph",
      "database.query",
    ]);
    const fonctionnels = resultat.outils.filter((o) => o.statut === "fonctionnel").length;
    expect(resultat.score).toBeCloseTo(fonctionnels / 4, 4);
    // Les nouveaux outils de la vague v2.1 sont complets par construction.
    expect(resultat.outils.find((o) => o.outil === "database.query")?.statut).toBe("fonctionnel");
  });

  it("refuse une liste vide ou trop longue (schéma zod strict)", () => {
    expect(() => agentEvaluateTool.inputSchema.parse({ outils: [] })).toThrow();
    expect(() =>
      agentEvaluateTool.inputSchema.parse({ outils: Array.from({ length: 41 }, (_, i) => `t${i}`) }),
    ).toThrow();
    expect(() => agentEvaluateTool.inputSchema.parse({ outils: ["decision.analyze"], extra: 1 })).toThrow();
  });
});
