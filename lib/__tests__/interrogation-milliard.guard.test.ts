/**
 * GARDES it.86 — générateur d'interrogation milliard + cycle de correction.
 *
 * 1. la capacité totale de l'espace de questions est ≥ 1 milliard (demande
 *    propriétaire), calculée depuis les bornes exactes (aucun nombre
 *    magique) ;
 * 2. le décodage est injectif : zéro doublon de prompt sur des dizaines de
 *    milliers d'indices dispersés ;
 * 3. le décodage est déterministe : même index → même question ;
 * 4. chaque famille est atteignable et produit des questions bien formées
 *    (prompt, pensée, réponse, extraits vérifiables non vides, zéro
 *    parasite « undefined »/« nan ») ;
 * 5. le vérificateur classe correctement : exact / methode / echec ;
 * 6. LA CORRECTION RÉPARE RÉELLEMENT : sur le cortex langagier réel (le
 *    même que le chat), une question jamais apprise reçoit d'abord
 *    « methode »/« echec », la paire corrective est apprise en mémoire,
 *    puis la même question obtient « exact » (taux de réparation mesuré) ;
 * 7. le balayage stratifié couvre TOUTES les familles.
 */

import { describe, expect, it } from "vitest";

import {
  CAPACITE_MIN_MILLIARD,
  FAMILLES_MILLIARD,
  N_TOTAL_MILLIARD,
  bornesParFamille,
  capaciteParFamille,
  capaciteTotale,
  genererQuestionMilliard,
  indexDuBalayage,
  paireCorrective,
  planifierBalayage,
  questionStratifiee,
  verifierReponseGen3,
  type QuestionMilliard,
} from "../gen3/interrogation-milliard";
import { CORPUS_GEN3 } from "../neural/generation/corpus";
import { CortexLangagierGen3 } from "../neural/generation/language";
import { detecterMethodeRaisonnement } from "../gen3/familles-methodes";

describe("Capacité de l'espace d'interrogation", () => {
  it("la capacité totale est d'au moins 1 milliard de questions", () => {
    const total = capaciteTotale();
    expect(total).toBeGreaterThanOrEqual(CAPACITE_MIN_MILLIARD);
  });

  it("les bornes par famille sont contiguës et couvrent exactement l'espace", () => {
    const bornes = bornesParFamille();
    const caps = capaciteParFamille();
    let attendu = 0;
    for (const f of FAMILLES_MILLIARD) {
      const [debut, fin] = bornes[f];
      expect(debut).toBe(attendu);
      expect(fin - debut).toBe(caps[f]);
      attendu = fin;
    }
    expect(attendu).toBe(capaciteTotale());
  });

  it("la famille math_verbal domine le volume (le milliard y est principalement)", () => {
    const caps = capaciteParFamille();
    expect(caps.math_verbal).toBeGreaterThan(CAPACITE_MIN_MILLIARD / 2);
  });
});

describe("Décodage déterministe et injectif", () => {
  it("même index → même question (déterminisme)", () => {
    for (const n of [0, 1, 123_456, 9_876_543, 45_678_912]) {
      const a = genererQuestionMilliard(n);
      const b = genererQuestionMilliard(n);
      expect(a.prompt).toBe(b.prompt);
      expect(a.reponse).toBe(b.reponse);
      expect(a.famille).toBe(b.famille);
    }
  });

  it("zéro doublon de prompt sur 40 000 indices dispersés (balayage stratifié)", () => {
    const N = 40_000;
    const vus = new Set<string>();
    for (let j = 0; j < N; j++) {
      const q = questionStratifiee(j, N);
      expect(vus.has(q.prompt)).toBe(false);
      vus.add(q.prompt);
    }
    expect(vus.size).toBe(N);
  });

  it("zéro doublon sur un échantillon aléatoire seedé (40 000 indices)", () => {
    let seed = 20261103;
    const suivant = (): number => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed;
    };
    const cap = capaciteTotale();
    const vus = new Set<string>();
    for (let i = 0; i < 40_000; i++) {
      const n = Math.floor((suivant() / 0x1_0000_0000) * cap);
      const q = genererQuestionMilliard(n);
      expect(vus.has(q.prompt)).toBe(false);
      vus.add(q.prompt);
    }
  });
});

describe("Questions bien formées, toutes familles", () => {
  it("chaque famille est atteignable et produit des questions complètes, sans parasite", () => {
    const bornes = bornesParFamille();
    const atteintes = new Set<string>();
    const PARASITES = ["undefined", "nan", "todo", "xxx"];
    for (const f of FAMILLES_MILLIARD) {
      const [debut, fin] = bornes[f];
      const pas = Math.max(1, Math.floor((fin - debut) / 60));
      for (let n = debut; n < fin; n += pas) {
        const q = genererQuestionMilliard(n);
        atteintes.add(q.famille);
        expect(q.prompt.length).toBeGreaterThan(10);
        expect(q.pensee.length).toBeGreaterThan(10);
        expect(q.reponse.length).toBeGreaterThan(3);
        expect(q.extraitsVerifiables.length).toBeGreaterThan(0);
        for (const ex of q.extraitsVerifiables) {
          expect(ex.length).toBeGreaterThan(0);
          expect(ex.toLowerCase()).not.toContain("undefined");
        }
        const bas = `${q.prompt} ${q.reponse}`.toLowerCase();
        for (const p of PARASITES) {
          // « nan » n'est un parasite que si MOT ENTIER (leçon it.85 :
          // « maintenant » contient « nan » — faux positif interdit)
          if (p === "nan") {
            expect(new RegExp("\\bnan\\b").test(bas)).toBe(false);
          } else {
            expect(bas.includes(p)).toBe(false);
          }
        }
      }
    }
    expect(atteintes.size).toBe(FAMILLES_MILLIARD.length);
  });
});

