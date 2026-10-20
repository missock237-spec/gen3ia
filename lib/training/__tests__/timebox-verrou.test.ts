import { beforeEach, describe, expect, it } from "vitest";

import {
  bornerBudgetMs,
  creerDeadline,
  DUREE_MAX_ENTRAINEMENT_MS,
  statutTimebox,
} from "@/lib/training/timebox";
import {
  acquerirVerrou,
  cleVerrouEntrainement,
  libererVerrou,
  reinitialiserVerrous,
  TTL_VERROU_DEFAUT,
  verrouTenu,
} from "@/lib/training/verrou";
import { EntrainementParResonance } from "@/lib/ondes/arene";
import { CortexLangagierGen3 } from "@/lib/neural/generation/language";

/* ------------------------------------------------------------------ */
/* TIMEBOX — la garantie « un entraînement ne dépasse jamais 30 min par  */
/* modèle, par session » est testée au niveau PHYSIQUE (la boucle).       */
/* ------------------------------------------------------------------ */

describe("timebox", () => {
  it("la constante produit est exactement trente minutes", () => {
    expect(DUREE_MAX_ENTRAINEMENT_MS).toBe(1_800_000);
    expect(TTL_VERROU_DEFAUT).toBe(DUREE_MAX_ENTRAINEMENT_MS + 5 * 60 * 1000);
  });

  it("creerDeadline borne le budget à 30 min, sans dépassable", () => {
    const debut = 1_000_000;
    const { deadlineMs, budgetMs } = creerDeadline(debut);
    expect(budgetMs).toBe(DUREE_MAX_ENTRAINEMENT_MS);
    expect(deadlineMs).toBe(debut + DUREE_MAX_ENTRAINEMENT_MS);
  });

  it("statutTimebox décrit honnêtement le temps restant et le dépassement", () => {
    const debut = 0;
    const { deadlineMs } = creerDeadline(debut);
    const milieu = statutTimebox(deadlineMs, () => 900_000);
    expect(milieu.depasse).toBe(false);
    expect(milieu.resteMs).toBe(900_000);
    const passe = statutTimebox(deadlineMs, () => DUREE_MAX_ENTRAINEMENT_MS + 1);
    expect(passe.depasse).toBe(true);
    expect(passe.resteMs).toBeLessThanOrEqual(0);
  });

  it("bornerBudgetMs plafonne TOUTE demande à 30 min (même tricheur)", () => {
    expect(bornerBudgetMs(999_999_999)).toBe(DUREE_MAX_ENTRAINEMENT_MS);
    expect(bornerBudgetMs(5_000)).toBe(5_000);
    expect(bornerBudgetMs(10)).toBe(1_000); // plancher de sécurité
    expect(bornerBudgetMs(undefined)).toBe(DUREE_MAX_ENTRAINEMENT_MS);
    expect(bornerBudgetMs(Number.NaN)).toBe(DUREE_MAX_ENTRAINEMENT_MS);
  });
});

describe("verrou d'entraînement", () => {
  beforeEach(() => reinitialiserVerrous());

  it("un seul entraînement à la fois par modèle : le second est refusé (409)", () => {
    const cle = cleVerrouEntrainement("u1", "p1", "a1");
    const premier = acquerirVerrou(cle, "u1");
    expect(premier.acquis).toBe(true);

    const second = acquerirVerrou(cle, "u1");
    expect(second.acquis).toBe(false);
    if (!second.acquis) {
      expect(second.par).toBe("u1");
      expect(second.resteMs).toBeGreaterThan(0);
    }
  });

  it("des modèles distincts s'entraînent en parallèle (pas de faux conflit)", () => {
    expect(acquerirVerrou(cleVerrouEntrainement("u1", "p1", "a1"), "u1").acquis).toBe(true);
    expect(acquerirVerrou(cleVerrouEntrainement("u1", "p1", "a2"), "u1").acquis).toBe(true);
    expect(acquerirVerrou(cleVerrouEntrainement("u2", "p1", "a1"), "u2").acquis).toBe(true);
  });

  it("le verrou expire seul (TTL) : jamais de modèle bloqué à vie", () => {
    const cle = cleVerrouEntrainement("u1", "p1", "a1");
    let maintenant = 0;
    const horloge = () => maintenant;
    acquerirVerrou(cle, "u1", 10_000, horloge);
    expect(verrouTenu(cle, horloge)).toBe(true);
    maintenant = 10_001;
    expect(verrouTenu(cle, horloge)).toBe(false);
    expect(acquerirVerrou(cle, "u1", 10_000, horloge).acquis).toBe(true);
  });

  it("seul le propriétaire libère le verrou (anti-vol)", () => {
    const cle = cleVerrouEntrainement("u1", "p1", "a1");
    acquerirVerrou(cle, "u1");
    libererVerrou(cle, "attaquant");
    expect(verrouTenu(cle)).toBe(true);
    libererVerrou(cle, "u1");
    expect(verrouTenu(cle)).toBe(false);
  });
});

describe("timebox au niveau physique — EntrainementParResonance.entrainer", () => {
  const prof = new CortexLangagierGen3();
  prof.apprendre([
    { motif: "Quelle couleur le champ préfère-t-il ?", reponse: "Le violet des ondes constructives.", theme: "test" },
    { motif: "Qui juge une idée dans l'arène ?", reponse: "La physique, par interférence.", theme: "test" },
  ]);
  const eleve = new CortexLangagierGen3();
  eleve.apprendre([
    { motif: "Quelle couleur le champ préfère-t-il ?", reponse: "Je ne sais pas.", theme: "test" },
    { motif: "Qui juge une idée dans l'arène ?", reponse: "Je ne sais pas.", theme: "test" },
  ]);

  it("sans deadline : la session va au bout (arreteParTimebox = false)", () => {
    const session = new EntrainementParResonance(prof, eleve);
    const rapport = session.entrainer(["a", "b", "c"]);
    expect(rapport.arreteParTimebox).toBe(false);
    expect(rapport.rounds.length).toBe(3);
  });

  it("avec une deadline déjà passée : arrêt PROPRE, zéro round, état cohérent", () => {
    const session = new EntrainementParResonance(prof, eleve);
    const rapport = session.entrainer(["a", "b", "c"], { deadlineMs: 0 });
    expect(rapport.arreteParTimebox).toBe(true);
    expect(rapport.rounds.length).toBe(0);
    expect(rapport.etatEleve).toBeDefined();
  });

  it("l'horloge est vérifiée ENTRE les rounds : l'arrêt est propre, jamais en pleine distillation", () => {
    const session = new EntrainementParResonance(prof, eleve);
    const motifs = ["a", "b", "c", "d", "e"];
    // L'horloge passe la deadline au 3e appel : les deux premiers rounds
    // se jouent, le 3e est refusé — jamais de round tronqué.
    let appels = 0;
    const horloge = () => (appels++ < 2 ? 0 : DUREE_MAX_ENTRAINEMENT_MS + 1);
    const deadline = DUREE_MAX_ENTRAINEMENT_MS;
    const rapport = session.entrainer(motifs, { deadlineMs: deadline, maintenant: horloge });
    expect(rapport.arreteParTimebox).toBe(true);
    expect(rapport.rounds.length).toBe(2);
    expect(rapport.rounds.every((r) => typeof r.motif === "string" && r.motif.length > 0)).toBe(true);
  });
});
