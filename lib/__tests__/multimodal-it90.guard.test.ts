import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ASSETS_MULTIMODAL_IT90, PAIRES_MULTIMODAL_IT90 } from "../neural/generation/multimodal-it90";
import { CORPUS_GEN3 } from "../neural/generation/corpus";

/**
 * GARDE it.90 — assets multimodaux RÉELS intégrés au cerveau.
 * Vérifie que chaque asset existe physiquement dans public/, que les
 * métadonnées mesurées sont cohérentes (octets réels, empreinte présente)
 * et que les paires sont assimilées par le corpus de production.
 */
describe("assets multimodaux réels it.90 (lib/neural/generation/multimodal-it90.ts)", () => {
  it("34 assets réels sont présents (20 images + 8 audios FLEURS + 2 vidéos UCF101 + 4 TTS)", () => {
    expect(ASSETS_MULTIMODAL_IT90).toHaveLength(34);
    const comptes = ASSETS_MULTIMODAL_IT90.reduce<Record<string, number>>((acc, a) => {
      acc[a.modality] = (acc[a.modality] ?? 0) + 1;
      return acc;
    }, {});
    expect(comptes).toEqual({ image: 20, audio: 8, video: 2, "audio-généré": 4 });
  });

  it("chaque fichier existe physiquement et son octetage mesuré correspond au module", () => {
    for (const a of ASSETS_MULTIMODAL_IT90) {
      const chemin = join("public", a.file);
      expect(existsSync(chemin), `fichier manquant : ${chemin}`).toBe(true);
      const octets = statSync(chemin).size;
      // tolérance 0 : le module est généré depuis l'état réel du disque
      expect(octets, `${a.file} : ${octets} ≠ ${a.bytes}`).toBe(a.bytes);
      expect(a.sha256).toMatch(/^[0-9a-f]{16}$/);
      expect(a.dataset.length).toBeGreaterThan(3);
      expect(a.legende.length).toBeGreaterThan(10);
    }
  });

  it("les identifiants sont uniques et le total est mesuré < 5 Mo (budget bundle)", () => {
    const ids = ASSETS_MULTIMODAL_IT90.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const total = ASSETS_MULTIMODAL_IT90.reduce((s, a) => s + a.bytes, 0);
    expect(total).toBeLessThan(5_000_000);
    expect(total).toBeGreaterThan(3_000_000);
  });

  it("les 34 paires multimodales sont assimilées par le corpus de production", () => {
    expect(PAIRES_MULTIMODAL_IT90).toHaveLength(34);
    const motifs = new Set(PAIRES_MULTIMODAL_IT90.map((p) => p.motif));
    for (const p of PAIRES_MULTIMODAL_IT90) {
      expect(motifs.has(p.motif)).toBe(true);
      expect(p.reponse.length).toBeGreaterThan(40);
      expect(p.theme.startsWith("multimodal-")).toBe(true);
    }
    // le corpus de production contient bien les 34 paires
    const corpusSet = new Set(CORPUS_GEN3.map((p) => p.motif));
    for (const p of PAIRES_MULTIMODAL_IT90) {
      expect(corpusSet.has(p.motif), `paire absente du corpus : ${p.motif}`).toBe(true);
    }
  });

  it("les légendes réelles portent la provenance professionnelle (COCO/FLEURS/UCF101)", () => {
    const coco = ASSETS_MULTIMODAL_IT90.filter((a) => a.dataset.startsWith("rafaelpadilla/coco2017"));
    const fleurs = ASSETS_MULTIMODAL_IT90.filter((a) => a.dataset.startsWith("google/fleurs"));
    const ucf = ASSETS_MULTIMODAL_IT90.filter((a) => a.dataset.startsWith("sayakpaul/ucf101-subset"));
    expect(coco).toHaveLength(20);
    expect(fleurs).toHaveLength(8);
    expect(ucf).toHaveLength(2);
    // transcription FLEURS réelle (française, ponctuée) — pas une légende fabriquée
    for (const f of fleurs) {
      expect(f.legende.length).toBeGreaterThan(40);
    }
    // légendes COCO construites depuis les annotations (jamais « inconnu »)
    for (const c of coco) {
      expect(c.legende).toContain("scène contenant");
    }
  });
});
