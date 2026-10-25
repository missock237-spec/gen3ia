import { describe, expect, it } from "vitest";

import {
  chargerAbréviations,
  pairesAbréviationsPourCortex,
  promptAvecAbréviations,
  reconnaitreAbréviation,
  tailleDictionnaireAbréviations,
} from "./abbreviations";

/**
 * Tests de la compréhension des abréviations FR/EN : le dataset réel
 * datasets/abbreviations/train.jsonl est chargé (836 lignes), l'expansion
 * à l'entrée double chaque sigle connu de sa forme longue, et les paires
 * cortex couvrent « que signifie X ? ».
 */
describe("abbreviations — chargement du dataset réel", () => {
  it("charge le dataset et expose un dictionnaire substantiel", async () => {
    await chargerAbréviations();
    const taille = tailleDictionnaireAbréviations();
    expect(taille).toBeGreaterThan(80); // 150+ sigles dans le lexique curé
  });

  it("reconnaît une abréviation présente dans un texte", async () => {
    await chargerAbréviations();
    const r = reconnaitreAbréviation("Le API du serveur renvoie 404");
    expect(r).not.toBeNull();
    expect(r!.expansion.toLowerCase()).toContain("interface de programmation");
  });

  it("double les sigles connus de leur forme longue (expansion à l'entrée)", async () => {
    await chargerAbréviations();
    const sortie = promptAvecAbréviations("Notre SaaS utilise un GPU pour le ML");
    expect(sortie).toContain("SaaS (");
    expect(sortie).toContain("GPU (");
    expect(sortie).toContain("ML (");
    // le sigle original reste présent (forme doublée, pas remplacée)
    expect(sortie).toContain("SaaS");
  });

  it("ne mutile pas les mots ordinaires ni les sigles inconnus", async () => {
    await chargerAbréviations();
    const original = "Le XYZQW inconnu et le mot disponible restent intacts";
    const sortie = promptAvecAbréviations(original);
    expect(sortie).toContain("XYZQW");
    expect(sortie).toContain("disponible"); // « IMC » ? non — pas de faux positif
    // aucun faux positif sur les sous-mots : « cap » dans « capable »
    const phrase = "Un système capable de tout";
    expect(promptAvecAbréviations(phrase)).toBe(phrase);
  });

  it("produit des paires cortex exploitables", async () => {
    await chargerAbréviations();
    const paires = pairesAbréviationsPourCortex(400);
    expect(paires.length).toBeGreaterThan(50);
    expect(paires[0].theme).toBe("abréviations");
    const kpi = paires.find((p) => p.motif.includes("kpi"));
    expect(kpi).toBeDefined();
    expect(kpi!.reponse.toLowerCase()).toContain("indicateur");
  });
});
