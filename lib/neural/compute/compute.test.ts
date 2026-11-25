import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detecterCapacites, reinitialiserDetection } from "./hardware-detector";
import { evaluerTache } from "./compute-policy";
import { avecFallbackCpu } from "./compute-fallback";
import { ComputeManager } from "./compute-manager";
import { RegistreMetrics } from "./compute-metrics";
import type { CapacitesMateriel, TacheCalcul } from "./compute-types";

/**
 * TESTS COMPUTE MANAGER (mission WEBGPU Phase 2) — la règle fondamentale :
 * jamais WebGPU « parce que disponible ». Détection honnête (Node = CPU
 * seul), décision motivée (taille/transfert/mémoire/profil), fallback CPU
 * systématique, métriques réelles.
 */

const CAPS_NODE: CapacitesMateriel = {
  webgpuDisponible: false,
  raisonIndisponibilite: "WebGPU absent de cet environnement (Node/serveur — API navigateur uniquement)",
  environnement: "node",
};

const CAPS_GPU_SIMULE: CapacitesMateriel = {
  webgpuDisponible: true,
  adaptateur: "gpu-simule",
  maxBufferSizeOctets: 1024 * 1024 * 1024,
  environnement: "navigateur",
};

const tache = (elements: number, famille: TacheCalcul["famille"] = "matriciel", octets = elements * 4): TacheCalcul => ({
  nom: `tache-${famille}-${elements}`,
  famille,
  elements,
  octetsEntree: octets,
  octetsSortie: 64,
  memoireOctets: octets,
});

beforeEach(() => {
  reinitialiserDetection();
});

afterEach(() => {
  reinitialiserDetection();
});

describe("détection honnête (mission : jamais de capacité inventée)", () => {
  it("Node/serveur : WebGPU indisponible avec raison explicite, CPU disponible", async () => {
    const caps = await detecterCapacites();
    expect(caps.webgpuDisponible).toBe(false);
    expect(caps.environnement).toBe("node");
    expect(caps.raisonIndisponibilite).toContain("Node");
  });

  it("le détecteur se réinitialise proprement (tests)", async () => {
    reinitialiserDetection();
    const caps = await detecterCapacites();
    expect(caps.environnement).toBe("node");
  });
});

describe("politique : jamais WebGPU « parce que disponible »", () => {
  it("famille « neuronal » : CPU par nature même avec GPU disponible", () => {
    const d = evaluerTache(tache(1_000_000, "neuronal"), CAPS_GPU_SIMULE, "PERFORMANCE");
    expect(d.moteur).toBe("cpu");
    expect(d.raison).toContain("déterminisme Gen3");
  });

  it("tâche trop petite : CPU même avec GPU disponible (coût de transfert)", () => {
    const d = evaluerTache(tache(256), CAPS_GPU_SIMULE);
    expect(d.moteur).toBe("cpu");
    expect(d.raison).toContain("trop petite");
  });

  it("grande tâche matricielle + GPU disponible : GPU décidé sur coût estimé", () => {
    const d = evaluerTache(tache(1_000_000), CAPS_GPU_SIMULE);
    expect(d.moteur).toBe("webgpu");
    expect(d.raison).toContain("GPU avantageux");
    expect(d.facteurs.coutEstimeGpu).toBeLessThan(d.facteurs.coutEstimeCpu);
  });

  it("profil MOBILE : seuil plus exigeant (une tâche moyenne reste CPU)", () => {
    // 8192 éléments : GPU au profil BALANCED (≥ 4096), CPU au profil MOBILE (≥ 16384).
    const moyenne = tache(8_192);
    expect(evaluerTache(moyenne, CAPS_GPU_SIMULE, "BALANCED").moteur).toBe("webgpu");
    expect(evaluerTache(moyenne, CAPS_GPU_SIMULE, "MOBILE").moteur).toBe("cpu");
  });

  it("mémoire au-delà de la limite déclarée : CPU (jamais de fiction)", () => {
    const grosse = { ...tache(2_000_000), memoireOctets: 2 * 1024 * 1024 * 1024 };
    const d = evaluerTache(grosse, CAPS_GPU_SIMULE);
    expect(d.moteur).toBe("cpu");
    expect(d.raison).toContain("maxBufferSize");
  });

  it("sans WebGPU : CPU avec la raison de l'indisponibilité", () => {
    const d = evaluerTache(tache(1_000_000), CAPS_NODE);
    expect(d.moteur).toBe("cpu");
    expect(d.raison).toContain("indisponible");
  });
});

