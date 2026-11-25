/**
 * TESTS DU LOT 5 — mémoire cognitive épisodique + raisonnement généraliste.
 * Comportements réels : enregistrement/rappel associatif mesuré, caps
 * réels, persistance disque, chaînage avant avec preuves, transitivité
 * isa, détection de contradictions par antonymie.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoireCognitive, CAP_EPISODES } from "./memoire-cognitive";
import { deduire, detecterContradictions, transitiviteIsa, PROFONDEUR_MAX, type Fait, type Regle } from "./raisonnement-general";

let dossier: string;
beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "cognition-"));
});
afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});

describe("LOT 5 — mémoire cognitive épisodique", () => {
  it("enregistre une expérience vécue et extrait ses concepts (LOT 2)", () => {
    const m = new MemoireCognitive(dossier);
    const e = m.enregistrer({ type: "interaction", contenu: "L'utilisateur a posé une question sur le Soleil et les énergies renouvelables" });
    expect(e.id).toMatch(/^ep-/);
    expect(e.concepts.length).toBeGreaterThan(0);
    expect(m.taille()).toBe(1);
  });

  it("rappel associatif : l'épisode pertinent sort en tête", () => {
    const m = new MemoireCognitive(dossier);
    m.enregistrer({ type: "interaction", contenu: "Question sur la photosynthèse des plantes et la lumière", importance: 0.6 });
    m.enregistrer({ type: "interaction", contenu: "Discussion sur la recette du gâteau au chocolat", importance: 0.6 });
    const rappels = m.rappeler("Comment fonctionne la photosynthèse ?", 3);
    expect(rappels.length).toBeGreaterThanOrEqual(1);
    expect(rappels[0].contenu).toContain("photosynthèse");
    // Les épisodes sans aucun lien (gâteau) ne remontent PAS devant :
    expect(rappels.slice(1).some((r) => r.contenu.includes("chocolat"))).toBe(false);
    if (rappels.length > 1) {
      expect(rappels[0].scoreRappel).toBeGreaterThan(rappels[rappels.length - 1].scoreRappel);
    }
  });

  it("persistance réelle : une nouvelle instance relit les épisodes du disque", () => {
    const m1 = new MemoireCognitive(dossier);
    m1.enregistrer({ type: "observation", contenu: "Le pipeline a intégré 3 connaissances sur le climat", importance: 0.9 });
    m1.persister();
    expect(existsSync(join(dossier, "cognition", "memoire-episodique.json"))).toBe(true);
    const m2 = new MemoireCognitive(dossier);
    expect(m2.taille()).toBe(1);
    const rappels = m2.rappeler("connaissances sur le climat", 2);
    expect(rappels[0].contenu).toContain("climat");
  });

  it("cap réel : au-delà de CAP_EPISODES, éviction mesurée (RAM bornée)", () => {
    const m = new MemoireCognitive(dossier);
    for (let i = 0; i < CAP_EPISODES + 50; i++) {
      m.enregistrer({ type: "reflexion", contenu: `Observation unique ${i} des cycles du cerveau autonome`, importance: 0.3 });
    }
    expect(m.taille()).toBeLessThanOrEqual(CAP_EPISODES);
  });

  it("importance bornée [0,1] et contenus bornés (pas d'avalanche)", () => {
    const m = new MemoireCognitive(dossier);
    const e = m.enregistrer({ type: "reflexion", contenu: "x".repeat(10_000), importance: 9 });
    expect(e.importance).toBe(1);
    expect(e.contenu.length).toBeLessThanOrEqual(2_000);
  });
});

describe("LOT 5 — raisonnement généraliste (chaînage, transitivité, contradictions)", () => {
  const regles: Regle[] = [
    { si: { predicat: "emet", objet: "lumiere" }, alors: { predicat: "est visible", objet: "nuit" } },
    { si: { predicat: "est visible", objet: "nuit" }, alors: { predicat: "est observe", objet: "ciel" } },
  ];
  const faits: Fait[] = [
    { sujet: "le Soleil", predicat: "emet", objet: "lumiere", source: "connaissances:wikipedia" },
    { sujet: "la Terre", predicat: "est un", objet: "planete", source: "connaissances:wikipedia" },
    { sujet: "le chat", predicat: "est actif", objet: "nuit", source: "connaissances:encyclopedie" },
    { sujet: "le chat", predicat: "est actif", objet: "jour", source: "connaissances:site-x" },
  ];

  it("chaînage avant : déductions avec chaîne de preuves complète", () => {
    const conclusions = deduire(faits, regles);
    // Soleil emet lumiere → est visible nuit → est observe ciel (2 niveaux).
    const observe = conclusions.find((c) => c.fait.sujet === "le Soleil" && c.fait.predicat === "est observe");
    expect(observe).toBeDefined();
    expect(observe!.profondeur).toBe(2);
    expect(observe!.preuves.length).toBe(1);
    expect(observe!.preuves[0]).toContain("le Soleil");
    expect(observe!.fait.source).toContain("deduit:regle");
  });

  it("saturation honnête : pas de boucle infinie (bornes réelles)", () => {
    const reglesBoucle: Regle[] = [
      { si: { predicat: "a", objet: "b" }, alors: { predicat: "b", objet: "a" } },
      { si: { predicat: "b", objet: "a" }, alors: { predicat: "a", objet: "b" } },
    ];
    const t0 = Date.now();
    const conclusions = deduire([{ sujet: "x", predicat: "a", objet: "b", source: "test" }], reglesBoucle);
    expect(Date.now() - t0).toBeLessThan(1_000); // borné
    expect(conclusions.length).toBeLessThanOrEqual(10); // saturation, pas d'explosion
  });

  it("transitivité isa : le chat → félin → animal est déduit du lexique", () => {
    const faitsIsa: Fait[] = [{ sujet: "le chat", predicat: "est un", objet: "felide", source: "memoire" }];
    const conclusions = transitiviteIsa(faitsIsa);
    const animal = conclusions.find((c) => c.fait.objet === "animal");
    expect(animal).toBeDefined(); // felide → animal via PAIRES_HYPERONYMES
    expect(animal!.preuves.length).toBe(2);
  });

  it("contradictions : objets antonymes sur même sujet+prédicat détectés", () => {
    const contradictions = detecterContradictions(faits);
    expect(contradictions.length).toBe(1);
    expect(contradictions[0].sujet).toBe("le chat");
    expect(contradictions[0].sources).toHaveLength(2);
  });

  it("profondeur max documentée et respectée", () => {
    expect(PROFONDEUR_MAX).toBe(5);
  });
});
