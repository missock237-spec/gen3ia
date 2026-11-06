/**
 * GARDE COMPARTIMENT SCIENCES (MONDE VIRTUEL) — Gen3 doit SIMULER le
 * fonctionnement du monde (pas réciter), et la passerelle doit entraîner
 * des IA utilisatrices avec un feedback MESURÉ (erreur relative réelle).
 */
import { describe, expect, it } from "vitest";

import { simuler } from "@/lib/monde/univers";

import {
  CAPACITE_AGENTS_PASSERELLE,
  CAPACITE_OBSERVATIONS_PASSERELLE,
  CompartimentMondeGen3,
  PasserelleIaUtilisateurs,
} from "./monde-virtuel";

describe("compartiment sciences — le cerveau du monde virtuel", () => {
  it("simule un projectile et reproduit les valeurs physiques", () => {
    const monde = new CompartimentMondeGen3();
    const r = monde.repondre("projectile lancé à 20 m/s avec un angle de 45 degrés");
    expect(r).not.toBeNull();
    expect(r!.resolu).toBe(true);
    expect(r!.texte).toContain("Compartiment sciences");
    expect(r!.texte).toContain("Simulation exécutée");
    expect(r!.scalaires.length).toBeGreaterThan(0);
    // La portée analytique sans traînée : d = v²·sin(2α)/g = 400/9,81 ≈ 40,77 m
    const portee = r!.scalaires.find((s) => /port|distance/i.test(s.nom));
    if (portee) expect(portee.valeur).toBeCloseTo(400 / 9.81, 1);
  });

  it("refuse les questions qui ne sont pas des simulations certaines", () => {
    const monde = new CompartimentMondeGen3();
    expect(monde.repondre("quel est le capital de la France")).toBeNull();
    expect(monde.repondre("")).toBeNull();
    expect(monde.repondre("bonjour")).toBeNull();
  });

  it("documente honnêtement ses familles de simulation", () => {
    const monde = new CompartimentMondeGen3();
    const cap = monde.capacites();
    expect(cap).toContain("projectile");
    expect(cap).toContain("diffusionChaleur");
    expect(cap).toContain("circuitRLC");
    expect(cap.length).toBeGreaterThanOrEqual(20);
  });
});

describe("passerelle à IA utilisatrices — boucle observer → prédire → feedback", () => {
  it("enregistre un agent de façon déterministe (même nom → même id)", () => {
    const p = new PasserelleIaUtilisateurs();
    const a1 = p.enregistrerAgent("IA de l'utilisateur A");
    const a2 = p.enregistrerAgent("IA de l'utilisateur A");
    expect(a1).not.toBeNull();
    expect(a2!.id).toBe(a1!.id);
    expect(a2!.dejaEnregistree).toBe(true);
    expect(p.enregistrerAgent("   ")).toBeNull();
  });

  it("émet une observation masquée et évalue la prédiction exacte à score 1", () => {
    const p = new PasserelleIaUtilisateurs();
    const agent = p.enregistrerAgent("Agent test")!;
    const spec = { type: "projectile", v0: 20, angleDeg: 45 } as const;
    const emise = p.emettreObservation(spec);
    expect(emise).not.toBeNull();
    const obs = emise!.observation;
    expect(obs.cible.nom.length).toBeGreaterThan(0);
    // La valeur réelle est MASQUÉE dans la vue publique :
    expect(JSON.stringify(obs)).not.toContain("valeurReelle");

    // L'agent calcule sa prédiction depuis la physique (comme une IA entraînée)…
    const resultat = simuler(spec);
    const cible = resultat.scalaires.find((s) => s.nom === obs.cible.nom)!;
    expect(p.soumettrePrediction(agent.id, obs.id, cible.valeur)).toBe(true);

    const feedbacks = p.evaluerObservation(obs.id);
    expect(feedbacks).not.toBeNull();
    expect(feedbacks!.length).toBe(1);
    expect(feedbacks![0]!.score).toBe(1);
    expect(feedbacks![0]!.valeurReelle).toBe(cible.valeur);
  });

  it("pénalise une prédiction fausse (erreur relative mesurée, score borné)", () => {
    const p = new PasserelleIaUtilisateurs();
    const agent = p.enregistrerAgent("Agent approximatif")!;
    const emise = p.emettreObservation({ type: "projectile", v0: 20, angleDeg: 45 });
    const obs = emise!.observation;
    expect(p.soumettrePrediction(agent.id, obs.id, obs.cible.unite === "m" ? 1e9 : 0)).toBe(true);
    const feedbacks = p.evaluerObservation(obs.id)!;
    expect(feedbacks[0]!.score).toBeLessThan(0.1);
    expect(feedbacks[0]!.score).toBeGreaterThanOrEqual(0);
    // Idempotence : réévaluer ne change pas le verdict.
    const again = p.evaluerObservation(obs.id)!;
    expect(again[0]!.score).toBe(feedbacks[0]!.score);
  });

  it("refuse une prédiction double et les identifiants inconnus", () => {
    const p = new PasserelleIaUtilisateurs();
    const agent = p.enregistrerAgent("Agent unique")!;
    const emise = p.emettreObservation({ type: "pendule", longueur: 1, angleDeg: 15 });
    const obs = emise!.observation;
    expect(p.soumettrePrediction(agent.id, obs.id, 1)).toBe(true);
    expect(p.soumettrePrediction(agent.id, obs.id, 2)).toBe(false);
    expect(p.soumettrePrediction("iau_inconnu", obs.id, 1)).toBe(false);
    expect(p.soumettrePrediction(agent.id, "obs_inconnu", 1)).toBe(false);
    expect(p.evaluerObservation("obs_inconnu")).toBeNull();
    expect(p.emettreObservation({ type: "chuteLibre", masse: 1, trainee: 0, altitude0: -5 } as never)).not.toBeNull();
  });

  it("borne ses anneaux (agents et observations)", () => {
    const p = new PasserelleIaUtilisateurs();
    for (let i = 0; i < CAPACITE_AGENTS_PASSERELLE + 10; i++) {
      p.enregistrerAgent(`agent-${i}`);
    }
    expect(p.statistiques().agents).toBe(CAPACITE_AGENTS_PASSERELLE);
    for (let i = 0; i < CAPACITE_OBSERVATIONS_PASSERELLE + 10; i++) {
      p.emettreObservation({ type: "projectile", v0: 10 + i, angleDeg: 45 });
    }
    expect(p.statistiques().observations).toBe(CAPACITE_OBSERVATIONS_PASSERELLE);
  });

  it("rend des statistiques honnêtes (scoreMoyen null sans évaluation)", () => {
    const p = new PasserelleIaUtilisateurs();
    const s = p.statistiques();
    expect(s.scoreMoyen).toBeNull();
    expect(s.agents).toBe(0);
    p.enregistrerAgent("X");
    p.emettreObservation({ type: "projectile", v0: 15, angleDeg: 30 });
    expect(p.statistiques().observations).toBe(1);
    expect(p.statistiques().predictions).toBe(0);
  });
});
