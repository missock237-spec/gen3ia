/**
 * TESTS DU LOT 7 — laboratoire d'évaluation indépendant. Le banc doit
 * S'EXÉCUTER RÉELLEMENT (médias synthétiques, composants réels), produire
 * des scores honnêtes, un rapport persistant et des optimisations dérivées
 * des mesures.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluerCerveau, type RapportLaboratoire } from "./laboratoire-capacites";

let dossier: string;
beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "lab-"));
});
afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});

describe("LOT 7 — banc d'évaluation indépendant", () => {
  it("évalue les SIX capacités avec des scores bornés et des épreuves réelles", async () => {
    const r = await evaluerCerveau(dossier, dossier);
    const noms = r.capacites.map((c) => c.capacite);
    expect(noms).toEqual(["semantique", "generation-native", "raisonnement", "memoire", "unification", "multimodal"]);
    for (const c of r.capacites) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(1);
      expect(c.epreuves.length).toBeGreaterThanOrEqual(3);
      for (const epr of c.epreuves) {
        expect(epr.mesure.length).toBeGreaterThan(0); // mesure brute toujours présente
      }
    }
    expect(r.scoreGlobal).toBeGreaterThanOrEqual(0);
    expect(r.scoreGlobal).toBeLessThanOrEqual(1);
    expect(r.dureeTotaleMs).toBeGreaterThan(0);
  }, 60_000);

  it("les capacités sémantique/raisonnement/mémoire/génération réussissent TOUTES leurs épreuves", async () => {
    const r = await evaluerCerveau(dossier, dossier);
    for (const nom of ["semantique", "generation-native", "raisonnement", "memoire"]) {
      const c = r.capacites.find((x) => x.capacite === nom)!;
      const echecs = c.epreuves.filter((e) => !e.reussie).map((e) => `${e.nom} (${e.mesure})`);
      expect(echecs, `${nom} : épreuves échouées`).toEqual([]);
      expect(c.score).toBe(1);
    }
  }, 60_000);

  it("unification et multimodal : épreuves réelles vertes (composants du cerveau)", async () => {
    const r = await evaluerCerveau(dossier, dossier);
    const uni = r.capacites.find((x) => x.capacite === "unification")!;
    expect(uni.epreuves.every((e) => e.reussie), uni.epreuves.filter((e) => !e.reussie).map((e) => e.mesure).join(" | ")).toBe(true);
    const mul = r.capacites.find((x) => x.capacite === "multimodal")!;
    expect(mul.epreuves.every((e) => e.reussie), mul.epreuves.filter((e) => !e.reussie).map((e) => e.mesure).join(" | ")).toBe(true);
  }, 60_000);

  it("rapport persistant réel : dernier-rapport.json + fichier daté", async () => {
    const r = await evaluerCerveau(dossier, dossier);
    const dernier = join(dossier, "dernier-rapport.json");
    expect(existsSync(dernier)).toBe(true);
    const relu = JSON.parse(readFileSync(dernier, "utf8")) as RapportLaboratoire;
    expect(relu.capacites.length).toBe(6);
    expect(relu.scoreGlobal).toBe(r.scoreGlobal);
    expect(existsSync(join(dossier, `capacites-${r.dateIso.replace(/[:.]/gu, "-")}.json`))).toBe(true);
  }, 60_000);

  it("optimisations dérivées des mesures (aucune suggestion inventée)", async () => {
    const r = await evaluerCerveau(dossier, dossier);
    for (const o of r.optimisations) {
      expect(o.cible).toBeTruthy();
      expect(o.constat).toMatch(/score|durée/); // constat = une mesure
      expect(o.suggestion.length).toBeGreaterThan(10);
    }
    // Si tout est vert et dans le budget : zéro recommandation (honnête).
    const toutVert = r.capacites.every((c) => c.score === 1 && c.dureeMs <= 5_000);
    expect(r.optimisations.length === 0).toBe(toutVert);
  }, 60_000);

  it("le score global est la moyenne égale des capacités (déterminisme)", async () => {
    const r = await evaluerCerveau(dossier, dossier);
    const moyenne = Math.round((r.capacites.reduce((s, c) => s + c.score, 0) / r.capacites.length) * 1000) / 1000;
    expect(r.scoreGlobal).toBe(moyenne);
  }, 60_000);
});
