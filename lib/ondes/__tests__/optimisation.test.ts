import { describe, expect, it } from "vitest";

import {
  PLAFOND_VRAM_MOBILE,
  budgetVram,
  compterActivationSparse,
  economieZeroCopie,
  executerSparse,
  planifierPipelineZeroCopie,
  pipelineClassiqueReference,
  statsMemoire,
} from "../optimisation";
import { creerTenseur, dequantifierPhase, texteVersTenseur } from "../manifold";

/**
 * OPTIMISATION MÉMOIRE & EXÉCUTION MOBILE (Phase 3) — sparse,
 * quantification, pipeline zéro-copie. Spécification exécutable.
 */

describe("Activation sparse", () => {
  const t = creerTenseur(
    [1, 1, 0.5, 0.01, 0, 0.9, 0.03, 0],
    [0, 1, 2, 3, 4, 5, 6, 7],
    0.08,
  );

  it("compte exactement les nœuds au-dessus du seuil", () => {
    const s = compterActivationSparse(t, 0.02);
    expect(s.total).toBe(8);
    // Actifs : 1, 1, 0.5, 0.9, 0.03 — sous le seuil : 0.01 et deux zéros.
    expect(s.actifs).toBe(5);
    expect(s.opsEconomisees).toBe(3);
    expect(s.tauxActivation).toBeCloseTo(5 / 8, 12);
  });

  it("seuil 0 = passe dense complète, epsilon n'épargne que les muets", () => {
    // Seuil 0 : TOUS les nœuds passent le test (0 ≥ 0) — passe dense.
    expect(compterActivationSparse(t, 0).actifs).toBe(8);
    // Un epsilon n'active que les 6 nœuds d'amplitude non nulle.
    expect(compterActivationSparse(t, 1e-9).actifs).toBe(6);
    expect(compterActivationSparse(t, 1.01).actifs).toBe(0);
  });
});

describe("executerSparse — le résultat est IDENTIQUE au dense", () => {
  it("somme des sinusoïdes : sparse == somme manuelle des actifs", () => {
    const t = texteVersTenseur("un tenseur creux pour le test sparse", 256);
    const operation = (i: number, a: number, th: number) =>
      a * Math.sin(2 * Math.PI * (0.01 + i / t.nbNoeuds) + th);
    const reduire = (acc: number, v: number) => acc + v;

    const sparse = executerSparse(t, operation, reduire, 0, 0.05);

    // Référence indépendante : somme manuelle des nœuds actifs.
    let reference = 0;
    let compte = 0;
    for (let i = 0; i < t.nbNoeuds; i++) {
      const a = t.amplitudes[i] / 65535;
      if (a < 0.05) continue;
      reference += operation(i, a, dequantifierPhase(t.phases[i]));
      compte++;
    }
    expect(sparse.resultat).toBeCloseTo(reference, 9);
    expect(sparse.opsExecutees).toBe(compte);
    expect(sparse.opsExecutees).toBeGreaterThan(0);
    expect(sparse.opsExecutees).toBeLessThan(sparse.opsDense);
  });

  it("seuil 0 = passe dense complète (toutes les opérations)", () => {
    const t = texteVersTenseur("dense", 64);
    const r = executerSparse(
      t,
      (i) => i,
      (acc, v) => Math.max(acc, v),
      -1,
      0,
    );
    expect(r.opsExecutees).toBe(r.opsDense);
    expect(r.opsDense).toBe(64);
  });
});

describe("Quantification & budget mémoire", () => {
  it("le tenseur quantifié coûte la moitié du couple FP32", () => {
    const s = statsMemoire(4096);
    expect(s.octetsTenseur).toBe(16384);
    expect(s.octetsFlottant).toBe(32768);
    expect(s.economieOctets).toBe(16384);
    expect(s.economiePct).toBeCloseTo(50, 12);
  });

  it("budget VRAM : un tenseur 4096 nœuds + texture 256² tient largement", () => {
    const b = budgetVram(4096, "image", { largeur: 256, hauteur: 256 });
    expect(b.octetsTenseur).toBe(4096 * 4);
    expect(b.octetsSortieParImage).toBe(256 * 256 * 4);
    expect(b.octetsTotalParImage).toBe(4096 * 4 + 256 * 256 * 4);
    expect(b.tient).toBe(true);
    expect(b.marge).toBeGreaterThan(PLAFOND_VRAM_MOBILE - b.octetsTotalParImage - 1);
  });

  it("budget VRAM audio : le bloc Float32 est compté honnêtement", () => {
    const b = budgetVram(256, "audio", { tailleBloc: 1024 });
    expect(b.octetsSortieParImage).toBe(1024 * 4);
    expect(b.tient).toBe(true);
  });
});

describe("Pipeline zéro-copie", () => {
  it("image : ZÉRO octet ne traverse le CPU, flux GPU → présentation", () => {
    const p = planifierPipelineZeroCopie("image", { largeur: 256, hauteur: 256, nbNoeuds: 256 });
    expect(p.copiesGpuCpuParImage).toBe(0);
    expect(p.octetsTraversantCpu).toBe(0);
    const cibles = p.etapes.map((e) => e.cible);
    expect(cibles).toEqual(["gpu", "gpu", "presentation"]);
    expect(p.note).toMatch(/ZÉRO octet/);
  });

  it("vidéo : même contrat zéro-copie que l'image", () => {
    const p = planifierPipelineZeroCopie("video", { largeur: 256, hauteur: 256, nbNoeuds: 256 });
    expect(p.copiesGpuCpuParImage).toBe(0);
    expect(p.octetsTraversantCpu).toBe(0);
  });

  it("audio : honnêteté — le PCM traverse le CPU PAR BLOCS de 1024", () => {
    const p = planifierPipelineZeroCopie("audio", { tailleBloc: 1024, nbNoeuds: 256 });
    expect(p.etapes.some((e) => e.cible === "worklet")).toBe(true);
    // 44 100 / 1 024 → 44 blocs·s⁻¹ de 4 Ko.
    expect(p.copiesGpuCpuParImage).toBe(44);
    expect(p.octetsTraversantCpu).toBe(44 * 4096);
    expect(p.latenceMsEstimee).toBeCloseTo((1024 / 44100) * 1000, 6);
    expect(p.note).toMatch(/LIMITÉE aux blocs/);
  });

  it("image : 100 % du volume GPU→CPU du pipeline classique est économisé", () => {
    const eco = economieZeroCopie("image", { largeur: 256, hauteur: 256 });
    const classique = pipelineClassiqueReference("image", { largeur: 256, hauteur: 256 });
    expect(eco.octetsEconomisesParImage).toBe(classique.octetsTraversantCpu);
    expect(eco.reductionPct).toBeCloseTo(100, 12);
  });

  it("audio : l'économie est en LATENCE (volume quasi identique — honnêteté)", () => {
    const eco = economieZeroCopie("audio", { nbEchantillons: 44100 });
    // Le volume ne change presque pas (le PCM doit atteindre le worklet).
    expect(eco.reductionPct).toBeLessThan(5);
    // Mais la latence avant le premier octet s'effondre : 1 000 ms → ~23 ms.
    expect(eco.latenceClassiqueMsEstimee).toBeCloseTo(1000, 6);
    expect(eco.latenceZeroCopieMsEstimee).toBeCloseTo((1024 / 44100) * 1000, 6);
    expect(eco.latenceClassiqueMsEstimee / eco.latenceZeroCopieMsEstimee).toBeGreaterThan(40);
  });
});
