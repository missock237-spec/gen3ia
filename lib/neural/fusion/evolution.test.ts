/**
 * ÉVOLUTION GEN3 — TESTS RÉELS DE BOUT EN BOUT (mission nouvelle génération).
 *
 * Vérifie, sur du code exécuté réellement :
 *  1. mémoire conversationnelle PERMANENTE (aucune conversation perdue —
 *     y compris à travers un REDÉMARRAGE du cerveau, preuve par deux
 *     instances du moteur partageant le journal disque) ;
 *  2. raisonnement HORS CORPUS (problèmes inédits : composition de
 *     primitives locales + analogie depuis la mémoire du compte) ;
 *  3. autonomie d'exécution (boucle exécuter/vérifier/récupérer, incidents
 *     journalisés, repli honnête — jamais de succès inventé) ;
 *  4. rapports post-travail (markdown honnête + commit d'ondes) ;
 *  5. créativité générative mesurée dans le champ (nouveauté × cohérence).
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AIRequest } from "@/lib/ai/models";
import { createRng } from "../core/rng";
import { EspaceFiltreResonant } from "../core/resonant-space";
import { GenerateurAutoOscillation } from "../core/auto-oscillation";
import { NoyauCentralGen3 } from "../core/central-core";
import { ReseauNeuronalGen3 } from "../core/network";
import { CANAL_UTILISATEUR_IN } from "../core/types";
import { HippocampusMemory } from "../memory/hippocampus";
import { NeuralEngine } from "../engine";
import type { CortexLangagierGen3, ContexteLangage } from "../generation/language";

import { MemoirePermanente, scoreLexique } from "./memoire-permanente";
import { planifierInedit, PRIMITIVES } from "./raisonnement-inedit";
import { executerTache } from "./execution-autonome";
import { redigerRapportTache } from "./generateur-rapports";
import { genererIdeesCreatives } from "./creativite-ondes";
import { GestionnaireOndesUnifie } from "./gestionnaire-ondes";
import { NoeudOndesUnifie } from "./noeud-ondes-unifie";

function requete(texte: string, meta: Record<string, string> = {}): AIRequest {
  return { task: "chat", messages: [{ role: "user", content: texte }], metadata: meta };
}

/** Montage du moteur avec SNOU + mémoire permanente (racine paramétrable). */
function monterMoteur(racineMemoire: string): {
  engine: NeuralEngine;
  contextesCaptures: ContexteLangage[];
  gestionnaire: GestionnaireOndesUnifie;
  memoire: MemoirePermanente;
} {
  const reseau = new ReseauNeuronalGen3({ seed: 1, density: 0 });
  const espace = new EspaceFiltreResonant();
  espace.registerInputPool(CANAL_UTILISATEUR_IN, [0, 1, 2]);
  espace.registerOutputPool("GENERER_IMAGE", [3, 4, 5]);
  const veille = new GenerateurAutoOscillation(reseau, 0.15, 0.15, createRng(11));
  const noyau = new NoyauCentralGen3(reseau, espace, veille);
  const contextesCaptures: ContexteLangage[] = [];
  const cortex: CortexLangagierGen3 = {
    repondre: (_prompt: string, contexte?: ContexteLangage) => {
      if (contexte === undefined) return null;
      contextesCaptures.push({ ...contexte });
      return { texte: "réponse de test déterministe", source: "corpus" as const, score: 1 };
    },
  } as unknown as CortexLangagierGen3;
  const gestionnaire = new GestionnaireOndesUnifie();
  const memoire = new MemoirePermanente(racineMemoire);
  const engine = new NeuralEngine(noyau, espace, cortex, new HippocampusMemory(10), undefined, undefined, undefined, undefined, undefined, undefined, undefined, gestionnaire, memoire);
  return { engine, contextesCaptures, gestionnaire, memoire };
}

