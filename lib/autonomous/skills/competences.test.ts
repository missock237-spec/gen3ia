/**
 * TESTS DES LOTS 6-8 — Skills, Continual Learning (garde anti-oubli),
 * Anti-Hallucination (mission « GEN3IA AUTONOMOUS BRAIN »).
 *
 * Règle 12 : compétences validées UNIQUEMENT par des tests pratiques en
 * environnement isolé (un test utilise la VRAIE sandbox du dépôt —
 * processus enfant réel, sans réseau). Règle 14 : tout oubli catastrophique
 * mesuré déclenche un rollback vérifié. Règle 18 : rien n'est déclaré
 * opérationnel sans test démontrable.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MemoireConnaissances } from "../knowledge/memoire-connaissances";
import {
  RegistreCompetences,
  contientContenuCode,
  developperCompetences,
  extraireImplementation,
  executerSandboxProduction,
  genererExercices,
} from "./moteur-competences";
import {
  SEUIL_DEGRADATION,
  adapterSansOubli,
  fusionnerRelations,
  lotApprentissageContinu,
} from "../continual-learning/moteur-continu";
import { verifierReponse } from "../anti-hallucination/verificateur-reponses";
import type { Connaissance } from "../knowledge/memoire-connaissances";
import type { Sonde, SousMoteurNeural } from "../continual-learning/moteur-continu";

let dossier: string;
let memoire: MemoireConnaissances;
let registre: RegistreCompetences;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "autobrain-b-"));
  memoire = new MemoireConnaissances(dossier);
  registre = new RegistreCompetences(dossier);
});
afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});

/** Connaissance de test avec du contenu praticable (code JS). */
function connCode(id: string, code: string): Connaissance {
  return {
    idConcept: id,
    concept: "fonction de salutation",
    domaine: "developpement_web",
    proprietes: [{ cle: "exemple", valeur: code }],
    relations: [{ relation: "permet", cible: "saluer un utilisateur" }],
    resume: `Une fonction de salutation.\n\n${code}`,
    langue: "fr",
    qualite: 0.8,
    provenance: { lotId: `lot-${id}`, sourceId: "wikipedia-fr", url: "u", collecteLe: new Date().toISOString() },
    contentType: "application/json",
    statut: "pending_validation",
  };
}

/** Connaissance de test sans code (texte pur). */
function connTexte(id: string, domaine = "sciences_professionnel"): Connaissance {
  return {
    idConcept: id,
    concept: "Le Soleil chauffe la Terre",
    domaine,
    proprietes: [{ cle: "rayonnement", valeur: "La Terre reçoit de la chaleur du Soleil par rayonnement" }],
    relations: [{ relation: "est", cible: "une étoile" }],
    resume: "Le Soleil chauffe la Terre par rayonnement et alimente le climat de la planète.",
    langue: "fr",
    qualite: 0.8,
    provenance: { lotId: `lot-${id}`, sourceId: "wikipedia-fr", url: "u", collecteLe: new Date().toISOString() },
    contentType: "application/json",
    statut: "pending_validation",
  };
}

/** Intègre une connaissance directement (comme le ferait le pipeline APPROVED). */
function integrer(conn: Connaissance): void {
  memoire.integrer(conn, 1);
}

describe("Lot 6 — Détection de contenu praticable (honnêteté)", () => {
  it("code présent → détecté, texte pur → non praticable", () => {
    expect(contientContenuCode(connCode("c1", "```js\nfunction saluer(nom) { return \"Bonjour \" + nom; }\n```"))).toBe(true);
    expect(contientContenuCode(connTexte("c2"))).toBe(false);
  });

  it("extraction d'implémentation : bloc ```js prioritaire", () => {
    const impl = extraireImplementation(connCode("c3", "```js\nfunction saluer(nom) { return \"Bonjour \" + nom; }\n```"));
    expect(impl).toContain("function saluer");
  });

  it("connaissance sans code → AUCUN exercice généré (jamais de faux exercice)", () => {
    expect(genererExercices(connTexte("c4"))).toEqual([]);
  });
});

