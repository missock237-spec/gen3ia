/**
 * Tests — SÉPARATION TRAIN/TEST PAR GROUPE DE PROVENANCE (vague post-audit).
 *
 * Ce que l'audit externe a dénoncé et ce qui est corrigé ici :
 *  - l'ancien découpage mélangeait les échantillons individuellement — deux
 *    reformulations d'une même source (paire bilingue FR/EN, doublon)
 *    pouvaient finir l'une en train, l'autre en test (fuite) ;
 *  - désormais un GROUPE entier va en train OU en test, jamais les deux ;
 *  - sans aucune source fournie, le comportement reste déterministe et
 *    identique à l'ancien (même graine 2024, même permutation).
 */

import { describe, expect, it } from "vitest";

import type { TrainingSample } from "./dataset";
import { separerParGroupes } from "./trainer";

function echantillons(n: number, source?: (i: number) => string): TrainingSample[] {
  return Array.from({ length: n }, (_, i) => ({
    text: `échantillon ${i}`,
    label: "INTENTION_GENERALE",
    ...(source ? { source: source(i) } : {}),
  }));
}

describe("separerParGroupes — anti-fuite", () => {
  it("un groupe entier va en train OU en test (jamais les deux)", () => {
    // 8 groupes de 3 échantillons (paires bilingues simulées).
    const samples = echantillons(24, (i) => `paire:${Math.floor(i / 3)}`);
    const { train, test, groupesTotal, groupesTest } = separerParGroupes(
      samples,
      0.15,
    );
    expect(groupesTotal).toBe(8);
    expect(groupesTest).toBeGreaterThanOrEqual(1);
    expect(train.length + test.length).toBe(24);

    const sourcesTrain = new Set(train.map((s) => s.source));
    const sourcesTest = new Set(test.map((s) => s.source));
    for (const source of sourcesTest) {
      expect(sourcesTrain.has(source)).toBe(false);
    }
    expect(test.length).toBeGreaterThan(0);
    // Un groupe entier : les membres du test partagent leur source complète.
    for (const source of sourcesTest) {
      const membres = samples.filter((s) => s.source === source);
      expect(membres.every((s) => test.includes(s))).toBe(true);
    }
  });

  it("les doublons de même texte-source ne chevauchent jamais les jeux", () => {
    const samples = echantillons(20, (i) => (i % 5 === 0 ? "texte:dupliqué" : `unique:${i}`));
    const { train, test } = separerParGroupes(samples, 0.15);
    const enTrain = train.some((s) => s.source === "texte:dupliqué");
    const enTest = test.some((s) => s.source === "texte:dupliqué");
    expect(enTrain && enTest).toBe(false);
  });

  it("sans source : découpage déterministe, reproductible au second appel", () => {
    const samples = echantillons(50);
    const premier = separerParGroupes(samples, 0.15);
    const second = separerParGroupes(samples, 0.15);
    expect(premier.groupesTotal).toBe(50);
    expect(premier.groupesTest).toBe(Math.max(1, Math.floor(50 * 0.15)));
    expect(premier.train.map((s) => s.text)).toEqual(second.train.map((s) => s.text));
    expect(premier.test.map((s) => s.text)).toEqual(second.test.map((s) => s.text));
    expect(premier.test.length).toBe(premier.groupesTest);
  });

  it("petits jeux : aucun test si moins de 10 groupes (honnêteté de mesure)", () => {
    const samples = echantillons(5);
    const { test, groupesTest } = separerParGroupes(samples, 0.15);
    expect(groupesTest).toBe(0);
    expect(test).toHaveLength(0);
  });

  it("entrées vides : séparation vide sans erreur", () => {
    const { train, test, groupesTotal } = separerParGroupes([], 0.15);
    expect(train).toHaveLength(0);
    expect(test).toHaveLength(0);
    expect(groupesTotal).toBe(0);
  });
});