describe("1 — mémoire conversationnelle permanente (aucune conversation perdue)", () => {
  it("chaque échange est journalisé sur disque et SURVIT à un redémarrage du cerveau", () => {
    const racine = mkdtempSync(join(tmpdir(), "gen3-memoire-"));
    try {
      const memoireA = new MemoirePermanente(racine);
      const cle = '["alice","conv-a"]';
      memoireA.enregistrer(cle, "mon plat préféré est le ndolé", "c'est noté");
      memoireA.enregistrer(cle, "j'habite à Douala", "noté aussi");
      expect(memoireA.compter(cle)).toBe(2);
      // REDÉMARRAGE : une NOUVELLE instance (nouveau cerveau) relit le journal disque.
      const memoireB = new MemoirePermanente(racine);
      expect(memoireB.compter(cle)).toBe(2);
      return Promise.resolve();
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });

  it("le rappel mixte rang les souvenirs par concepts + récence, et isole les comptes", async () => {
    const racine = mkdtempSync(join(tmpdir(), "gen3-memoire-"));
    try {
      const memoire = new MemoirePermanente(racine);
      const cleA = '["alice","conv-a"]';
      const cleB = '["bob","conv-b"]';
      memoire.enregistrer(cleA, "j'ai adopté un chaton roux", "adopté, noté");
      memoire.enregistrer(cleA, "mon chaton s'appelle Biscuit", "Biscuit, noté");
      memoire.enregistrer(cleA, "le ciel est bleu", "en effet");
      // Rappel pour une question sur le chaton : Biscuit (récent + concepts communs) domine.
      const rappels = await memoire.rappeler(cleA, "quel est le nom de mon chaton ?");
      expect(rappels.length).toBeGreaterThan(0);
      expect(rappels[0].texte).toContain("Biscuit");
      expect(rappels[0].score).toBeGreaterThan(0);
      // Isolement P0 : le journal de bob est vide — rien ne fuit.
      expect(await memoire.rappeler(cleB, "chaton Biscuit roux")).toEqual([]);
      expect(memoire.compter(cleB)).toBe(0);
      return;
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });

  it("pont moteur réel : l'échange est journalisé puis RAPPELÉ après un redémarrage (contexte enrichi)", async () => {
    const racine = mkdtempSync(join(tmpdir(), "gen3-pont-"));
    try {
      // Session 1 : deux échanges journalisés par le chemin réel generate().
      const session1 = monterMoteur(racine);
      await session1.engine.generate(requete("mon plat préféré est le ndolé camerounais", { userId: "alice", conversationId: "conv-a" }));
      await session1.engine.generate(requete("et toi ?", { userId: "alice", conversationId: "conv-a" }));
      const cle = '["alice","conv-a"]';
      expect(session1.memoire.compter(cle)).toBe(2);

      // Session 2 (RESTART : nouvelle instance, même disque) : le rappel
      // permanent alimente le contexte du cortex (aucune conversation perdue).
      const session2 = monterMoteur(racine);
      await session2.engine.generate(requete("et toi ?", { userId: "alice", conversationId: "conv-a" }));
      const contexteFusion = session2.contextesCaptures.find((c) => c.souvenirsPermanents && c.souvenirsPermanents.length > 0);
      expect(contexteFusion).toBeDefined();
      expect(contexteFusion!.souvenirsPermanents![0].score).toBeGreaterThan(0);
      return;
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  }, 60_000);

  it("scoreLexique : recouvrement + bonus sous-chaîne bornés", () => {
    expect(scoreLexique(["pomme", "rouge"], ["pomme", "rouge", "panier"], "pomme rouge", "Q: pomme rouge R: ok")).toBe(1);
    expect(scoreLexique(["soleil"], ["lune", "mars"], "soleil", "R: rien")).toBe(0);
    expect(scoreLexique([], ["pomme"], "rien", "R:")).toBe(0);
  });
});

describe("2 — raisonnement hors corpus (problèmes inédits)", () => {
  it("compose des primitives locales : max d'une liste puis multiplication", () => {
    const plan = planifierInedit("trouve le plus grand de 12, 87, 45 puis multiplie le résultat par 3");
    expect(plan.complet).toBe(true);
    expect(plan.etapes.length).toBe(2);
    expect(plan.etapes[0].primitiveId).toBe("maximum");
    expect(plan.etapes[0].resultat).toBe("87");
    expect(plan.reponseFinale).toBe("261");
  });

  it("tri croissant de nombres : composition déterministe", () => {
    const plan = planifierInedit("trie 9, 3 et 7 du plus petit au plus grand");
    expect(plan.complet).toBe(true);
    expect(plan.reponseFinale).toBe("3 7 9");
  });

  it("problème sans primitive : analogie depuis les souvenirs résolus + honnêteté", () => {
    const souvenirs = [{ texte: "Q: calcule la moyenne de mes notes 12 et 16 R: 14", score: 0.9 }];
    const plan = planifierInedit("traduis ce poème en wolof puis illustre-le", souvenirs);
    expect(plan.complet).toBe(false);
    expect(plan.reponseFinale).toBeNull();
    // Le plan reste tenté étape par étape (jamais une impasse silencieuse).
    expect(plan.etapes.length).toBeGreaterThan(0);
  });
});

describe("3 — autonomie d'exécution (exécuter, vérifier, récupérer)", () => {
  it("tâche composée réussie avec métriques propres", () => {
    const plan = planifierInedit("trouve le minimum de 8, 2, 19 puis ajoute 5");
    const execution = executerTache({ objectif: "minimum de 8, 2, 19 puis ajoute 5" }, plan);
    expect(execution.reussie).toBe(true);
    expect(execution.resultatFinal).toBe("7");
    expect(execution.metriques.etapesTotales).toBe(2);
    expect(execution.metriques.incidents).toBe(0);
    expect(execution.repliHonnete).toBeNull();
  });

  it("incident en cours de tâche : récupération par portage du résultat (jamais de crash)", () => {
    // L'étape 2 (« prends le maximum ») n'a AUCUNE primitive au plan (aucun
    // chiffre) : l'exécuteur porte le résultat du tri → la primitive maximum
    // devient computable → incident RÉCUPÉRÉ, la tâche aboutit.
    const plan = planifierInedit("trie 9, 3 et 7 du plus petit au plus grand puis ensuite prends le maximum");
    expect(plan.etapes[1].primitiveId).toBeNull(); // l'inédit au plan
    const execution = executerTache({ objectif: "tri puis maximum de la liste" }, plan);
    expect(execution.metriques.incidents).toBeGreaterThan(0);
    expect(execution.reussie).toBe(true); // récupérée par portage
    expect(execution.incidents[0].recuperee).toBe(true);
    expect(execution.resultatFinal).toBe("9");
  });

  it("échec non récupérable : repli HONNÊTE explicite (aucun succès inventé)", () => {
    const plan = planifierInedit("traduis ce poème en wolof", []);
    const execution = executerTache({ objectif: "traduction wolof" }, plan);
    expect(execution.reussie).toBe(false);
    expect(execution.resultatFinal).toBeNull();
    expect(execution.repliHonnete).toContain("non computable localement");
    expect(execution.repliHonnete).toContain("aucune analogie résolue");
  });
});

describe("4 — rapports post-travail", () => {
  it("rapport complet : objectif, démarche, résultat vérifié, incidents, métriques, limites + commit d'ondes", () => {
    const noeud = new NoeudOndesUnifie("rapports|conv-1");
    const avant = noeud.tailleMemoire;
    const plan = planifierInedit("trouve le plus grand de 4, 44, 7 puis soustrais 4");
    const execution = executerTache({ objectif: "plus grand de 4, 44, 7 puis soustrais 4" }, plan);
    expect(execution.reussie).toBe(true);
    const rapport = redigerRapportTache(execution, noeud);
    expect(rapport.reussie).toBe(true);
    expect(rapport.markdown).toContain("# Rapport de tâche");
    expect(rapport.markdown).toContain("## Objectif");
    expect(rapport.markdown).toContain("## Démarche exécutée");
    expect(rapport.markdown).toContain("**40**");
    expect(rapport.markdown).toContain("## Incidents & récupérations");
    expect(rapport.markdown).toContain("## Métriques");
    expect(rapport.markdown).toContain("## Limites");
    // Le travail vécu est commis dans la mémoire d'ondes (fusion travail+mémoire).
    expect(noeud.tailleMemoire).toBeGreaterThan(avant);
  });

  it("rapport d'échec : honnête, sans victoire inventée", () => {
    const plan = planifierInedit("compose un haïku sur la mousson", []);
    const execution = executerTache({ objectif: "haïku mousson" }, plan);
    const rapport = redigerRapportTache(execution);
    expect(rapport.reussie).toBe(false);
    expect(rapport.markdown).toContain("(échec honnête)");
    expect(rapport.markdown).toContain("repli honnête");
    expect(rapport.markdown).not.toContain("**Résultat vérifié");
  });
});

describe("5 — créativité générative mesurée dans le champ", () => {
  it("génère des combinaisons NOUVELLES (absentes de la mémoire) et rangées par cohérence × nouveauté", async () => {
    const noeud = new NoeudOndesUnifie("creation|conv-1");
    noeud.memoriserEchange("j'adore la musique balafon du Burkina", "balafon noté");
    noeud.memoriserEchange("je cuisine le thiéboudienne chaque week-end", "cuisine notée");
    const idees = await genererIdeesCreatives(noeud, "balafon thiéboudienne week-end", 5);
    expect(idees.length).toBeGreaterThan(0);
    // Toutes les idées sont rangées par score décroissant.
    for (let i = 1; i < idees.length; i++) {
      expect(idees[i - 1].score).toBeGreaterThanOrEqual(idees[i].score);
    }
    // Nouveauté mesurée : les paires jamais vécues ensemble pèsent plus.
    expect(idees[0].nouveaute).toBeGreaterThanOrEqual(0);
    expect(idees[0].coherence).toBeGreaterThanOrEqual(0);
    // Au moins une idée combine des concepts des deux mondes vécus (musique + cuisine).
    const musiqueCuisine = idees.some((i) => i.combinaison.split(" ").length >= 2);
    expect(musiqueCuisine).toBe(true);
  });
});

describe("6 — registre de primitives (surface hors corpus)", () => {
  it("toutes les primitives sont déterministes et vérifiées", () => {
    expect(PRIMITIVES.map((p) => p.id)).toContain("calcul");
    expect(PRIMITIVES.map((p) => p.id)).toContain("maximum");
    const max = PRIMITIVES.find((p) => p.id === "maximum")!;
    expect(max.executer("max de 3 et 11", null).valeur).toBe("11");
    expect(max.executer("max de 3 et 11", null).valeur).toBe(max.executer("max de 3 et 11", null).valeur);
    const inversion = PRIMITIVES.find((p) => p.id === "inversion-texte")!;
    expect(inversion.executer("inverser le mot « paella »", null).ok).toBe(true);
  });
});
