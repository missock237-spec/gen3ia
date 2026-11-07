/**
 * GARDE CARTE DE MÉMOIRE — la mémoire d'emplacement de gen3 doit refléter
 * le DISQUE (zéro fantôme) : chaque chemin déclaré existe, chaque compte
 * est mesuré, le dernier snapshot est le bon fichier, et les paires
 * d'emplacement sont câblées et servibles par le cortex langagier.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CORPUS_GEN3 } from "./corpus";
import {
  CARTE_MEMOIRE,
  DERNIER_SNAPSHOT,
  PAIRES_CARTE_MEMOIRE,
} from "./carte-memoire";
import { CortexLangagierGen3 } from "./language";

describe("carte-memoire — où vivent les datasets et la mémoire gravée", () => {
  it("énumère les fenêtres réelles, triées, la dernière étant it.126", () => {
    expect(CARTE_MEMOIRE.length).toBeGreaterThanOrEqual(30);
    const numeros = CARTE_MEMOIRE.map((f) => Number(f.fenetre.slice(3)));
    for (let i = 1; i < numeros.length; i++) {
      expect(numeros[i]!).toBeGreaterThan(numeros[i - 1]!);
    }
    expect(CARTE_MEMOIRE[CARTE_MEMOIRE.length - 1]!.fenetre).toBe("it.126");
  });

  it("zéro fantôme : chaque chemin existe sur le disque avec ses comptes mesurés", () => {
    for (const f of CARTE_MEMOIRE) {
      const dossier = join("public", f.chemin);
      expect(existsSync(dossier), `dossier manquant : ${dossier}`).toBe(true);
      expect(f.assets).toBe(f.images + f.audios + f.videos);
      expect(f.assets).toBeGreaterThan(0);
      expect(f.octets).toBeGreaterThan(0);
    }
    // la fenêtre la plus récente : 20 images COCO + 8 audios FLEURS
    const derniere = CARTE_MEMOIRE[CARTE_MEMOIRE.length - 1]!;
    expect(derniere.images).toBe(20);
    expect(derniere.audios).toBe(8);
    expect(derniere.videos).toBe(0);
  });

  it("les snapshots déclarés existent avec leur taille réelle", () => {
    for (const f of CARTE_MEMOIRE) {
      if (f.snapshot === null) continue;
      const fichier = join("public", f.snapshot);
      expect(existsSync(fichier), `snapshot manquant : ${f.snapshot}`).toBe(true);
      expect(f.snapshotOctets).toBe(statSync(fichier).size);
    }
  });

  it("dernier snapshot = it.126, présent, taille mesurée sur le disque", () => {
    expect(DERNIER_SNAPSHOT.fichier).toBe("/neural/cortex-multimodal-it126.bin");
    const fichier = join("public", DERNIER_SNAPSHOT.fichier);
    expect(existsSync(fichier)).toBe(true);
    expect(DERNIER_SNAPSHOT.octets).toBe(statSync(fichier).size);
    expect(DERNIER_SNAPSHOT.octets).toBe(12_582_960);
  });

  it("les 4 paires d'emplacement sont uniques, câblées dans le corpus et servibles", () => {
    expect(PAIRES_CARTE_MEMOIRE).toHaveLength(4);
    const motifs = new Set(PAIRES_CARTE_MEMOIRE.map((p) => p.motif));
    expect(motifs.size).toBe(4);
    const motifsCorpus = new Set(CORPUS_GEN3.map((p) => p.motif));
    for (const p of PAIRES_CARTE_MEMOIRE) {
      expect(motifsCorpus.has(p.motif), `motif absent du corpus : ${p.motif}`).toBe(true);
    }
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    for (const p of PAIRES_CARTE_MEMOIRE) {
      const r = cortex.repondre(p.motif);
      expect(r, `aucune réponse : ${p.motif}`).not.toBeNull();
      expect(r!.texte.includes(p.reponse.slice(0, 40)), `réponse inexacte : ${p.motif}`).toBe(true);
    }
  });

  it("la réponse d'emplacement cite un dossier réellement présent", () => {
    const premiere = PAIRES_CARTE_MEMOIRE[0]!;
    const extraits = CARTE_MEMOIRE.map((f) => f.chemin).filter((c) => premiere.reponse.includes(c));
    expect(extraits.length).toBeGreaterThanOrEqual(10);
    for (const e of extraits) expect(existsSync(join("public", e))).toBe(true);
    // la carte compte les fichiers réels : le total déclaré = comptage disque
    let totalReel = 0;
    for (const f of CARTE_MEMOIRE) {
      for (const sous of ["images", "audio", "video"]) {
        const dir = join("public", f.chemin, sous);
        if (existsSync(dir)) totalReel += readdirSync(dir).length;
      }
    }
    const totalCarte = CARTE_MEMOIRE.reduce((s, f) => s + f.assets, 0);
    expect(totalCarte).toBe(totalReel);
  });
});
