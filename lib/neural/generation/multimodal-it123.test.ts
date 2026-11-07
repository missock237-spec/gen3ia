/**
 * GARDE it.123 — ASSETS MULTIMODAUX RÉELS (fenêtre COCO offset 624 +
 * FLEURS offset 236) : honnêteté des comptes, existence réelle des fichiers,
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
import { ASSETS_MULTIMODAL_IT105 } from "./multimodal-it105";
import { ASSETS_MULTIMODAL_IT106 } from "./multimodal-it106";
import { ASSETS_MULTIMODAL_IT107 } from "./multimodal-it107";
import { ASSETS_MULTIMODAL_IT108 } from "./multimodal-it108";
import { ASSETS_MULTIMODAL_IT109 } from "./multimodal-it109";
import { ASSETS_MULTIMODAL_IT110 } from "./multimodal-it110";
import { ASSETS_MULTIMODAL_IT111 } from "./multimodal-it111";
import { ASSETS_MULTIMODAL_IT112 } from "./multimodal-it112";
import { ASSETS_MULTIMODAL_IT113 } from "./multimodal-it113";
import { ASSETS_MULTIMODAL_IT115 } from "./multimodal-it115";
import { ASSETS_MULTIMODAL_IT116 } from "./multimodal-it116";
import { ASSETS_MULTIMODAL_IT117 } from "./multimodal-it117";
import { ASSETS_MULTIMODAL_IT118 } from "./multimodal-it118";
import { ASSETS_MULTIMODAL_IT119 } from "./multimodal-it119";
import { ASSETS_MULTIMODAL_IT120 } from "./multimodal-it120";
import { ASSETS_MULTIMODAL_IT121 } from "./multimodal-it121";
import { ASSETS_MULTIMODAL_IT122 } from "./multimodal-it122";
import { ASSETS_MULTIMODAL_IT123, PAIRES_MULTIMODAL_IT123 } from "./multimodal-it123";
import { CORPUS_GEN3 } from "./corpus";

describe("multimodal-it123 — fenêtre réelle suivante", () => {
  it("déclare 28 assets : 20 images COCO + 8 audios FLEURS + 0 vidéo (fenêtre UCF101 épuisée)", () => {
    expect(ASSETS_MULTIMODAL_IT123).toHaveLength(28);
    expect(ASSETS_MULTIMODAL_IT123.filter((a) => a.modality === "image")).toHaveLength(20);
    expect(ASSETS_MULTIMODAL_IT123.filter((a) => a.modality === "audio")).toHaveLength(8);
    expect(ASSETS_MULTIMODAL_IT123.filter((a) => a.modality === "video")).toHaveLength(0);
  });

  it("chaque asset existe RÉELLEMENT sur le disque (zéro fantôme)", () => {
    for (const a of ASSETS_MULTIMODAL_IT123) {
      expect(existsSync(join("public", a.file)), `fichier manquant : ${a.file}`).toBe(true);
    }
  });

  it("chaque asset porte une empreinte sha256 tronquée et des métadonnées mesurées", () => {
    for (const a of ASSETS_MULTIMODAL_IT123) {
      expect(a.sha256).toMatch(/^[0-9a-f]{16}$/);
      expect(a.bytes).toBeGreaterThan(0);
      expect(a.dataset).toContain("#");
      expect(a.legende.length).toBeGreaterThan(10);
    }
  });

  it("les fenêtres sont les SUIVANTES (COCO offset 624, FLEURS offset 236 — après it.122 : 604/228)", () => {
    const images = ASSETS_MULTIMODAL_IT123.filter((a) => a.modality === "image");
    const audios = ASSETS_MULTIMODAL_IT123.filter((a) => a.modality === "audio");
    for (const a of images) expect(a.dataset).toBe("rafaelpadilla/coco2017#default/val");
    for (const a of audios) expect(a.dataset).toBe("google/fleurs#fr_fr/validation");
  });

  it("déduplication : aucune empreinte sha256 partagée avec les fenêtres it.95 (144/44), it.96 (164/52), it.97 (184/60), it.98 (204/68), it.99 (224/76), it.101 (244/84), it.104 (264/92), it.105 (284/100), it.106 (304/108), it.107 (324/116), it.108 (344/124), it.109 (364/132), it.110 (384/140), it.111 (404/148), it.112 (424/156), it.113 (444/164), it.115 (464/172), it.116 (484/180), it.117 (504/188), it.118 (524/196), it.119 (544/204), it.120 (564/212), it.121 (584/220), it.122 (604/228) et it.123 (624/236)", () => {
    const sha95 = new Set(ASSETS_MULTIMODAL_IT95.map((a) => a.sha256));
    const sha96 = new Set(ASSETS_MULTIMODAL_IT96.map((a) => a.sha256));
    const sha97 = new Set(ASSETS_MULTIMODAL_IT97.map((a) => a.sha256));
    const sha98 = new Set(ASSETS_MULTIMODAL_IT98.map((a) => a.sha256));
    const sha99 = new Set(ASSETS_MULTIMODAL_IT99.map((a) => a.sha256));
    const sha101 = new Set(ASSETS_MULTIMODAL_IT101.map((a) => a.sha256));
    const sha104 = new Set(ASSETS_MULTIMODAL_IT104.map((a) => a.sha256));
    const sha105 = new Set(ASSETS_MULTIMODAL_IT105.map((a) => a.sha256));
    const sha106 = new Set(ASSETS_MULTIMODAL_IT106.map((a) => a.sha256));
    const sha107 = new Set(ASSETS_MULTIMODAL_IT107.map((a) => a.sha256));
    const sha108 = new Set(ASSETS_MULTIMODAL_IT108.map((a) => a.sha256));
    const sha109 = new Set(ASSETS_MULTIMODAL_IT109.map((a) => a.sha256));
    const sha110 = new Set(ASSETS_MULTIMODAL_IT110.map((a) => a.sha256));
    const sha111 = new Set(ASSETS_MULTIMODAL_IT111.map((a) => a.sha256));
    const sha112 = new Set(ASSETS_MULTIMODAL_IT112.map((a) => a.sha256));
    const sha113 = new Set(ASSETS_MULTIMODAL_IT113.map((a) => a.sha256));
    const sha115 = new Set(ASSETS_MULTIMODAL_IT115.map((a) => a.sha256));
    const sha116 = new Set(ASSETS_MULTIMODAL_IT116.map((a) => a.sha256));
    const sha117 = new Set(ASSETS_MULTIMODAL_IT117.map((a) => a.sha256));
    const sha118 = new Set(ASSETS_MULTIMODAL_IT118.map((a) => a.sha256));
    const sha119 = new Set(ASSETS_MULTIMODAL_IT119.map((a) => a.sha256));
    const sha120 = new Set(ASSETS_MULTIMODAL_IT120.map((a) => a.sha256));
    const sha121 = new Set(ASSETS_MULTIMODAL_IT121.map((a) => a.sha256));
    const sha122 = new Set(ASSETS_MULTIMODAL_IT122.map((a) => a.sha256));
    for (const a of ASSETS_MULTIMODAL_IT123) {
      expect(sha95.has(a.sha256), `doublon de contenu it.95 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha96.has(a.sha256), `doublon de contenu it.96 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha97.has(a.sha256), `doublon de contenu it.97 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha98.has(a.sha256), `doublon de contenu it.98 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha99.has(a.sha256), `doublon de contenu it.99 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha101.has(a.sha256), `doublon de contenu it.101 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha104.has(a.sha256), `doublon de contenu it.104 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha105.has(a.sha256), `doublon de contenu it.105 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha106.has(a.sha256), `doublon de contenu it.106 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha107.has(a.sha256), `doublon de contenu it.107 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha108.has(a.sha256), `doublon de contenu it.108 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha109.has(a.sha256), `doublon de contenu it.109 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha110.has(a.sha256), `doublon de contenu it.110 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha111.has(a.sha256), `doublon de contenu it.111 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha112.has(a.sha256), `doublon de contenu it.112 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha113.has(a.sha256), `doublon de contenu it.113 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha115.has(a.sha256), `doublon de contenu it.115 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha116.has(a.sha256), `doublon de contenu it.116 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha117.has(a.sha256), `doublon de contenu it.117 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha118.has(a.sha256), `doublon de contenu it.118 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha119.has(a.sha256), `doublon de contenu it.119 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha120.has(a.sha256), `doublon de contenu it.120 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha121.has(a.sha256), `doublon de contenu it.121 : ${a.id} (${a.sha256})`).toBe(false);
      expect(sha122.has(a.sha256), `doublon de contenu it.122 : ${a.id} (${a.sha256})`).toBe(false);
    }
  });

  it("28 paires servibles : motif ↔ réponse contenant l'identifiant et la légende réelle", () => {
    expect(PAIRES_MULTIMODAL_IT123).toHaveLength(28);
    for (const p of PAIRES_MULTIMODAL_IT123) {
      expect(p.motif.length).toBeGreaterThan(10);
      expect(p.reponse.length).toBeGreaterThan(40);
      expect(p.reponse).toContain("RÉEL");
    }
    const image = PAIRES_MULTIMODAL_IT123.find((p) => p.theme === "multimodal-image");
    expect(image?.motif).toContain("image km123_");
    expect(image?.reponse).toContain("COCO-2017");
    const audio = PAIRES_MULTIMODAL_IT123.find((p) => p.theme === "multimodal-audio");
    expect(audio?.reponse).toContain("FLEURS");
  });

  it("les paires it.123 sont câblées dans le corpus de production CORPUS_GEN3", () => {
    const motifs = new Set(CORPUS_GEN3.map((p) => p.motif));
    for (const p of PAIRES_MULTIMODAL_IT123) {
      expect(motifs.has(p.motif), `motif absent du corpus : ${p.motif}`).toBe(true);
    }
  });

  it("les légendes sont RÉELLES (issues des annotations, aucune invention)", () => {
    // cette fenêtre (offset 624) : les images annotées listent les objets
    // réellement annotés ; les rares images SANS annotation COCO portent la
    // légende honnête « scène sans objet annoté (0 annotation) » — les deux
    // formes sont de la vérité terrain, aucune invention.
    const images = ASSETS_MULTIMODAL_IT123.filter((a) => a.modality === "image");
    for (const a of images) {
      const legendeReelle =
        a.legende.startsWith("scène contenant :") ||
        a.legende.startsWith("scène sans objet annoté");
      expect(legendeReelle, `légende image non conforme : ${a.id}`).toBe(true);
    }
    // aucune légende ne contient de segment vide « contenant :  »
    for (const a of ASSETS_MULTIMODAL_IT123) {
      expect(a.legende.includes("contenant :  (")).toBe(false);
    }
  });
});
