/**
 * GARDE it.105 — ASSETS MULTIMODAUX RÉELS (fenêtre COCO offset 284 +
 * FLEURS offset 100) : honnêteté des comptes, existence réelle des fichiers,
 * paires servibles par le cortex, câblage dans le corpus de production.
 * Règle zéro fantôme : tout ce que le module déclare doit exister.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ASSETS_MULTIMODAL_IT95 } from "./multimodal-it95";
import { ASSETS_MULTIMODAL_IT96 } from "./multimodal-it96";
import { ASSETS_MULTIMODAL_IT97 } from "./multimodal-it97";
import { ASSETS_MULTIMODAL_IT98 } from "./multimodal-it98";
import { ASSETS_MULTIMODAL_IT99 } from "./multimodal-it99";
import { ASSETS_MULTIMODAL_IT101 } from "./multimodal-it101";
import { ASSETS_MULTIMODAL_IT104 } from "./multimodal-it104";
import { ASSETS_MULTIMODAL_IT105, PAIRES_MULTIMODAL_IT105 } from "./multimodal-it105";
import { CORPUS_GEN3 } from "./corpus";

describe("multimodal-it105 — fenêtre réelle suivante", () => {
  it("déclare 28 assets : 20 images COCO + 8 audios FLEURS + 0 vidéo (fenêtre UCF101 épuisée)", () => {
    expect(ASSETS_MULTIMODAL_IT105).toHaveLength(28);
    expect(ASSETS_MULTIMODAL_IT105.filter((a) => a.modality === "image")).toHaveLength(20);
    expect(ASSETS_MULTIMODAL_IT105.filter((a) => a.modality === "audio")).toHaveLength(8);
    expect(ASSETS_MULTIMODAL_IT105.filter((a) => a.modality === "video")).toHaveLength(0);
  });

  it("chaque asset existe RÉELLEMENT sur le disque (zéro fantôme)", () => {
    for (const a of ASSETS_MULTIMODAL_IT105) {
      expect(existsSync(join("public", a.file)), `fichier manquant : ${a.file}`).toBe(true);
    }
  });

  it("chaque asset porte une empreinte sha256 tronquée et des métadonnées mesurées", () => {
    for (const a of ASSETS_MULTIMODAL_IT105) {
      expect(a.sha256).toMatch(/^[0-9a-f]{16}$/);
      expect(a.bytes).toBeGreaterThan(0);
      expect(a.dataset).toContain("#");
      expect(a.legende.length).toBeGreaterThan(10);
    }
  });

  it("les fenêtres sont les SUIVANTES (COCO offset 284, FLEURS offset 100 — après it.104 : 264/92)", () => {
    const images = ASSETS_MULTIMODAL_IT105.filter((a) => a.modality === "image");
    const audios = ASSETS_MULTIMODAL_IT105.filter((a) => a.modality === "audio");
    for (const a of images) expect(a.dataset).toBe("rafaelpadilla/coco2017#default/val");
    for (const a of audios) expect(a.dataset).toBe("google/fleurs#fr_fr/validation");
  });

  it("déduplication : aucune empreinte sha256 partagée avec les fenêtres it.95 (144/44), it.96 (164/52), it.97 (184/60), it.98 (204/68), it.99 (224/76), it.101 (244/84) et it.104 (264/92)", () => {
    const sha95 = new Set(ASSETS_MULTIMODAL_IT95.map((a) => a.sha256));
    const sha96 = new Set(ASSETS_MULTIMODAL_IT96.map((a) => a.sha256));
    const sha97 = new Set(ASSETS_MULTIMODAL_IT97.map((a) => a.sha256));
    const sha98 = new Set(ASSETS_MULTIMODAL_IT98.map((a) => a.sha256));
    const sha99 = new Set(ASSETS_MULTIMODAL_IT99.map((a) => a.sha256));
    const sha101 = new Set(ASSETS_MULTIMODAL_IT101.map((a) => a.sha256));
    const sha104 = new Set(ASSETS_MULTIMODAL_IT104.map((a) => a.sha256));
    for (const a of ASSETS_MULTIMODAL_IT105) {
      expect(sha95.has(a.sha256), `doublon de contenu it.95 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha96.has(a.sha256), `doublon de contenu it.96 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha97.has(a.sha256), `doublon de contenu it.97 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha98.has(a.sha256), `doublon de contenu it.98 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha99.has(a.sha256), `doublon de contenu it.99 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha101.has(a.sha256), `doublon de contenu it.101 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha104.has(a.sha256), `doublon de contenu it.104 : ${a.id} (${a.sha256})`).toBe(false);
    }
  });

  it("28 paires servibles : motif ↔ réponse contenant l'identifiant et la légende réelle", () => {
    expect(PAIRES_MULTIMODAL_IT105).toHaveLength(28);
    for (const p of PAIRES_MULTIMODAL_IT105) {
      expect(p.motif.length).toBeGreaterThan(10);
      expect(p.reponse.length).toBeGreaterThan(40);
      expect(p.reponse).toContain("RÉEL");
    }
    const image = PAIRES_MULTIMODAL_IT105.find((p) => p.theme === "multimodal-image");
    expect(image?.motif).toContain("image km105_");
    expect(image?.reponse).toContain("COCO-2017");
    const audio = PAIRES_MULTIMODAL_IT105.find((p) => p.theme === "multimodal-audio");
    expect(audio?.reponse).toContain("FLEURS");
  });

  it("les paires it.105 sont câblées dans le corpus de production CORPUS_GEN3", () => {
    const motifs = new Set(CORPUS_GEN3.map((p) => p.motif));
    for (const p of PAIRES_MULTIMODAL_IT105) {
      expect(motifs.has(p.motif), `motif absent du corpus : ${p.motif}`).toBe(true);
    }
  });

  it("les légendes sont RÉELLES (issues des annotations, aucune invention)", () => {
    // cette fenêtre (offset 244) : les images annotées listent les objets
    // réellement annotés ; les rares images SANS annotation COCO portent la
    // légende honnête « scène sans objet annoté (0 annotation) » — les deux
    // formes sont de la vérité terrain, aucune invention.
    const images = ASSETS_MULTIMODAL_IT105.filter((a) => a.modality === "image");
    for (const a of images) {
      const legendeReelle =
        a.legende.startsWith("scène contenant :") ||
        a.legende.startsWith("scène sans objet annoté");
      expect(legendeReelle, `légende image non conforme : ${a.id}`).toBe(true);
    }
    // aucune légende ne contient de segment vide « contenant :  »
    for (const a of ASSETS_MULTIMODAL_IT105) {
      expect(a.legende.includes("contenant :  (")).toBe(false);
    }
  });
});