describe("fallback CPU systématique (mission : aucune tâche perdue)", () => {
  it("échec GPU → repli CPU avec raison tracée", async () => {
    const res = await avecFallbackCpu<string>({
      moteurDemande: "webgpu",
      executerGpu: async () => { throw new Error("device perdu en cours de calcul"); },
      executerCpu: async () => "resultat-cpu",
    });
    expect(res.fallback).toBe(true);
    expect(res.moteurEffectif).toBe("cpu");
    expect(res.raisonFallback).toContain("device perdu");
    expect(res.resultat).toBe("resultat-cpu");
  });

  it("résultat GPU suspect (vérificateur) → repli CPU vérifié", async () => {
    const res = await avecFallbackCpu<number>({
      moteurDemande: "webgpu",
      executerGpu: async () => Number.NaN,
      executerCpu: async () => 42,
      verifier: (v) => Number.isFinite(v),
    });
    expect(res.fallback).toBe(true);
    expect(res.resultat).toBe(42);
  });

  it("GPU réussi : aucun fallback", async () => {
    const res = await avecFallbackCpu<number>({
      moteurDemande: "webgpu",
      executerGpu: async () => 7,
      executerCpu: async () => 8,
    });
    expect(res.fallback).toBe(false);
    expect(res.resultat).toBe(7);
  });
});

describe("ComputeManager (exécution réelle + métriques)", () => {
  const manager = new ComputeManager();

  beforeEach(() => {
    manager.reinitialiserMetrics();
  });

  it("exécute via le moteur décidé (Node → CPU), mesure et conserve les métriques", async () => {
    const res = await manager.executer(
      tache(512),
      { cpu: async (t) => `cpu:${t.elements}` },
      { capacitesSurchargées: CAPS_NODE },
    );
    expect(res.moteurEffectif).toBe("cpu");
    expect(res.resultat).toBe("cpu:512");
    expect(res.decision.moteur).toBe("cpu");
    expect(res.fallback).toBe(false);
    expect(res.metrics.parMoteur.cpu).toBeGreaterThan(0);
    expect(res.metrics.executions).toBeGreaterThan(0);
    // Énergie = ESTIMATION déclarée (jamais présentée comme mesure physique).
    expect(res.metrics.recentes[0].energie.nature).toBe("estimee");
  });

  it("chaîne complète : GPU simulé demandé mais échec → fallback CPU tracé dans les métriques", async () => {
    const res = await manager.executer(
      tache(1_000_000),
      { cpu: async () => "secours", webgpu: async () => { throw new Error("OOM GPU"); } },
      { capacitesSurchargées: CAPS_GPU_SIMULE },
    );
    expect(res.decision.moteur).toBe("webgpu"); // décision motivée par la politique
    expect(res.fallback).toBe(true);
    expect(res.moteurEffectif).toBe("cpu");
    expect(res.resultat).toBe("secours");
    expect(res.metrics.fallbacks).toBeGreaterThan(0);
    expect(res.metrics.parMoteur.cpu).toBeGreaterThan(0);
  });

  it("les décisions citent les facteurs (traçabilité cerveau central)", async () => {
    const res = await manager.executer(
      tache(1_000_000),
      { cpu: async () => 1, webgpu: async () => 2 },
      { capacitesSurchargées: CAPS_GPU_SIMULE },
    );
    expect(res.decision.facteurs.elements).toBe(1_000_000);
    expect(res.decision.facteurs.octetsTransfert).toBeGreaterThan(0);
    expect(res.decision.raison.length).toBeGreaterThan(10);
  });
});

describe("RegistreMetrics (p50/p95 réels)", () => {
  it("calcule p50/p95 sur échantillon borné", () => {
    const reg = new RegistreMetrics();
    for (let i = 1; i <= 100; i++) {
      reg.enregistrer({ nomTache: "t", moteur: "cpu", dureeMs: i, fallback: false, energie: { valeur: 1, unite: "unite-relative", nature: "estimee" } });
    }
    const s = reg.instantane();
    expect(s.executions).toBe(100);
    expect(s.dureeP50Ms).toBe(50);
    expect(s.dureeP95Ms).toBe(95);
    expect(s.dureeMoyenneMs).toBeCloseTo(50.5, 1);
  });
});
