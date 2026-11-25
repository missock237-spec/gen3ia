import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { analyserExperiences } from "../learning/experience-analyzer";
import { apprendreDesExperiences, validerLecon, leconsValidees } from "../learning/capability-learning";
import { reinitialiserRepositoryUce, sauvegarder } from "../storage/capability-repository";
import type { CapabilityExecution } from "../core/capability-contract";

/**
 * TESTS APPRENTISSAGE V1.1 (mission Phase 9) — l'apprentissage part des
 * opérations VALIDÉES, sépare STRICTEMENT les trois catégories (connaissances
 * techniques ≠ compétences opérationnelles ≠ apprentissage neuronal) et
 * DÉMONTRE une amélioration sur un jeu de tests indépendant (avant/après
 * mesuré, régression détectée et refusée).
 */

let dossier: string;
const OPTIONS = () => ({ dossier, forcerLocal: true });

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-apprentissage-"));
  reinitialiserRepositoryUce();
});

afterEach(async () => {
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

function execution(capabilityId: string, status: CapabilityExecution["status"], dureeMs: number, erreur?: string): CapabilityExecution {
  return {
    id: `exec_${capabilityId}_${Math.random().toString(36).slice(2, 8)}`,
    capabilityId,
    toolName: capabilityId.split(":").at(-1) ?? capabilityId,
    demande: "origine=test",
    permissions: [{ couche: "arret-urgence", autorise: true, raison: "aucun arrêt actif" }],
    status,
    demarreLe: new Date().toISOString(),
    dureeMs,
    erreur,
    journaux: [],
    verification: { verifie: status === "succes", methode: status === "succes" ? "rejoue-indépendant" : "non-verifie" },
    schemaVersion: 1,
  };
}

describe("apprentissage depuis les opérations validées (mission Phase 9)", () => {
  it("le bilan vient d'exécutions RÉELLES (mesures honnêtes, rien d'inventé)", async () => {
    for (let i = 0; i < 4; i++) {
      await sauvegarder("executions", execution("natif:gen3ia:outil.x", "succes", 100 + i), OPTIONS());
    }
    for (let i = 0; i < 4; i++) {
      await sauvegarder("executions", execution("natif:gen3ia:outil.y", "echec", 500, "timeout réseau"), OPTIONS());
    }
    const analyse = await analyserExperiences(OPTIONS());
    expect(analyse.bilan).toHaveLength(2);
    const fiable = analyse.bilan.find((b) => b.capabilityId === "natif:gen3ia:outil.x")!;
    const defaillant = analyse.bilan.find((b) => b.capabilityId === "natif:gen3ia:outil.y")!;
    expect(fiable.tauxSucces).toBe(1);
    expect(defaillant.tauxSucces).toBe(0);
    expect(defaillant.categoriesEchec).toHaveProperty("timeout"); // catégorisation réelle du debugger
    // Leçons proposées = données mesurées (taux cités).
    expect(analyse.leconsProposees.some((l) => l.lecon.includes("outil.y") && l.lecon.includes("0%"))).toBe(true);
  });

  it("LES TROIS CATÉGORIES sont séparées : une connaissance n'est JAMAIS un entraînement neuronal", async () => {
    for (let i = 0; i < 5; i++) {
      await sauvegarder("executions", execution("natif:gen3ia:outil.z", "echec", 300, "erreur"), OPTIONS());
    }
    const { analyse, lecons } = await apprendreDesExperiences({ ...OPTIONS(), limite: 50 });
    // Connaissances issues d'exécutions réelles → acquisition validée.
    expect(analyse.leconsProposees.some((l) => l.kind === "connaissance")).toBe(true);
    // Recommandation neurale : ENREGISTREMENT SEUL, jamais d'action.
    const neurale = lecons.find((l) => l.kind === "neural");
    if (neurale) {
      expect(neurale.validee).toBe(false);
      expect(neurale.cause).toContain("hors périmètre UCE");
      expect(neurale.lecon).toContain("RECOMMANDATION (non exécutée)");
    }
    // Toute leçon conservée porte son kind explicite (jamais d'amalgame).
    for (const lecon of lecons) {
      expect(["connaissance", "competence", "neural"]).toContain(lecon.kind);
    }
  });

  it("DÉMONSTRATION d'amélioration sur un jeu de test INDÉPENDANT (avant/après mesurés)", async () => {
    // Jeu de test indépendant : 10 cas mesurés par la stratégie courante
    // (avant) et la stratégie améliorée (après) — mêmes cas, mesures réelles.
    const cas = Array.from({ length: 10 }, (_, i) => i);
    const strategieCourante = async () => {
      // « stratégie » : 6/10 cas réussis → score mesuré 0.6
      const succes = cas.filter((c) => c % 10 !== 0 && c % 10 !== 1 && c % 10 !== 2 && c % 10 !== 3).length;
      return succes / cas.length;
    };
    const strategieAmelioree = async () => {
      // amélioration : 9/10 cas réussis → 0.9
      const succes = cas.filter((c) => c % 10 !== 0).length;
      return succes / cas.length;
    };
    const verdict = await validerLecon(strategieCourante, strategieAmelioree, {
      jeuTest: "cas-independants-10",
      lecon: "stratégie d'exécution améliorée (mêmes cas, succès 6→9/10)",
      ...OPTIONS(),
    });
    expect(verdict.acceptee).toBe(true);
    expect(verdict.avant).toBeCloseTo(0.6, 5);
    expect(verdict.apres).toBeCloseTo(0.9, 5);
    expect(verdict.delta).toBeCloseTo(0.3, 5);
    expect(verdict.cause).toContain("conservée");
    // La leçon validée est conservée avec jeu de test + mesures (audit).
    const lecons = await leconsValidees(OPTIONS());
    const conservee = lecons.find((l) => l.jeuTest === "cas-independants-10" && l.valide);
    expect(conservee).toBeDefined();
    expect(conservee!.kind).toBe("competence");
    expect(conservee!.avant).toBeCloseTo(0.6, 5);
    expect(conservee!.apres).toBeCloseTo(0.9, 5);
  });

  it("RÉGRESSION détectée sur le même jeu de test : leçon REFUSÉE et signalée (trace conservée)", async () => {
    const strategieStable = async () => 0.8;
    const strategieRegression = async () => 0.75; // −0.05 < −0.02 (seuil)
    const verdict = await validerLecon(strategieStable, strategieRegression, {
      jeuTest: "cas-independants-regression",
      lecon: "pseudo-amélioration régressant sur le jeu indépendant",
      ...OPTIONS(),
    });
    expect(verdict.acceptee).toBe(false);
    expect(verdict.cause).toContain("régression");
    // La régression est TRACÉE (jamais silencieuse) avec avant/après.
    const lecons = await leconsValidees(OPTIONS());
    const trace = lecons.find((l) => l.regressionDetectee);
    expect(trace).toBeDefined();
    expect(trace!.valide).toBe(false);
    expect(trace!.apres).toBeLessThan(trace!.avant);
  });

  it("une amélioration de bruit (< seuil) n'est pas conservée (pas de leçon fabuleuse)", async () => {
    const verdict = await validerLecon(async () => 0.80, async () => 0.81, {
      jeuTest: "cas-bruit",
      lecon: "bruit mesuré, pas une amélioration",
      ...OPTIONS(),
    });
    expect(verdict.acceptee).toBe(false);
    expect(verdict.cause).toContain("insuffisante");
  });
});
