import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ÉVOLUTION PILOTÉE DE LA CONSOLE NEURONALE (it.46) — conventions du
 * dépôt : vitest tourne en Node SANS jsdom ni @testing-library/react
 * (cf. components/developer/tabs/secrets-panel.test.tsx). Le câblage de
 * la porte /api/neural/evolve dans l'onglet Cerveau de la console
 * (components/neural/neural-console.tsx) est verrouillé structurellement :
 *
 *  1. LES MÉTRIQUES RÉELLES SONT CONSOMMÉES : GET /api/neural/evolve via
 *     le hook useTelechargement, rafraîchissement périodique conditionné à
 *     l'onglet Cerveau (pas d'appel inutile ailleurs) — échanges observés,
 *     consolidés, écartés (qualité), cycles, cortex (paires, vocabulaire,
 *     thèmes) et horodatage de la dernière consolidation.
 *  2. LA CONSOLIDATION EST PILOTABLE : POST /api/neural/evolve — un cycle
 *     de consolidation audité (auth + rate-limit 6/min côté route) scelle
 *     les apprentissages ; le retour honnête (enseignées / déjà connues /
 *     écartées / sauvegarde) est affiché, le cerveau et les métriques sont
 *     rafraîchis après succès.
 *  3. L'ÉTAT DE LA CONSOLIDATION EST HONNÊTE : bouton désactivé pendant
 *     l'envoi (consolidationEnCours), message d'échec en cas d'erreur
 *     serveur — jamais de succès inventé.
 *  4. SESSION PAR COOKIE : fetch same-origin (convention du fichier,
 *     session `gen3ia_session` portée par le navigateur) — aucune
 *     dépendance à un service externe.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CONSOLE = "components/neural/neural-console.tsx";

describe("Évolution pilotée de la console neuronale (câblage /api/neural/evolve, it.46)", () => {
  const console_ = read(CONSOLE);

  it("les métriques réelles d'évolution sont consommées (GET, polling conditionné à l'onglet Cerveau)", () => {
    expect(console_).toContain("/api/neural/evolve");
    expect(console_).toContain('onglet === "cerveau" ? "/api/neural/evolve" : ""');
    expect(console_).toContain("useTelechargement<MetriquesEvolution>");
    // Les métriques affichées sont celles de la porte, pas des estimations :
    // écartés (qualité), cycles, cortex détaillé, horodatage de la dernière
    // consolidation.
    expect(console_).toContain("evolution.evolution.echangesObserves");
    expect(console_).toContain("evolution.evolution.echangesEcarts");
    expect(console_).toContain("evolution.evolution.cyclesConsolidation");
    expect(console_).toContain("evolution.cortex.vocabulaire");
    expect(console_).toContain("evolution.cortex.themes");
    expect(console_).toContain("evolution.evolution.derniereConsolidation");
  });

  it("la consolidation est pilotable : POST audité avec rafraîchissement du cerveau et des métriques", () => {
    expect(console_).toContain('fetch("/api/neural/evolve", { method: "POST" })');
    expect(console_).toContain("consoliderMaintenant");
    // Après consolidation : les métriques ET la constellation sont
    // rafraîchies — l'utilisateur voit l'effet réel, pas un message figé.
    expect(console_).toContain("void rafraichirEvolution();");
    expect(console_).toContain("void rafraichirCerveau();");
    // Le retour honnête de la route est affiché (enseignées, déjà connues,
    // écartées, sauvegarde) — jamais de succès générique.
    expect(console_).toContain("data.consolidation.enseignees");
    expect(console_).toContain("data.consolidation.dejaConnues");
    expect(console_).toContain("data.consolidation.ecarts");
    expect(console_).toContain("data.sauvegarde");
  });

  it("l'état de la consolidation est honnête : bouton désactivé pendant l'envoi, échec affiché", () => {
    expect(console_).toContain("consolidationEnCours");
    expect(console_).toContain("disabled={consolidationEnCours}");
    expect(console_).toContain("consolidation…");
    expect(console_).toContain("Consolider maintenant");
    // Le message d'échec est rendu avec un role status (a11y) et ne prétend
    // jamais un succès.
    expect(console_).toContain('role="status"');
    expect(console_).toContain("`échec : ${");
  });

  it("aucune dépendance externe : la porte consommée est uniquement /api/neural/evolve (session cookie same-origin)", () => {
    // L'évolution pilotée n'appelle QUE la porte maison — zéro service
    // d'IA externe (le cerveau SNN reste 100 % local).
    const sectionEvolution = console_.slice(
      console_.indexOf("Évolution pilotée (it.46) ----------------"),
      console_.indexOf("/* ---------------- Rendu ---------------- */"),
    );
    expect(sectionEvolution).toContain("/api/neural/evolve");
    expect(sectionEvolution).not.toMatch(/https?:\/\//);
    expect(sectionEvolution).not.toContain("axios");
  });
});