describe("Vérificateur de réponses", () => {
  const q: QuestionMilliard = genererQuestionMilliard(1_000_000);

  it("une réponse contenant le résultat exact est classée « exact »", () => {
    expect(verifierReponseGen3(q, `1) … Donc : le total est de ${q.extraitsVerifiables[0]}.`, null)).toBe("exact");
  });

  it("une réponse hors-sujet sans méthode est classée « echec »", () => {
    expect(verifierReponseGen3(q, "Art et création multimédia : images, vidéos, sons.", null)).toBe("echec");
  });

  it("une réponse de la bonne famille sans le résultat est classée « methode »", () => {
    expect(verifierReponseGen3(q, null, q.famille)).toBe("methode");
  });

  it("une réponse vide est au mieux « methode » si la famille est bonne, sinon « echec »", () => {
    expect(verifierReponseGen3(q, null, null)).toBe("echec");
  });
});

describe("Le cycle de correction répare RÉELLEMENT la mémoire", () => {
  it("question inconnue → methode/echec → paire corrective apprise → exact (taux mesuré)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    const N = 200;
    const questions: QuestionMilliard[] = [];
    for (let j = 0; j < N; j++) questions.push(questionStratifiee(j, N));
    // PASSE A : interrogation du savoir initial
    const avant: Array<{ q: QuestionMilliard; verdict: string }> = questions.map((q) => {
      const rep = cortex.repondre(q.prompt);
      const det = detecterMethodeRaisonnement(q.prompt);
      return { q, verdict: verifierReponseGen3(q, rep?.texte ?? null, det?.famille ?? null) };
    });
    const echecs = avant.filter((x) => x.verdict !== "exact");
    expect(echecs.length).toBeGreaterThan(0); // il y a forcément des questions jamais apprises
    // PASSE B : correction mémoire (paires correctives apprises une à une)
    for (const e of echecs) {
      cortex.apprendre([paireCorrective(e.q)], { personnalisees: false });
    }
    // PASSE C : re-test de réparation (toutes les corrigées)
    let reparees = 0;
    for (const e of echecs) {
      const rep = cortex.repondre(e.q.prompt);
      const det = detecterMethodeRaisonnement(e.q.prompt);
      const verdict = verifierReponseGen3(e.q, rep?.texte ?? null, det?.famille ?? null);
      if (verdict === "exact") reparees += 1;
    }
    const taux = reparees / echecs.length;
    expect(taux).toBeGreaterThan(0.9); // la correction mémoire répare (bonus de motif exact)
  });

  it("la première question du balayage est mesurée puis réparée par la correction", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    const q = questionStratifiee(0, 1_000);
    const rep = cortex.repondre(q.prompt);
    const det = detecterMethodeRaisonnement(q.prompt);
    const verdictAvant = verifierReponseGen3(q, rep?.texte ?? null, det?.famille ?? null);
    expect(["exact", "methode", "echec"]).toContain(verdictAvant); // mesure honnête
    if (verdictAvant !== "exact") {
      cortex.apprendre([paireCorrective(q)], { personnalisees: false });
      const repApres = cortex.repondre(q.prompt);
      const verdictApres = verifierReponseGen3(q, repApres?.texte ?? null, det?.famille ?? null);
      expect(verdictApres).toBe("exact");
    }
  });
});

describe("Balayages (systématique et stratifié)", () => {
  it("les indices du balayage systématique sont strictement croissants et bornés", () => {
    const N = 100_000;
    let precedent = -1;
    for (let j = 0; j < N; j += 7) {
      const idx = indexDuBalayage(j, N);
      expect(idx).toBeGreaterThan(precedent);
      expect(idx).toBeLessThan(capaciteTotale());
      precedent = idx;
    }
  });

  it("l'ordre total du balayage est exactement le milliard demandé", () => {
    expect(N_TOTAL_MILLIARD).toBe(1_000_000_000);
  });

  it("un balayage stratifié du milliard touche les 8 familles", () => {
    const N = N_TOTAL_MILLIARD;
    const plan = planifierBalayage(N);
    const somme = Object.values(plan).reduce((a, b) => a + b, 0);
    expect(somme).toBe(N);
    // chaque famille est vérifiée AU SEIN de son propre bloc du balayage
    let acc = 0;
    for (const f of FAMILLES_MILLIARD) {
      const nf = plan[f];
      expect(questionStratifiee(acc, N).famille).toBe(f); // tête de bloc
      if (nf > 1) {
        expect(questionStratifiee(acc + nf - 1, N).famille).toBe(f); // fin de bloc
      }
      acc += nf;
    }
    expect(acc).toBe(N);
    expect(questionStratifiee(N - 1, N).famille).toBe(
      FAMILLES_MILLIARD[FAMILLES_MILLIARD.length - 1],
    );
  });
});
