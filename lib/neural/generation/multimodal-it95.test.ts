/**
 * GARDE it.95 — ASSETS MULTIMODAUX RÉELS (fenêtre COCO offset 144 +
 * FLEURS offset 44) : honnêteté des comptes, existence réelle des fichiers,
 * paires servibles par le cortex, câblage dans le corpus de production.
 * Règle zéro fantôme : tout ce que le module déclare doit exister.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ASSETS_MULTIMODAL_IT95, PAIRES_MULTIMODAL_IT95 } from "./multimodal-it95";
import { CORPUS_GEN3 } from "./corpus";

describe("multimodal-it95 — fenêtre réelle suivante", () => {
  it("déclare 28 assets : 20 images COCO + 8 audios FLEURS + 0 vidéo (fenêtre UCF101 épuisée)", () => {
    expect(ASSETS_MULTIMODAL_IT95).toHaveLength(28);
    expect(ASSETS_MULTIMODAL_IT95.filter((a) => a.modality === "image")).toHaveLength(20);
    expect(ASSETS_MULTIMODAL_IT95.filter((a) => a.modality === "audio")).toHaveLength(8);
    expect(ASSETS_MULTIMODAL_IT95.filter((a) => a.modality === "video")).toHaveLength(0);
  });

  it("chaque asset existe RÉELLEMENT sur le disque (zéro fantôme)", () => {
    for (const a of ASSETS_MULTIMODAL_IT95) {
      expect(existsSync(join("public", a.file)), `fichier manquant : ${a.file}`).toBe(true);
    }
  });

  it("chaque asset porte une empreinte sha256 tronquée et des métadonnées mesurées", () => {
    for (const a of ASSETS_MULTIMODAL_IT95) {
      expect(a.sha256).toMatch(/^[0-9a-f]{16}$/);
      expect(a.bytes).toBeGreaterThan(0);
      expect(a.dataset).toContain("#");
      expect(a.legende.length).toBeGreaterThan(10);
    }
  });

  it("les fenêtres sont les SUIVANTES (COCO offset 144, FLEURS offset 44 — après it.94 : 124/36)", () => {
    const images = ASSETS_MULTIMODAL_IT95.filter((a) => a.modality === "image");
    const audios = ASSETS_MULTIMODAL_IT95.filter((a) => a.modality === "audio");
    for (const a of images) expect(a.dataset).toBe("rafaelpadilla/coco2017#default/val");
    for (const a of audios) expect(a.dataset).toBe("google/fleurs#fr_fr/validation");
  });

  it("28 paires servibles : motif ↔ réponse contenant l'identifiant et la légende réelle", () => {
    expect(PAIRES_MULTIMODAL_IT95).toHaveLength(28);
    for (const p of PAIRES_MULTIMODAL_IT95) {
      expect(p.motif.length).toBeGreaterThan(10);
      expect(p.reponse.length).toBeGreaterThan(40);
      expect(p.reponse).toContain("RÉEL");
    }
    const image = PAIRES_MULTIMODAL_IT95.find((p) => p.theme === "multimodal-image");
    expect(image?.motif).toContain("image km95_");
    expect(image?.reponse).toContain("COCO-2017");
    const audio = PAIRES_MULTIMODAL_IT95.find((p) => p.theme === "multimodal-audio");
    expect(audio?.reponse).toContain("FLEURS");
  });

  it("les paires it.95 sont câblées dans le corpus de production CORPUS_GEN3", () => {
    const motifs = new Set(CORPUS_GEN3.map((p) => p.motif));
    for (const p of PAIRES_MULTIMODAL_IT95) {
      expect(motifs.has(p.motif), `motif absent du corpus : ${p.motif}`).toBe(true);
    }
  });

  it("les légendes sont RÉELLES (issues des annotations, aucune invention)", () => {
    // image_011 (kext95_image_012) : la vérité terrain COCO ne contient
    // AUCUNE annotation pour cette ligne — la légende doit le dire honnêtement.
    const vide = ASSETS_MULTIMODAL_IT95.find((a) => a.legende.startsWith("scène sans objet annoté"));
    expect(vide).toBeDefined();
    expect(vide?.legende).toContain("0 annotation");
    // aucune légende ne contient de segment vide « contenant :  »
    for (const a of ASSETS_MULTIMODAL_IT95) {
      expect(a.legende.includes("contenant :  (")).toBe(false);
    }
  });
});
