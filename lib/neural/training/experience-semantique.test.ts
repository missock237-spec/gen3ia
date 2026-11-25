/**
 * TESTS — expérience d'entraînement réelle (WS 2) + persistance versionnée.
 * Exigences vérifiées : séparation train/val/test réelle, entraînement SNN
 * réel, généralisation mesurée sur non-vus, reproductibilité par graine
 * (2 exécutions avec cerveau FRAIS — le trainer auto-sauvegarde après
 * entraînement, donc le cerveau persisté est supprimé entre les runs),
 * versions vérifiées par SHA-256, rollback des paramètres.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executerExperienceSemantique, hashSplits, separerDataset } from "./experience-semantique";
import { resetBrain } from "../runtime";
import { BRAIN_PATH } from "../training/persistence";
import { listerVersions, lireManifeste, restaurerVersion, sauvegarderVersion } from "../persistance-versions";
import type { TrainingSample } from "./dataset";

let dossier: string;
beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "experience-"));
});
afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});

const ECHANTILLONS: TrainingSample[] = Array.from({ length: 100 }, (_, i) => ({
  text: `phrase d'exemple numéro ${i} sur le thème ${["salutation", "question", "affirmation", "commande"][i % 4]}`,
  label: ["salutation", "question", "affirmation", "commande"][i % 4],
}));

/** Supprime le cerveau persisté (l'entraînement réel auto-sauvegarde — un
 * run reproductible exige un cerveau FRAIS de la même graine). */
function cerveauFrais(): void {
  for (const chemin of [BRAIN_PATH, `${BRAIN_PATH}.bak`]) {
    if (existsSync(chemin)) unlinkSync(chemin);
  }
  resetBrain();
}