describe("Lot 6 — Développement de compétences (validation par tests pratiques)", () => {
  it("connaissance sans contenu praticable → compétence IDENTIFIÉE (en étude, non opérationnelle)", async () => {
    integrer(connTexte("t1"));
    const r = await developperCompetences({
      registre,
      memoire,
      executeur: async () => ({ ok: true, message: "ne devrait pas être appelé", dureeMs: 0 }),
    });
    expect(r.identifiees).toBe(1);
    expect(r.validees).toBe(0);
    const comp = registre.toutes()[0];
    expect(comp.statut).toBe("identifiee");
    expect(comp.analyseErreurs[0]).toContain("en étude, non opérationnelle");
    expect(registre.validees()).toHaveLength(0); // rien n'est prétendu
  });

  it("exercices tous verts → compétence VALIDÉE (traçable)", async () => {
    integrer(connCode("v1", "```js\nfunction saluer(nom) { return \"Bonjour \" + nom; }\n```"));
    const r = await developperCompetences({
      registre,
      memoire,
      executeur: async () => ({ ok: true, message: "test vert", dureeMs: 5 }),
    });
    expect(r.validees).toBe(1);
    const comp = registre.validees()[0];
    expect(comp.statut).toBe("validee");
    expect(comp.valideLe).toBeTruthy();
    expect(comp.exercices[0].resultat?.ok).toBe(true);
    expect(comp.baseConnaissances).toEqual(["v1"]); // provenance de la compétence
  });

  it("exercice en échec → compétence en ÉCHEC avec analyse d'erreurs honnête", async () => {
    integrer(connCode("e1", "```js\nfunction cassee() { throw new Error(\"boom\"); }\n```"));
    const r = await developperCompetences({
      registre,
      memoire,
      executeur: async () => ({ ok: false, message: "erreur d'exécution : boom", dureeMs: 3 }),
    });
    expect(r.echecs).toBe(1);
    expect(r.validees).toBe(0);
    const comp = registre.toutes()[0];
    expect(comp.statut).toBe("echec");
    expect(comp.analyseErreurs[0]).toContain("boom");
    expect(registre.validees()).toHaveLength(0);
  });

  it("maxParAppel respecté (bornes de ressources)", async () => {
    integrer(connTexte("b1", "developpement_web"));
    integrer(connTexte("b2", "developpement_web"));
    integrer(connTexte("b3", "developpement_web"));
    integrer(connTexte("b4", "developpement_web"));
    const r = await developperCompetences({
      registre,
      memoire,
      executeur: async () => ({ ok: true, message: "x", dureeMs: 1 }),
      maxParAppel: 2,
    });
    expect(r.identifiees).toBe(2); // plafond honnête
  });

  it("registre persisté et relisible au boot", async () => {
    integrer(connTexte("p1"));
    await developperCompetences({ registre, memoire, executeur: async () => ({ ok: true, message: "x", dureeMs: 1 }) });
    expect(existsSync(join(dossier, "competences", "competences.json"))).toBe(true);
    const registre2 = new RegistreCompetences(dossier);
    expect(registre2.toutes()).toHaveLength(1);
    expect(registre2.toutes()[0].statut).toBe("identifiee");
  });

  it("TEST PRATIQUE RÉEL : la sandbox du dépôt exécute l'implémentation (processus enfant isolé)", async () => {
    integrer(connCode("r1", "```js\nfunction saluer(nom) { return \"Bonjour \" + nom; }\nexports.repondre = saluer;\n```"));
    const exercices = genererExercices(memoire.obtenir("r1")!);
    const impl = extraireImplementation(memoire.obtenir("r1")!);
    expect(exercices.length).toBe(1);
    const executeur = executerSandboxProduction();
    const rVert = await executeur(exercices[0].script, { implementationJs: impl });
    expect(rVert.ok).toBe(true); // la VRAIE sandbox valide la vraie implémentation

    const rRouge = await executeur(exercices[0].script, { implementationJs: "function saluer() { throw new Error('cassée'); }\nexports.repondre = saluer;" });
    expect(rRouge.ok).toBe(false); // et rejette honnêtement l'implémentation cassée
    expect(rRouge.message).toContain("cassée");
  }, 60_000);
});

/** Sous-moteur neuronal factice contrôlable (pré/post mesurés réellement). */
function sousMoteurFactice(scoresPre: number, scoresPost: number, adapterOk = true) {
  const jetons: string[] = [];
  let restaures = 0;
  const moteur: SousMoteurNeural = {
    async evaluer() {
      return jetons.length === 0 ? scoresPre : scoresPost;
    },
    async adapter() {
      return adapterOk ? { ok: true, message: "adaptation bornée simulée" } : { ok: false, message: "échec simulé" };
    },
    async sauvegarder() {
      const token = `etat-${jetons.length}`;
      jetons.push(token);
      return token;
    },
    async restaurer(token) {
      if (!jetons.includes(token)) return false;
      restaures += 1;
      return true;
    },
  };
  return { moteur, jetons: () => jetons, compterRestaurations: () => restaures };
}

