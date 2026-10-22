import { describe, expect, it } from "vitest";

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { analyserScene, construireLexique } from "./scene-spec";
import {
  CORPUS_AMORCAGE,
  ENSEIGNEMENTS,
  entrainerLexiqueMultimodal,
  VALEURS_VALIDES,
} from "./entrainement-lexique";

/**
 * ENTRAÎNEMENT HORS PRODUCTION DU LEXIQUE MULTIMODAL — verrous :
 *  1. l'entraînement AMÉLIORE la précision mesurée (jamais la dégrade) ;
 *  2. l'ARTEFACT est bien formé (v1, entrées typées, termes normalisés) ;
 *  3. SÉCURITÉ : aucun enseignement ne crée de valeur hors liste, aucun
 *     conflit avec l'intégré, les refus sont justifiés ;
 *  4. ROUND-TRIP : l'artefact committé charge et enrichit réellement
 *     l'analyseur (mots appris reconnus) ;
 *  5. DÉTERMINISME : deux entraînements produisent le même artefact.
 */

describe("entrainerLexiqueMultimodal", () => {
  const { appris, rapport } = entrainerLexiqueMultimodal();

  it("améliore la précision mesurée sur le jeu d'entraînement (jamais dégradée)", () => {
    expect(rapport.apres.precisionTrain).toBeGreaterThanOrEqual(rapport.avant.precisionTrain);
    expect(rapport.apres.precisionTest).toBeGreaterThanOrEqual(rapport.avant.precisionTest);
    // La précision finale est mesurée, non inventée (0..1).
    expect(rapport.apres.precisionTrain).toBeGreaterThan(0);
    expect(rapport.apres.precisionTrain).toBeLessThanOrEqual(1);
  });

  it("produit un artefact v1 bien formé (entrées typées, normalisées, non vides)", () => {
    expect(appris.v).toBe(1);
    expect(appris.entries.length).toBeGreaterThan(50);
    for (const entree of appris.entries) {
      expect(entree.terme).toBe(entree.terme.toLowerCase());
      expect(entree.terme.length).toBeGreaterThanOrEqual(2);
      expect(VALEURS_VALIDES[entree.categorie]).toContain(entree.valeur);
    }
  });

  it("n'écrase JAMAIS le lexique intégré (aucun terme déjà couvert réappris)", () => {
    const integre = construireLexique(null);
    for (const entree of appris.entries) {
      const integrePrime = integre.exactes.has(entree.terme);
      expect(integrePrime).toBe(false);
    }
    expect(rapport.enseignementsRefuses).toBeGreaterThan(0); // les conflits sont refusés, pas cachés
    expect(rapport.raisonsRefus.length).toBeLessThanOrEqual(20);
  });

  it("round-trip : les mots appris sont réellement reconnus par l'analyseur", () => {
    const enrichi = construireLexique(appris);
    expect(analyserScene("un minou dort", enrichi).sujet?.type).toBe("chat");
    expect(analyserScene("une clairière au matin", enrichi).cadre).toBe("foret");
    expect(analyserScene("une aquarelle pastel", enrichi).style).toBe("aquarelle");
    expect(analyserScene("un fjord entouré de crêtes", enrichi).cadre).toBe("montagne");
  });

  it("corpus et enseignements : matière réelle, aucune métrique simulée", () => {
    expect(CORPUS_AMORCAGE.length).toBeGreaterThanOrEqual(45);
    expect(CORPUS_AMORCAGE.some((e) => e.test === true)).toBe(true); // jeu test tenu à l'écart
    expect(ENSEIGNEMENTS.length).toBeGreaterThan(100);
    expect(rapport.environnement).toContain("HORS PRODUCTION");
  });

  it("déterminisme : deux entraînements → artefacts identiques", () => {
    const second = entrainerLexiqueMultimodal();
    expect(second.appris).toEqual(appris);
    expect(second.rapport.apres).toEqual(rapport.apres);
  });
});

describe("artefact committé (assets/neural-pretrained)", () => {
  const cheminArtefact = join(process.cwd(), "assets/neural-pretrained/multimodal-lexique-v1.json");
  const cheminRapport = join(process.cwd(), "assets/neural-pretrained/pretrain-multimodal-report.json");

  it("l'artefact et son rapport honnête sont committés et chargeables", () => {
    expect(existsSync(cheminArtefact)).toBe(true);
    expect(existsSync(cheminRapport)).toBe(true);
    const artefact = JSON.parse(readFileSync(cheminArtefact, "utf-8")) as { v: number; entries: unknown[] };
    expect(artefact.v).toBe(1);
    expect(artefact.entries.length).toBeGreaterThan(50);
    const rapport = JSON.parse(readFileSync(cheminRapport, "utf-8")) as {
      avant: { precisionTrain: number };
      apres: { precisionTrain: number };
      environnement: string;
    };
    expect(rapport.environnement).toContain("HORS PRODUCTION");
    expect(rapport.apres.precisionTrain).toBeGreaterThanOrEqual(rapport.avant.precisionTrain);
  });

  it("l'artefact committé correspond EXACTEMENT à l'entraînement actuel", () => {
    const { appris } = entrainerLexiqueMultimodal();
    const commis = JSON.parse(readFileSync(cheminArtefact, "utf-8"));
    expect(commis).toEqual(appris);
  });
});
