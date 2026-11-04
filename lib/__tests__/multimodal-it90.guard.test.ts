import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ASSETS_MULTIMODAL_IT90, PAIRES_MULTIMODAL_IT90 } from "../neural/generation/multimodal-it90";
import { CORPUS_GEN3 } from "../neural/generation/corpus";

/**
 * GARDE it.90→it.100 — assets multimodaux RÉELS intégrés au cerveau.
 * Vérifie que chaque asset existe physiquement dans public/, que les
 * métadonnées mesurées sont cohérentes (octets réels, empreinte présente)
 * et que les paires sont assimilées par le corpus de production.
 * it.100 : expansion +12 (COCO lignes 100-107, FLEURS 24-27 en opus natif)
 * → 94 assets à 4,66 Mo (plafond 15 Mo tenu avec une large marge, servi
 * statiquement, hors bundle JS).
 */
describe("assets multimodaux réels it.90 (lib/neural/generation/multimodal-it90.ts)", () => {
  it("94 assets réels sont présents (60 images + 28 audios FLEURS opus + 2 vidéos UCF101 + 4 TTS)", () => {
    expect(ASSETS_MULTIMODAL_IT90).toHaveLength(94);
    const comptes = ASSETS_MULTIMODAL_IT90.reduce<Record<string, number>>((acc, a) => {
      acc[a.modality] = (acc[a.modality] ?? 0) + 1;
      return acc;
    }, {});
    expect(comptes).toEqual({ image: 60, audio: 28, video: 2, "audio-généré": 4 });
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

  it("les identifiants sont uniques et le total est mesuré < 15 Mo (fichiers publics servis statiquement, hors bundle JS)", () => {
    const ids = ASSETS_MULTIMODAL_IT90.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const total = ASSETS_MULTIMODAL_IT90.reduce((s, a) => s + a.bytes, 0);
    expect(total).toBeLessThan(15_000_000);
    expect(total).toBeGreaterThan(3_000_000);
    // it.99/it.100 : les audios FLEURS réels sont en Opus (et le gain est
    // mesuré : 28 audios < 1 Mo, là où les 20 WAV pesaient 9,64 Mo)
    const audiosOpus = ASSETS_MULTIMODAL_IT90.filter((a) => a.modality === "audio");
    expect(audiosOpus.length).toBe(28);
    for (const a of audiosOpus) {
      expect(a.file.endsWith(".opus"), `${a.file} n'est pas en opus`).toBe(true);
    }
    expect(audiosOpus.reduce((s, a) => s + a.bytes, 0)).toBeLessThan(1_000_000);
  });

  it("les 94 paires multimodales sont assimilées par le corpus de production", () => {
    expect(PAIRES_MULTIMODAL_IT90).toHaveLength(94);
    const motifs = new Set(PAIRES_MULTIMODAL_IT90.map((p) => p.motif));
    for (const p of PAIRES_MULTIMODAL_IT90) {
      expect(motifs.has(p.motif)).toBe(true);
      expect(p.reponse.length).toBeGreaterThan(40);
      expect(p.theme.startsWith("multimodal-")).toBe(true);
    }
    // le corpus de production contient bien les 94 paires
    const corpusSet = new Set(CORPUS_GEN3.map((p) => p.motif));
    for (const p of PAIRES_MULTIMODAL_IT90) {
      expect(corpusSet.has(p.motif), `paire absente du corpus : ${p.motif}`).toBe(true);
    }
  });

  it("les légendes réelles portent la provenance professionnelle (COCO/FLEURS/UCF101)", () => {
    const coco = ASSETS_MULTIMODAL_IT90.filter((a) => a.dataset.startsWith("rafaelpadilla/coco2017"));
    const fleurs = ASSETS_MULTIMODAL_IT90.filter((a) => a.dataset.startsWith("google/fleurs"));
    const ucf = ASSETS_MULTIMODAL_IT90.filter((a) => a.dataset.startsWith("sayakpaul/ucf101-subset"));
    expect(coco).toHaveLength(60);
    expect(fleurs).toHaveLength(28);
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