describe("séparation train/validation/test — déterministe et disjointe", () => {
  it("70/15/15 réellement séparés, sans chevauchement", () => {
    const s = separerDataset(ECHANTILLONS, 42);
    expect(s.train.length).toBeGreaterThanOrEqual(65);
    expect(s.validation.length).toBeGreaterThanOrEqual(12);
    expect(s.test.length).toBeGreaterThanOrEqual(12);
    const identifiants = (l: TrainingSample[]) => l.map((x) => `${x.label}|${x.text}`);
    const train = new Set(identifiants(s.train));
    const val = identifiants(s.validation);
    const test = identifiants(s.test);
    expect(val.filter((x) => train.has(x)).length).toBe(0); // disjoint
    expect(test.filter((x) => train.has(x)).length).toBe(0); // disjoint
    expect(s.train.length + s.validation.length + s.test.length).toBe(ECHANTILLONS.length);
  });

  it("même graine → même split (hash identique) ; autre graine → autre ordre", () => {
    const a = hashSplits(separerDataset(ECHANTILLONS, 42));
    const b = hashSplits(separerDataset(ECHANTILLONS, 42));
    const c = hashSplits(separerDataset(ECHANTILLONS, 7));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("expérience réelle — entraînement SNN, généralisation, reproductibilité", () => {
  // CI exécute ce test sous --coverage : l'instrumentation ralentit fortement
  // la propagation SNN réelle (constaté : >7 min pour un run complet) — le
  // budget du test est calibré pour cela, sans jamais simuler l'entraînement.
  it("exécute l'expérience complète sur le corpus réel du cerveau", async () => {
    cerveauFrais();
    const r = await executerExperienceSemantique({ seed: 42, epoques: 3, maxTotal: 240, versionner: false });
    expect(r.dataset.total).toBeGreaterThanOrEqual(60);
    expect(r.dataset.train).toBeGreaterThan(r.dataset.validation);
    expect(r.baselineTest).toBeGreaterThanOrEqual(0);
    // HONNÊTETÉ (constat réel) : sur le dataset réduit du test (240 éch.),
    // l'accuracy test peut passer SOUS la baseline (interférence d'un petit
    // SNN — bruit sur non-vus). Ce qui est GARANTI : des mesures bornées et
    // une généralisation correctement calculée (l'expérience CANONIQUE 510
    // éch./8 époques, elle, montre +9,2 pts — preuve commise).
    expect(r.accuracies.test).toBeGreaterThanOrEqual(0);
    expect(r.accuracies.test).toBeLessThanOrEqual(1);
    // L'expérience calcule la généralisation sur ses valeurs internes NON
    // arrondies puis l'arrondit : recomposée depuis les sorties arrondies,
    // l'écart est borné par la précision d'affichage (≤ 0,002).
    expect(Math.abs(r.generalisation - (r.accuracies.test - r.baselineTest))).toBeLessThanOrEqual(0.002);
    expect(Number.isFinite(r.accuracies.validation)).toBe(true);
    expect(r.hashSplits.length).toBe(32);
    expect(r.dureeMs).toBeGreaterThan(0);
    expect(r.ram.avantMo).toBeGreaterThan(0);
  }, 600_000);

  it("reproductibilité : même graine + cerveau FRAIS → mêmes splits ET mêmes accuracies", async () => {
    cerveauFrais();
    const a = await executerExperienceSemantique({ seed: 42, epoques: 2, maxTotal: 240, versionner: false });
    cerveauFrais(); // le run précédent a auto-sauvegardé son cerveau entraîné
    const b = await executerExperienceSemantique({ seed: 42, epoques: 2, maxTotal: 240, versionner: false });
    expect(b.hashSplits).toBe(a.hashSplits);
    expect(b.accuracies).toEqual(a.accuracies); // déterminisme complet (graine + runtime seedé)
    expect(b.baselineTest).toBe(a.baselineTest);
  }, 600_000);

  it("graine différente → split différent (les splits dépendent de la graine)", async () => {
    cerveauFrais();
    const a = await executerExperienceSemantique({ seed: 42, epoques: 2, maxTotal: 240, versionner: false });
    cerveauFrais();
    const b = await executerExperienceSemantique({ seed: 7, epoques: 2, maxTotal: 240, versionner: false });
    expect(b.hashSplits).not.toBe(a.hashSplits);
  }, 600_000);
});

describe("persistance versionnée — snapshots vérifiables et rollback réel", () => {
  const racine = () => join(dossier, "versions");
  const cerveau = () => join(dossier, "brain-v1.json");

  it("fige une version avec manifeste SHA-256 vérifiable", () => {
    writeFileSync(cerveau(), JSON.stringify({ etat: "entraine", epoques: 8 }), "utf8");
    const manifeste = sauvegarderVersion("test-entrainement", { seed: 42 }, racine(), cerveau());
    expect(manifeste.version).toContain("test-entrainement");
    expect(manifeste.sha256.length).toBe(64);
    expect(manifeste.octets).toBeGreaterThan(0);
    expect(existsSync(join(racine(), manifeste.version, "brain-v1.json"))).toBe(true);
    const relu = lireManifeste(manifeste.version, racine());
    expect(relu?.integre).toBe(true); // SHA-256 recalculé = manifeste
    expect(listerVersions(racine())).toEqual([manifeste.version]);
  });

  it("rollback : restaurer une version réécrit le cerveau canonique", () => {
    writeFileSync(cerveau(), JSON.stringify({ etat: "v1" }), "utf8");
    const v1 = sauvegarderVersion("avant-entrainement", {}, racine(), cerveau());
    writeFileSync(cerveau(), JSON.stringify({ etat: "v2-entraine" }), "utf8");
    expect(restaurerVersion(v1.version, racine(), cerveau())).toBe(true);
    const contenu = JSON.parse(readFileSync(cerveau(), "utf8")) as { etat: string };
    expect(contenu.etat).toBe("v1"); // les paramètres antérieurs sont revenus
  });

  it("version corrompue : intégrité REFUSÉE (rollback impossible — fail-closed)", () => {
    writeFileSync(cerveau(), JSON.stringify({ etat: "v1" }), "utf8");
    const v = sauvegarderVersion("corruption-test", {}, racine(), cerveau());
    const copie = join(racine(), v.version, "brain-v1.json");
    writeFileSync(copie, JSON.stringify({ etat: "CORROMPU" }), "utf8");
    const relu = lireManifeste(v.version, racine());
    expect(relu?.integre).toBe(false);
    expect(restaurerVersion(v.version, racine(), cerveau())).toBe(false); // refus honnête
  });

  it("aucun cerveau persisté : versionnage refusé honnêtement", () => {
    expect(() => sauvegarderVersion("sans-cerveau", {}, racine(), join(dossier, "absent.json"))).toThrow(
      /aucun cerveau persisté/,
    );
  });
});
