import { describe, expect, it } from "vitest";

import {
  AgentAutomatisation,
  AgentCalcul,
  AgentCode,
  AgentTri,
  AgentVeille,
} from "../agents-specialises";
import type { TacheAgent } from "../types";

function tache(
  type: TacheAgent["type"],
  charge: Record<string, unknown>,
): TacheAgent {
  return {
    id: "t-test",
    type,
    charge,
    priorite: "normale",
    emiseA: Date.now(),
    emetteur: "n-test",
    statut: "en-attente",
    delaiMs: 6000,
  };
}

describe("AgentVeille", () => {
  it("détecte les ajouts, modifications et suppressions", () => {
    const agent = new AgentVeille();
    const r = agent.executer(
      tache("veille", {
        sujet: "serveurs",
        avant: [
          { cle: "a", valeur: "1" },
          { cle: "b", valeur: "2" },
          { cle: "c", valeur: "3" },
        ],
        apres: [
          { cle: "a", valeur: "9" }, // modifié
          { cle: "b", valeur: "2" }, // inchangé
          { cle: "d", valeur: "4" }, // ajouté
        ],
      }),
    );
    expect(r.donnees?.modifies).toEqual(["a"]);
    expect(r.donnees?.ajoutes).toEqual(["d"]);
    expect(r.donnees?.supprimes).toEqual(["c"]);
    expect(r.donnees?.ruptures).toBe(3);
    expect(r.resume).toContain("rupture");
  });

  it("signale un signal stable sans faux positif", () => {
    const agent = new AgentVeille();
    const r = agent.executer(
      tache("veille", {
        sujet: "flux",
        avant: [{ cle: "x", valeur: "1" }],
        apres: [{ cle: "x", valeur: "1" }],
      }),
    );
    expect(r.resume).toContain("stable");
    expect(r.donnees?.ruptures).toBe(0);
  });

  it("reste honnête sans données", () => {
    const agent = new AgentVeille();
    const r = agent.executer(tache("veille", { sujet: "rien" }));
    expect(r.confiance).toBeLessThan(0.5);
  });
});

describe("AgentTri", () => {
  it("répartit les éléments par critère", () => {
    const agent = new AgentTri();
    const r = agent.executer(
      tache("tri", {
        elements: ["facture janvier", "contrat d'achat", "facture février"],
        criteres: ["facture", "contrat"],
      }),
    );
    expect((r.donnees?.repartition as Record<string, string[]>)["facture"]).toHaveLength(2);
    expect((r.donnees?.repartition as Record<string, string[]>)["contrat"]).toHaveLength(1);
    expect(r.donnees?.nonClasse).toHaveLength(0);
    expect(r.confiance).toBeGreaterThan(0.8);
  });

  it("avoue les éléments non classés", () => {
    const agent = new AgentTri();
    const r = agent.executer(
      tache("tri", { elements: ["xyz inclassable"], criteres: ["facture"] }),
    );
    expect(r.donnees?.nonClasse).toHaveLength(1);
    expect(r.confiance).toBeLessThan(0.9);
  });

  it("trie alphabétiquement sans critère", () => {
    const agent = new AgentTri();
    const r = agent.executer(tache("tri", { elements: ["b", "a", "c"] }));
    expect(r.donnees?.tries).toEqual(["a", "b", "c"]);
  });
});

describe("AgentCalcul", () => {
  it("évalue une expression via l'AST sûr", () => {
    const agent = new AgentCalcul();
    const r = agent.executer(tache("calcul", { expression: "2 + 3 * 4" }));
    expect(r.donnees?.valeur).toBe(14);
    expect(r.confiance).toBeGreaterThan(0.9);
  });

  it("refuse une expression dangereuse sans planter", () => {
    const agent = new AgentCalcul();
    const r = agent.executer(tache("calcul", { expression: "process.exit(1)" }));
    expect(r.confiance).toBeLessThan(0.5);
    expect(r.resume).toContain("refusé");
  });

  it("calcule des statistiques descriptives", () => {
    const agent = new AgentCalcul();
    const r = agent.executer(tache("calcul", { valeurs: [2, 4, 4, 4, 5, 5, 7, 9] }));
    expect(r.donnees?.moyenne).toBeCloseTo(5, 6);
    expect(r.donnees?.mediane).toBeCloseTo(4.5, 6);
    expect(r.donnees?.minimum).toBe(2);
    expect(r.donnees?.maximum).toBe(9);
    // écart-type de la série canonique = 2
    expect(r.donnees?.ecartType).toBeCloseTo(2, 6);
  });
});

describe("AgentCode", () => {
  it("compte les fonctions et la complexité", () => {
    const agent = new AgentCode();
    const r = agent.executer(
      tache("code", {
        code: "function a(x) { if (x) return 1; return 0; }\nfunction b() { return 2; }",
      }),
    );
    expect(r.donnees?.lignes).toBe(2);
    expect(r.donnees?.complexite).toBe(2);
    expect((r.donnees?.fonctions as string[]).sort()).toEqual(["a", "b"]);
  });

  it("signale les motifs risqués", () => {
    const agent = new AgentCode();
    const r = agent.executer(
      tache("code", { code: "const secret = eval('1+1'); fetch('/x');" }),
    );
    const risques = r.donnees?.risques as string[];
    expect(risques).toContain("eval");
    expect(risques).toContain("accès réseau");
  });

  it("garde son calme sur du code sain", () => {
    const agent = new AgentCode();
    const r = agent.executer(tache("code", { code: "const addition = (a, b) => a + b;" }));
    expect(r.donnees?.risques).toHaveLength(0);
  });
});

describe("AgentAutomatisation", () => {
  it("chaîne des étapes et agrège les comptes-rendus", () => {
    const agent = new AgentAutomatisation();
    const r = agent.executer(
      tache("automatisation", {
        etapes: [
          { type: "calcul", charge: { expression: "6 * 7" } },
          { type: "tri", charge: { elements: ["a facture"], criteres: ["facture"] } },
        ],
      }),
    );
    expect(r.resume).toContain("2 étape(s)");
    const comptes = r.donnees?.comptesRendus as Array<{ resume: string }>;
    expect(comptes).toHaveLength(2);
    expect(comptes[0].resume).toContain("42");
  });

  it("interdit la récursion d'automatisation", () => {
    const agent = new AgentAutomatisation();
    const r = agent.executer(
      tache("automatisation", {
        etapes: [{ type: "automatisation", charge: { etapes: [] } }],
      }),
    );
    const comptes = r.donnees?.comptesRendus as Array<{ resume: string }>;
    expect(comptes[0].resume).toContain("ignorée");
  });

  it("reste honnête sans étapes", () => {
    const agent = new AgentAutomatisation();
    const r = agent.executer(tache("automatisation", {}));
    expect(r.confiance).toBeLessThan(0.5);
  });
});
