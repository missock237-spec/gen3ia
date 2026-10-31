/**
 * GARDE 36ᵉ (it.67) — LA SOURCE INTERNE DE QUESTIONS EST RÉELLE,
 * ANCRÉE CHARTE ET ANTI-REJOUE.
 *
 * Demande propriétaire (it.66/67) : « fais en sorte qu'il soit capable de
 * répondre à des questions qui rentrent dans son cadre d'apprentissage » —
 * puis le rapport it.66 (suite n°2) : brancher le corpus QA dans la boucle
 * d'auto-apprentissage pour que le cycle génère AUSSI des questions.
 *
 * Verrous :
 *  1. DÉTERMINISME : même (domaine, indice) → même paire, toujours ;
 *  2. ANCRAGE CHARTE : la question cite une tâche + un mot-clé RÉELS de la
 *     charte, la réponse cite la tâche + les outils RÉELS du registre —
 *     zéro invention, zéro pourcentage, zéro fait externe ;
 *  3. COUVERTURE 19/19 domaines, FR + EN (gabarits des deux langues) ;
 *  4. ESPACE MESURÉ : espaceQuestionsDomaine = gabarits × tâches ×
 *     mots-clés (par langue) — fini, calculé, jamais gonflé ;
 *  5. ANTI-REJOUE : deux cycles consécutifs produisent des lots DISJOINTS
 *     (offset = cycle × taille) ;
 *  6. CÂBLAGE : la boucle d'auto-apprentissage appelle la source et le
 *     rapport de cycle la mentionne (champ `questions` additif).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CORPUS_QUESTIONS_VOCATION,
  espaceQuestionsDomaine,
  paireQuestionGenere,
} from "./corpus-questions";
import { DOMAINES_VOCATION } from "./vocation";

describe("garde 36ᵉ — source interne de questions du cadre (it.67)", () => {
  it("déterminisme : même (domaine, indice) → même paire", () => {
    for (const domaine of DOMAINES_VOCATION) {
      const a = paireQuestionGenere(domaine.id, 7);
      const b = paireQuestionGenere(domaine.id, 7);
      expect(a).toEqual(b);
    }
  });

  it("ancrage charte : la question cite une tâche + un mot-clé RÉELS, la réponse la tâche + les outils réels", () => {
    for (const domaine of DOMAINES_VOCATION) {
      for (const i of [0, 1, 2, 3, 4, 5, 12, 33]) {
        const paire = paireQuestionGenere(domaine.id, i);
        const citeTache = domaine.taches.some((t) => paire.question.includes(t));
        const citeMotcle = domaine.motsCles.some((m) => paire.question.includes(m));
        expect(citeTache).toBe(true);
        expect(citeMotcle).toBe(true);
        // La réponse cite la tâche (entre guillemets dans le gabarit).
        const tacheCitee = domaine.taches.find((t) => paire.reponse.includes(t));
        expect(tacheCitee).toBeDefined();
        // Tout outil cité appartient au registre réel du domaine.
        const outilsCites = domaine.outils.filter((o) => paire.reponse.includes(o));
        expect(outilsCites.length).toBeGreaterThan(0);
      }
    }
  });

  it("zéro invention : aucun pourcentage, aucune promesse hors charte", () => {
    for (const domaine of DOMAINES_VOCATION) {
      for (const i of [0, 9, 41]) {
        const paire = paireQuestionGenere(domaine.id, i);
        expect(paire.reponse).not.toMatch(/\d+\s*%/);
        expect(paire.reponse).not.toMatch(/garanti|illimité|omniscient/i);
      }
    }
  });

  it("couverture 19/19 domaines, FR et EN", () => {
    const parDomaine = new Map<string, Set<string>>();
    for (const domaine of DOMAINES_VOCATION) {
      const langues = new Set<string>();
      for (const i of [0, 1]) {
        const paire = paireQuestionGenere(domaine.id, i);
        langues.add(paire.langue);
        expect(paire.question.length).toBeGreaterThan(10);
        expect(paire.reponse.length).toBeGreaterThan(40);
      }
      expect(langues).toEqual(new Set(["fr", "en"]));
      parDomaine.set(domaine.id, langues);
    }
    expect(parDomaine.size).toBe(19);
  });

  it("espace mesuré : gabarits × tâches × mots-clés (fini, jamais gonflé)", () => {
    for (const domaine of DOMAINES_VOCATION) {
      const espace = espaceQuestionsDomaine(domaine.id);
      // 8 gabarits FR + 6 gabarits EN (constantes du générateur).
      expect(espace.fr).toBe(8 * domaine.taches.length * Math.max(1, domaine.motsCles.length));
      expect(espace.en).toBe(6 * domaine.taches.length * Math.max(1, domaine.motsCles.length));
      expect(espace.total).toBe(espace.fr + espace.en);
    }
  });

  it("anti-rejoue : les lots de deux cycles consécutifs sont disjoints", async () => {
    const { apportQuestionsVocation, QUESTIONS_VOCATION_PAR_CYCLE } = await import(
      "../entrainement-auto/generateur"
    );
    const lot0 = apportQuestionsVocation(0).map((p) => p.motif);
    const lot1 = apportQuestionsVocation(1).map((p) => p.motif);
    expect(lot0).toHaveLength(QUESTIONS_VOCATION_PAR_CYCLE);
    expect(lot1).toHaveLength(QUESTIONS_VOCATION_PAR_CYCLE);
    const ensemble0 = new Set(lot0);
    for (const q of lot1) expect(ensemble0.has(q)).toBe(false);
  });

  it("câblage : la boucle appelle la source questions et le rapport la mentionne", () => {
    const boucle = readFileSync(
      join(process.cwd(), "lib/entrainement-auto/boucle.ts"),
      "utf8",
    );
    expect(boucle).toContain("apportQuestionsVocation(etat.cyclesExecutes)");
    expect(boucle).toContain("questions: questionsVocation");

    const generateur = readFileSync(
      join(process.cwd(), "lib/entrainement-auto/generateur.ts"),
      "utf8",
    );
    expect(generateur).toContain("paireQuestionGenere");
    expect(generateur).toContain("server-only");

    const types = readFileSync(
      join(process.cwd(), "lib/entrainement-auto/types.ts"),
      "utf8",
    );
    expect(types).toContain("questions?: number");
  });

  it("le corpus fixe (pont it.66) reste inchangé et couvre 19/19", () => {
    // 304 paires mesurées (production : pairesCorpus: 304) — 4 FR + 2 EN
    // + 2 × tâches par domaine, 19 domaines.
    expect(CORPUS_QUESTIONS_VOCATION.length).toBe(304);
    const domaines = new Set(CORPUS_QUESTIONS_VOCATION.map((p) => p.domaineId));
    expect(domaines.size).toBe(19);
  });
});
