import { beforeEach, describe, expect, it } from "vitest";

import { MoteurWebGPUUnifie } from "./webgpu/webgpu-engine";
import { etatMemoireGpu, libererMemoireGpu, reinitialiserMemoireGpu, reserverMemoireGpu } from "./webgpu/webgpu-memory-manager";
import { viderPools } from "./webgpu/webgpu-buffer-pool";
import { classifierErreur } from "./webgpu/webgpu-error-handler";
import { routerTache } from "./compute-router";
import { executerHybride } from "./compute-hybrid";
import { demanderCalcul, definirProfilCerveau, lireVueCalcul, profilActif } from "./brain-bridge";
import type { CapacitesMateriel, TacheCalcul } from "./compute-types";

/**
 * TESTS PHASES 3-5 (mission WEBGPU) :
 *  · Phase 3 — moteur WebGPU unifié : device honnête en Node, budget
 *    mémoire refusant les dépassements, pool de buffers ;
 *  · Phase 4 — router + HYBRIDE RÉEL : les DEUX moteurs exécutent
 *    réellement leurs lots (preuve par compteurs + fusion vérifiée) ;
 *  · Phase 5 — bridge cerveau : demande unique, profil modifiable,
 *    métriques remontées, capacités exposées.
 */

const CAPS_GPU_SIMULE: CapacitesMateriel = {
  webgpuDisponible: true,
  adaptateur: "gpu-simule",
  maxBufferSizeOctets: 1024 * 1024 * 1024,
  environnement: "navigateur",
};

beforeEach(() => {
  reinitialiserMemoireGpu();
  viderPools();
  definirProfilCerveau("BALANCED");
});

describe("Phase 3 — moteur WebGPU unifié (honnêteté et ressources)", () => {
  it("Node : ouverture de session refusée avec raison honnête (pas de fiction)", async () => {
    const res = await MoteurWebGPUUnifie.ouvrirSession({ code: "code-wgsl", octetsRequis: 1024 });
    expect(res.session).toBeUndefined();
    expect(res.type).toBe("indisponible");
    expect(res.erreur).toContain("navigator.gpu absent");
  });

  it("budget mémoire : refus explicite au-delà du budget, jamais de dépassement", () => {
    const ok = reserverMemoireGpu(256 * 1024 * 1024);
    expect(ok.autorise).toBe(true);
    const trop = reserverMemoireGpu(2 * 1024 * 1024 * 1024);
    expect(trop.autorise).toBe(false);
    expect(trop.raison).toContain("REFUSÉE");
    const etat = etatMemoireGpu();
    expect(etat.refus).toBe(1);
    expect(etat.octetsUtilises).toBe(256 * 1024 * 1024);
  });

  it("libération redonne le budget (pas de fuite)", () => {
    reserverMemoireGpu(100);
    reserverMemoireGpu(100);
    expect(MoteurWebGPUUnifie.memoire().octetsUtilises).toBe(200);
    libererMemoireGpu(100);
    expect(MoteurWebGPUUnifie.memoire().octetsUtilises).toBe(100);
  });
});

describe("Phase 4 — router et hybride RÉEL (jamais une étiquette)", () => {
  it("famille non partitionnable : l'hybride demandé est refusé avec raison", () => {
    const tacheOndulatoire: TacheCalcul = { nom: "o", famille: "ondulatoire", elements: 1_000_000, octetsEntree: 256, octetsSortie: 64, memoireOctets: 1024 };
    const plan = routerTache(tacheOndulatoire, CAPS_GPU_SIMULE, "BALANCED");
    expect(plan.decision.moteur).not.toBe("hybride");
    expect(plan.decision.raison).toContain("partitionnable");
  });

  it("HYBRIDE RÉEL : les deux moteurs exécutent réellement leurs lots, fusion vérifiée", async () => {
    const lots = Array.from({ length: 10 }, (_, i) => i);
    let compteCpu = 0;
    let compteGpu = 0;
    const res = await executerHybride<number, number>(
      lots,
      { nom: "hybride-test", famille: "matriciel", elements: 10, octetsEntree: 40, octetsSortie: 8, memoireOctets: 64 },
      {
        executerLotCpu: async (lot) => { compteCpu++; return lot * 2 + 1; },
        executerLotGpu: async (lot) => { compteGpu++; return lot * 2 + 1; },
        verifierLot: (v) => Number.isFinite(v),
        portionGpu: 0.6,
      },
    );
    expect(compteCpu).toBe(4);   // 40 % des lots → exécutés RÉELLEMENT par le CPU
    expect(compteGpu).toBe(6);   // 60 % des lots → exécutés RÉELLEMENT par le GPU
    expect(res.executionsCpu).toBe(4);
    expect(res.executionsGpu).toBe(6);
    expect(res.fallbacksGpu).toBe(0);
    expect(res.fusionVerifiee).toBe(true);
    expect(res.resultatFusionne).toEqual(lots.map((l) => l * 2 + 1)); // ordre préservé
  });

  it("lot GPU en échec : repli CPU pour CE lot uniquement, aucun lot perdu", async () => {
    const lots = [0, 1, 2, 3, 4];
    const res = await executerHybride<number, number>(
      lots,
      { nom: "hybride-defaillance", famille: "reduction", elements: 5, octetsEntree: 20, octetsSortie: 8, memoireOctets: 32 },
      {
        executerLotCpu: async (lot) => lot + 100,
        executerLotGpu: async (lot) => (lot === 1 ? Promise.reject(new Error("device perdu")) : lot + 100),
        verifierLot: (v) => Number.isFinite(v),
        portionGpu: 0.8,
      },
    );
    expect(res.fallbacksGpu).toBe(1);
    expect(res.resultatFusionne).toEqual(lots.map((l) => l + 100));
    expect(res.fusionVerifiee).toBe(true);
  });

  it("erreurs GPU sont classifiées (journal mission Phase 10)", () => {
    const e = classifierErreur(new Error("WGSL: erreur de compilation ligne 3"));
    expect(e.type).toBe("compilation-wgsl");
    const p = classifierErreur(new Error("device perdu"));
    expect(p.type).toBe("device-perdu");
  });
});

describe("Phase 5 — bridge cerveau central (décideur unique)", () => {
  it("demande de calcul unique : décision motivée + métriques remontées (Node → CPU)", async () => {
    const reponse = await demanderCalcul<number>({
      tache: { nom: "cerveau-t1", famille: "neuronal", elements: 512, octetsEntree: 2048, octetsSortie: 64, memoireOctets: 2048 },
      executeurs: { cpu: async (t) => t.elements },
    });
    expect(reponse.decision.moteur).toBe("cpu");
    expect(reponse.decision.raison).toContain("neuronal");
    expect(reponse.moteurEffectif).toBe("cpu");
    expect(reponse.metrics.executions).toBeGreaterThan(0);
  });

  it("le cerveau change le profil : la vue reflète le changement", async () => {
    expect(profilActif()).toBe("BALANCED");
    definirProfilCerveau("ECO");
    const vue = await lireVueCalcul();
    expect(vue.profil).toBe("ECO");
    expect(vue.capacitesCpu.cpuDisponible).toBe(true);
    expect(vue.capacites.environnement).toBe("node");
    expect(vue.capacites.webgpuDisponible).toBe(false);
  });

  it("capacités CPU réelles : cœurs exposés par l'environnement, mémoire RSS côté Node", async () => {
    const vue = await lireVueCalcul();
    expect(vue.capacitesCpu.cœursLogiques).toBeGreaterThan(0);
    expect(typeof vue.capacitesCpu.contraintes).toBe("object");
  });
});
