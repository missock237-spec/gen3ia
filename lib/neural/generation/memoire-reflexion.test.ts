/**
 * GARDE MÉMOIRE DE RÉFLEXION — la délibération gen3 doit offrir des choix
 * réels, une mémoire bornée lisible, et ne JAMAIS faire moins bien que la
 * voie directe (non-régression : le réflexif commence TOUJOURS par la
 * requête originale).
 */
import { describe, expect, it } from "vitest";

import { CORPUS_GEN3 } from "./corpus";
import { PAIRES_MULTIMODAL_IT112 } from "./multimodal-it112";
import {
  CAPACITE_MEMOIRE_REFLEXION,
  CortexReflexifGen3,
  requeteNormalisee,
  requeteRaccourcie,
} from "./memoire-reflexion";
import { CortexLangagierGen3 } from "./language";

describe("memoire-reflexion — délibération, choix, mémoire bornée", () => {
  it("voie directe : le motif exact du corpus est servi dès le premier essai (voie rapide)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const reflexif = new CortexReflexifGen3(cortex);
    const motif = PAIRES_MULTIMODAL_IT112[0]!.motif;
    const d = reflexif.reflechir(motif);
    expect(d.voieElue).toBe("directe");
    expect(d.essais).toBe(1);
    expect(d.elue.length).toBeGreaterThan(20);
    expect(d.candidats).toHaveLength(1);
    expect(d.candidats[0]!.servie).toBe(true);
  });

  it("délibération : les voies sont essayées dans l'ordre et la trace est cohérente", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const reflexif = new CortexReflexifGen3(cortex);
    // requête bruitée : la directe peut échouer, les voies de précision
    // peuvent la rattraper — la trace doit rester cohérente quel que soit
    // le résultat (honnêteté : le gain se MESURE, il ne se suppose pas).
    const bruite = "dis-moi s'il te plaît, ce que contient l'image km112_image_000 ??";
    const d = reflexif.reflechir(bruite);
    expect(d.motif).toBe(bruite);
    expect(d.candidats).toHaveLength(d.essais);
    expect(d.essais).toBeGreaterThanOrEqual(1);
    expect(d.essais).toBeLessThanOrEqual(3);
    const voies = d.candidats.map((c) => c.voie);
    const ordreAttendu = ["directe", "normalisee", "racourcie"].filter((v) =>
      voies.includes(v as never),
    );
    expect(voies).toEqual(ordreAttendu);
    if (d.voieElue !== "echec") {
      const elue = d.candidats.find((c) => c.voie === d.voieElue)!;
      expect(elue.servie).toBe(true);
      expect(d.elue).toBe(elue.texte);
    } else {
      expect(d.elue).toBe("");
      expect(d.candidats.every((c) => !c.servie)).toBe(true);
    }
  });

  it("non-régression : sur un échantillon du corpus, le réflexif sert AU MOINS autant que la directe", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const reflexif = new CortexReflexifGen3(cortex);
    const echantillon = CORPUS_GEN3.slice(0, 150);
    let servieDirecte = 0;
    let servieReflexive = 0;
    for (const p of echantillon) {
      const direct = cortex.repondre(p.motif);
      if (direct && direct.texte.length > 20) servieDirecte += 1;
      const d = reflexif.reflechir(p.motif);
      if (d.voieElue !== "echec") servieReflexive += 1;
    }
    expect(servieReflexive).toBeGreaterThanOrEqual(servieDirecte);
    const stats = reflexif.statistiques();
    expect(stats.total).toBe(150);
    expect(stats.servies).toBe(servieReflexive);
  });

  it("mémoire bornée : l'anneau évince les plus anciennes délibérations (CAPACITE respectée)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const reflexif = new CortexReflexifGen3(cortex);
    const premierMotif = "question poubelle 000";
    for (let i = 0; i < CAPACITE_MEMOIRE_REFLEXION + 10; i++) {
      reflexif.reflechir(`question poubelle ${i}`);
    }
    expect(reflexif.lireMemoire()).toHaveLength(CAPACITE_MEMOIRE_REFLEXION);
    // la première délibération conservée est la 11e posée (0..9 évincées)
    expect(reflexif.lireMemoire()[0]!.motif).toBe(`question poubelle 10`);
    expect(premierMotif).not.toBe(reflexif.lireMemoire()[0]!.motif);
    const stats = reflexif.statistiques();
    expect(stats.total).toBe(CAPACITE_MEMOIRE_REFLEXION);
    // cohérence (les requêtes poubelles peuvent être servies — la couverture
    // du cortex est réelle) : servies + échecs = total, jamais l'inverse
    expect(stats.servies + stats.echecs).toBe(CAPACITE_MEMOIRE_REFLEXION);
    expect(stats.tauxService).toBe(stats.servies / CAPACITE_MEMOIRE_REFLEXION);
    reflexif.viderMemoire();
    expect(reflexif.lireMemoire()).toHaveLength(0);
    expect(reflexif.statistiques().total).toBe(0);
  });

  it("statistiques cohérentes : total = servies + échecs · gainPrecision = voies de précision", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const reflexif = new CortexReflexifGen3(cortex);
    for (const p of PAIRES_MULTIMODAL_IT112.slice(0, 8)) reflexif.reflechir(p.motif);
    for (let i = 0; i < 4; i++) reflexif.reflechir(`n'importe quoi ${i} xyz`);
    const stats = reflexif.statistiques();
    expect(stats.total).toBe(12);
    expect(stats.servies + stats.echecs).toBe(stats.total);
    expect(stats.parVoie.directe + stats.parVoie.normalisee + stats.parVoie.racourcie + stats.parVoie.echec).toBe(
      stats.total,
    );
    expect(stats.gainPrecision).toBe(stats.parVoie.normalisee + stats.parVoie.racourcie);
    // les 8 motifs exacts du corpus doivent être servis en voie rapide
    expect(stats.voieRapide).toBeGreaterThanOrEqual(8);
  });

  it("normalisation et raccourcis : déterministes et distincts", () => {
    expect(requeteNormalisee("  Que contient l'image km112_image_000 ?!  ")).toBe(
      "que contient l image km112_image_000",
    );
    const racourcie = requeteRaccourcie("ce que contient l image km112_image_000");
    expect(racourcie).toBe("contient image km112_image_000");
    // « où » conservé (questions d'emplacement)
    expect(requeteRaccourcie("où sont stockés les assets multimodaux de gen3 ?")).toBe(
      "où stockés assets multimodaux gen3",
    );
  });
});