const sondes: Sonde[] = [
  { question: "Que sais-tu du Soleil ?", attendu: "étoile rayonnement" },
  { question: "Que sais-tu du routing ?", attendu: "lexical domaines" },
];

describe("Lot 7 — Continual Learning (garde anti-oubli catastrophique)", () => {
  it("amélioration mesurée → adaptation APPLIQUÉE avec Δ réel", async () => {
    const sm = sousMoteurFactice(0.6, 0.75);
    const r = await adapterSansOubli(sm.moteur, [{ question: "q", reponse: "r" }], sondes);
    expect(r.statut).toBe("applique");
    expect(r.scorePre).toBe(0.6);
    expect(r.scorePost).toBe(0.75);
    expect(r.delta).toBeCloseTo(0.15);
    expect(r.rollbackEffectue).toBe(false);
  });

  it("oubli catastrophique → adaptation ANNULÉE + état restauré (Règle 14)", async () => {
    const sm = sousMoteurFactice(0.8, 0.5); // dégradation −0.3 << −0.02
    const r = await adapterSansOubli(sm.moteur, [{ question: "q", reponse: "r" }], sondes);
    expect(r.statut).toBe("annule");
    expect(r.message).toContain("oubli catastrophique");
    expect(sm.compterRestaurations()).toBe(1); // rollback VÉRIFIÉ
    expect(r.rollbackEffectue).toBe(true);
  });

  it("dégradation sous le seuil → annulée aussi (seuil strict)", async () => {
    const sm = sousMoteurFactice(0.6, 0.6 - SEUIL_DEGRADATION - 0.001);
    const r = await adapterSansOubli(sm.moteur, [], sondes);
    expect(r.statut).toBe("annule");
  });

  it("échec d'adaptation → état restauré + rapport honnête", async () => {
    const sm = sousMoteurFactice(0.7, 0.7, false);
    const r = await adapterSansOubli(sm.moteur, [{ question: "q", reponse: "r" }], sondes);
    expect(r.statut).toBe("echec");
    expect(r.message).toContain("état restauré");
    expect(sm.compterRestaurations()).toBe(1);
  });

  it("score pré invalide → adaptation refusée sans toucher à l'état", async () => {
    const sm = sousMoteurFactice(NaN, NaN);
    const r = await adapterSansOubli(sm.moteur, [{ question: "q", reponse: "r" }], sondes);
    expect(r.statut).toBe("echec");
    expect(sm.jetons().length).toBe(0); // aucune sauvegarde/adaptation
  });

  it("mécanisme B — fusion des relations : dédupliquée + persistée", () => {
    integrer(connTexte("f1"));
    const memoire2 = new MemoireConnaissances(dossier); // recharger l'état
    const n = fusionnerRelations(memoire2, [
      {
        idConcept: "f1",
        relations: [
          { relation: "est", cible: "une étoile" }, // déjà présente → pas de doublon
          { relation: "chauffe", cible: "la Terre" }, // nouvelle
        ],
        provenanceId: "lot-nouveau",
      },
    ]);
    expect(n).toBe(1);
    const c = memoire2.obtenir("f1")!;
    expect(c.relations).toHaveLength(2);
    expect(c.relations.find((r) => r.relation === "chauffe")!.provenanceId).toBe("lot-nouveau");
    // Relecture disque : la fusion est persistée.
    const memoire3 = new MemoireConnaissances(dossier);
    expect(memoire3.obtenir("f1")!.relations).toHaveLength(2);
  });

  it("lot complet A+B+C : sondes dérivées de la mémoire + adaptation gardée", async () => {
    integrer(connTexte("l1"));
    const sm = sousMoteurFactice(0.5, 0.6);
    const r = await lotApprentissageContinu({
      memoire,
      sousMoteur: sm.moteur,
      echantillonsNeuronaux: [{ question: "Le Soleil ?", reponse: "étoile" }],
    });
    expect(r.sondes).toBeGreaterThan(0); // mécanisme A : sondes dérivées
    expect(r.adaptation?.statut).toBe("applique"); // mécanisme C gardé
    expect(r.relationsFusionnees).toBe(0);
  });

  it("aucun échantillon → pas d'adaptation neuronale (rien d'inventé)", async () => {
    const sm = sousMoteurFactice(0.5, 0.5);
    const r = await lotApprentissageContinu({ memoire, sousMoteur: sm.moteur, echantillonsNeuronaux: [] });
    expect(r.adaptation).toBeNull();
  });
});

describe("Lot 8 — Anti-Hallucination (fondée sur des connaissances vérifiables)", () => {
  beforeEach(() => {
    integrer(connTexte("s1"));
    // Enrichit le résumé pour un appariement lexical clair.
    const c = memoire.obtenir("s1")!;
    c.resume =
      "Le Soleil chauffe la Terre par rayonnement solaire. La Terre reçoit de la chaleur du Soleil. " +
      "Le rayonnement alimente le climat et la photosynthèse de la planète.";
    memoire.persisterConnaissance("s1");
  });

  it("affirmation couverte par la mémoire → SOUTENU avec provenance tracée", () => {
    const rapport = verifierReponse(
      "Le Soleil chauffe la Terre par rayonnement solaire. Le rayonnement alimente le climat de la planète.",
      memoire,
    );
    expect(rapport.verdict).toBe("FONDÉE");
    const soutenus = rapport.affirmations.filter((a) => a.verdict === "SOUTENU");
    expect(soutenus.length).toBeGreaterThanOrEqual(1);
    expect(soutenus[0].sources[0].sourceId).toBe("wikipedia-fr"); // provenance
    expect(soutenus[0].sources[0].concept).toBeTruthy();
  });

  it("affirmation hors mémoire → NON_VERIFIÉ (jamais transformé en vérité)", () => {
    const rapport = verifierReponse(
      "Le Soleil est composé principalement de cristal de diamant liquide en rotation lente permanente.",
      memoire,
    );
    const nonVerifies = rapport.affirmations.filter((a) => a.verdict === "NON_VERIFIE");
    expect(nonVerifies.length).toBeGreaterThanOrEqual(1);
    expect(rapport.incertitudes.length).toBeGreaterThanOrEqual(1);
    expect(rapport.verdict).not.toBe("FONDÉE");
  });

  it("contradiction flaggée en mémoire → CONTREDIT (les deux versions exposées)", () => {
    // Ajoute une contradiction sur la connaissance s1.
    const c = memoire.obtenir("s1")!;
    c.contradictions.push({ cle: "distance", valeurs: ["8 minutes", "9 minutes"], provenanceIds: ["lot-a", "lot-b"] });
    memoire.persisterConnaissance("s1");
    const rapport = verifierReponse(
      "La distance du Soleil à la Terre varie selon le rayonnement solaire et le climat de la planète.",
      memoire,
    );
    expect(rapport.affirmations.some((a) => a.verdict === "CONTREDIT")).toBe(true);
    expect(rapport.verdict).toBe("NON_FONDÉE");
    expect(rapport.affirmations.find((a) => a.verdict === "CONTREDIT")!.explication).toContain("les deux");
  });

  it("taux de soutien mesuré (aucune invention)", () => {
    const rapport = verifierReponse(
      "Le Soleil chauffe la Terre par rayonnement solaire depuis des milliards d'années.",
      memoire,
    );
    expect(rapport.tauxSoutien).toBeGreaterThanOrEqual(0);
    expect(rapport.tauxSoutien).toBeLessThanOrEqual(1);
    expect(rapport.tauxSoutien).toBeCloseTo(rapport.affirmations.filter((a) => a.verdict === "SOUTENU").length / rapport.affirmations.length);
  });
});

describe("Persistance disque du registre des compétences", () => {
  it("structure var/autonomous/competences complète", async () => {
    integrer(connTexte("z1", "developpement_web"));
    await developperCompetences({ registre, memoire, executeur: async () => ({ ok: true, message: "x", dureeMs: 1 }) });
    const brut = JSON.parse(readFileSync(join(dossier, "competences", "competences.json"), "utf8")) as {
      competences: Array<{ statut: string; baseConnaissances: string[] }>;
    };
    expect(brut.competences).toHaveLength(1);
    expect(brut.competences[0].baseConnaissances).toEqual(["z1"]);
  });
});
