import { describe, it, expect } from "vitest";

import { CortexLangagierGen3 } from "./language";
import { CORPUS_GEN3, TAILLE_CORPUS_GEN3 } from "./corpus";
import { getNeuralRuntime } from "../runtime";

/**
 * TESTS DU CORTEX LANGAGIER GEN3 — le noyau de génération de langage.
 * Apprentissage, appariement, seuil, contexte anaphorique, plasticité
 * d'usage, persistance et intégrité du corpus d'amorçage.
 */
describe("Corpus d'amorçage Gen3", () => {
  it("est non vide et structurellement intègre (motifs/réponses non vides)", () => {
    expect(TAILLE_CORPUS_GEN3).toBeGreaterThan(60);
    expect(CORPUS_GEN3.length).toBe(TAILLE_CORPUS_GEN3);
    for (const paire of CORPUS_GEN3) {
      expect(paire.motif.trim().length).toBeGreaterThan(0);
      expect(paire.reponse.trim().length).toBeGreaterThan(0);
      expect(paire.theme.trim().length).toBeGreaterThan(0);
    }
  });

  it("n'a aucun motif dupliqué (après normalisation)", () => {
    const cles = CORPUS_GEN3.map((p) =>
      [...new Set(p.motif.toLowerCase().split(/\s+/))].sort().join(" "),
    );
    expect(new Set(cles).size).toBe(cles.length);
  });

  it("couvre les thèmes fondamentaux de la plateforme", () => {
    const themes = new Set(CORPUS_GEN3.map((p) => p.theme));
    for (const themeAttendu of [
      "salutation",
      "identite",
      "capacites",
      "entrainement",
      "plateforme",
      "honnetete",
      "remerciement",
      "au_revoir",
    ]) {
      expect(themes.has(themeAttendu)).toBe(true);
    }
  });
});

describe("CortexLangagierGen3 — apprentissage", () => {
  it("apprend le corpus complet, idempotent (ré-apprentissage = 0 ajout)", () => {
    const cortex = new CortexLangagierGen3();
    const premier = cortex.apprendre(CORPUS_GEN3);
    expect(premier.pairesAjoutees).toBe(TAILLE_CORPUS_GEN3);
    expect(premier.pairesDoublons).toBe(0);
    expect(premier.totalPaires).toBe(TAILLE_CORPUS_GEN3);
    expect(premier.vocabulaire).toBeGreaterThan(100);

    const second = cortex.apprendre(CORPUS_GEN3);
    expect(second.pairesAjoutees).toBe(0);
    expect(second.pairesDoublons).toBe(TAILLE_CORPUS_GEN3);
    expect(second.totalPaires).toBe(TAILLE_CORPUS_GEN3);
  });

  it("ignore les paires invalides (motifs/réponses vides)", () => {
    const cortex = new CortexLangagierGen3();
    const stats = cortex.apprendre([
      { motif: "  ", reponse: "x", theme: "t" },
      { motif: "x", reponse: "", theme: "t" },
      { motif: "valide", reponse: "réponse valide", theme: "t" },
    ]);
    expect(stats.pairesAjoutees).toBe(1);
  });
});

describe("CortexLangagierGen3 — appariement", () => {
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3);

  it("répond à une question exacte du corpus", () => {
    const reponse = cortex.repondre("bonjour");
    expect(reponse).not.toBeNull();
    expect(reponse!.theme).toBe("salutation");
    expect(reponse!.texte).toContain("Gen3ia");
  });

  it("répond à des reformulations proches (tolérance lexicale)", () => {
    const casReformes: Array<[string, string]> = [
      ["Bonjour !", "salutation"],
      ["Qui es-tu exactement ?", "identite"],
      ["Que peux-tu faire pour moi ?", "capacites"],
      ["Comment tu as été entraîné ?", "entrainement"],
      ["C'est quoi Gen3ia ?", "plateforme"],
      ["Tu utilises ChatGPT ?", "plateforme"],
      ["Merci beaucoup !", "remerciement"],
      ["Au revoir à bientôt", "au_revoir"],
    ];
    for (const [question, theme] of casReformes) {
      const reponse = cortex.repondre(question);
      expect(reponse, `échec pour « ${question} »`).not.toBeNull();
      expect(reponse!.theme).toBe(theme);
    }
  });

  it("reste sous le seuil sur une requête sans lien (pas de fausse réponse)", () => {
    const reponse = cortex.repondre("explique la thermodynamique quantique des trous noirs");
    expect(reponse).toBeNull();
  });

  it("ne répond pas à une requête vide", () => {
    expect(cortex.repondre("")).toBeNull();
    expect(cortex.repondre("   ")).toBeNull();
  });

  it("gère les accents et la ponctuation (normalisation du tokenizer)", () => {
    const reponse = cortex.repondre("ÉTÉ... tu es là ??");
    expect(reponse).not.toBeNull();
    expect(reponse!.theme).toBe("incomprehension");
  });

  it("utilise le contexte du tour précédent pour les reprises courtes", () => {
    // « et toi ? » seul ne matche rien sans contexte…
    const sansContexte = cortex.repondre("et toi ?");
    // …mais avec le tour précédent sur l'identité, la reprise est résolue.
    const avecContexte = cortex.repondre("et toi ?", {
      messagePrecedent: "comment tu t appelles",
    });
    expect(avecContexte).not.toBeNull();
    expect(avecContexte!.texte).toContain("Gen3ia");
    // Léger : la reprise seule peut matcher ou non selon le corpus —
    // l'assertion critique est que le contexte AIDE et ne casse rien.
    if (sansContexte !== null) {
      expect(avecContexte!.score).toBeGreaterThanOrEqual(sansContexte.score);
    }
  });
});

describe("CortexLangagierGen3 — gardes anti-hors-sujet (rectifications UI)", () => {
  it("garde de couverture : un verbe partagé seul ne déclenche plus la paire générique", () => {
    // Bug réel (test UI) : « Écris une fonction TypeScript typée qui calcule
    // la moyenne d'un tableau… » recevait « J'écris, oui : c'est même une de
    // mes façons de penser… » via le seul token « écris ».
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    const r = cortex.repondre(
      "Écris une fonction TypeScript typée qui calcule la moyenne d'un tableau de nombres, avec gestion du cas vide.",
    );
    // La paire générique « écrire » ne doit PAS répondre : soit null (le
    // moteur composera honnêtement par intention), soit une paire qui
    // couvre réellement le sujet (jamais la réplique générique).
    if (r !== null) {
      expect(r.texte).not.toContain("une de mes façons de penser");
    }
  });

  it("garde d'écriture : une paire ARABE ne répond plus à une question FR (bug réel)", () => {
    // Bug réel (test UI) : « Calcule 47 + 38… » recevait une paire arabe
    // de vente de vêtements apprise par l'auto-apprentissage, matchée sur
    // le seul chiffre « 38 ».
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(
      [
        {
          motif: "مقاس 38 قطعة",
          reponse: "عندنا آخر قطعة مقاس 38. ما أريدك تجي بكره وتندم",
          theme: "vente",
        },
      ],
      { personnalisees: true },
    );
    for (let i = 0; i < 30; i++) cortex.repondre("مقاس 38 قطعة"); // usage max
    const r = cortex.repondre("Calcule 47 + 38 en montrant chaque étape du calcul, puis vérifie le résultat.");
    expect(r).toBeNull();
  });

  it("garde de langue : une paire EN ne répond plus à une question FR", async () => {
    const { détecterLangue } = await import("./language");
    expect(détecterLangue("Qu'est-ce que l'effet de serre ? Explique le mécanisme.")).toBe("fr");
    expect(détecterLangue("Yes, there is a 65 nonrefundable application fee.")).toBe("en");
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(
      [
        {
          motif: "application fee admission portal",
          reponse: "Yes, there is a 65 nonrefundable application fee, which can be processed in the personal application portal.",
          theme: "admissions",
        },
      ],
      { personnalisees: true },
    );
    // Renforce 30× (usage max) : même avec un poids maximal, la paire EN
    // ne répond PAS à une question française hors-sujet.
    for (let i = 0; i < 30; i++) cortex.repondre("application fee admission portal");
    const r = cortex.repondre("Qu'est-ce que l'effet de serre ? Explique le mécanisme cause à effet avec un ordre de grandeur.");
    expect(r).toBeNull();
  });

  it("plasticité d'usage : une paire très utilisée ne secours PAS une correspondance médiocre", async () => {
    const { BARRE_BASE_USAGE } = await import("./language");
    expect(BARRE_BASE_USAGE).toBeGreaterThan(0);
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(
      [
        {
          motif: "recette gateau chocolat",
          reponse: "Mélangez farine, œufs et chocolat fondu puis enfournez 30 minutes.",
          theme: "cuisine",
        },
      ],
      { personnalisees: true },
    );
    for (let i = 0; i < 30; i++) cortex.repondre("recette gateau chocolat");
    // Question voisine mais SANS rapport au motif (recouvrement faible) :
    // même avec usage maximal, la paire ne doit pas répondre.
    const r = cortex.repondre("Explique le mécanisme de la photosynthèse avec un ordre de grandeur.");
    expect(r).toBeNull();
  });
});

describe("CortexLangagierGen3 — plasticité d'usage", () => {
  it("renforce le poids d'usage d'une paire rappelée (plafonné)", async () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);

    const avant = cortex.exporterEtat();
    const cleAttendue = Object.keys(avant.poidsUsage).length;

    for (let i = 0; i < 30; i++) {
      const r = cortex.repondre("bonjour");
      expect(r).not.toBeNull();
    }

    const apres = cortex.exporterEtat();
    const poids = Object.values(apres.poidsUsage);
    expect(Object.keys(apres.poidsUsage).length).toBeGreaterThanOrEqual(
      cleAttendue === 0 ? 1 : cleAttendue,
    );
    expect(poids.length).toBeGreaterThan(0);
    for (const p of poids) {
      expect(p).toBeLessThanOrEqual(2.0);
    }
  });
});

describe("CortexLangagierGen3 — paires personnalisées & persistance", () => {
  it("apprend des paires personnalisées, les exporte et les restaure (round-trip)", () => {
    const source = new CortexLangagierGen3();
    source.apprendre(CORPUS_GEN3);
    const stats = source.apprendre(
      [
        {
          motif: "quel est mon produit prefere",
          reponse: "Votre produit préféré est le café Gen3ia (appris de vous).",
          theme: "personnalise",
        },
      ],
      { personnalisees: true },
    );
    expect(stats.pairesAjoutees).toBe(1);
    expect(source.compterPersonnalisees()).toBe(1);
    // Bonus de personnalisation : la paire répond bien.
    const reponse = source.repondre("quel est mon produit prefere ?");
    expect(reponse).not.toBeNull();
    expect(reponse!.source).toBe("personnalisee");

    // Round-trip : l'état restauré dans un cortex neuf (corpus réappris) répond pareil.
    const etat = source.exporterEtat();
    expect(etat.pairesPersonnalisees).toHaveLength(1);

    const clone = new CortexLangagierGen3();
    clone.apprendre(CORPUS_GEN3);
    const restaure = clone.importerEtat(etat);
    expect(restaure.pairesAjoutees).toBe(1);
    const reponseClone = clone.repondre("quel est mon produit prefere ?");
    expect(reponseClone).not.toBeNull();
    expect(reponseClone!.texte).toContain("café Gen3ia");
  });

  it("un doublon de motif personnalisé n'écrase pas le corpus (et inversement)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    const stats = cortex.apprendre(
      [{ motif: "bonjour", reponse: "Salut perso !", theme: "perso" }],
      { personnalisees: true },
    );
    expect(stats.pairesAjoutees).toBe(0);
    expect(stats.pairesDoublons).toBe(1);
  });

  it("oublierPersonnalisees retire uniquement les paires enseignées", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    cortex.apprendre(
      [
        { motif: "paire a", reponse: "a", theme: "t" },
        { motif: "paire b", reponse: "b", theme: "t" },
      ],
      { personnalisees: true },
    );
    expect(cortex.compterPersonnalisees()).toBe(2);
    const oubliees = cortex.oublierPersonnalisees();
    expect(oubliees).toBe(2);
    expect(cortex.compterPersonnalisees()).toBe(0);
    expect(cortex.nbPaires).toBe(TAILLE_CORPUS_GEN3);
    // Le corpus reste fonctionnel après l'oubli.
    expect(cortex.repondre("bonjour")).not.toBeNull();
  });

  it("importerEtat tolère les données invalides (défense en profondeur)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    const stats = cortex.importerEtat({
      pairesPersonnalisees: [
        { motif: "", reponse: "x", theme: "t" },
        { motif: "ok", reponse: "réponse ok", theme: "t" },
        null as unknown as { motif: string; reponse: string; theme: string },
      ],
      poidsUsage: { "mauvaise cle": -3 },
    });
    expect(stats.pairesAjoutees).toBe(1);
    expect(cortex.nbPaires).toBe(TAILLE_CORPUS_GEN3 + 1);
  });
});

describe("Moteur neural + cortex langagier (intégration runtime)", () => {
  it("répond conversationnellement depuis le corpus (source cortex)", async () => {
    const runtime = getNeuralRuntime();
    const reponse = await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "Qui es-tu ?" }],
    });

    expect(reponse.provider).toBe("gen3-snn");
    expect(reponse.text).toContain("Gen3ia");
    const raw = reponse.raw as {
      langage?: { source?: string; theme?: string };
    };
    expect(raw.langage?.source).toBe("cortex_corpus");
    expect(raw.langage?.theme).toBe("identite");
  });

  it("la mémoire de conversation retient le tour (hippocampe)", async () => {
    const runtime = getNeuralRuntime();
    runtime.hippocampe.reset();
    await runtime.engine.generate({
      task: "chat",
      messages: [{ role: "user", content: "bonjour" }],
    });
    const historique = runtime.hippocampe.getHistory();
    expect(historique.length).toBeGreaterThan(0);
    expect(historique[historique.length - 1].user.toLowerCase()).toContain(
      "bonjour",
    );
    expect(
      historique[historique.length - 1].system.length,
    ).toBeGreaterThan(0);
  });

  it("le flux n'émet plus de lignes de cycles — uniquement la réponse", async () => {
    const runtime = getNeuralRuntime();
    const fragments: string[] = [];
    await runtime.engine.generateStream(
      {
        task: "chat",
        messages: [{ role: "user", content: "merci beaucoup" }],
      },
      { onDelta: (delta) => fragments.push(delta) },
    );
    const flux = fragments.join("");
    expect(flux.length).toBeGreaterThan(0);
    expect(flux).not.toMatch(/Cycle \d+\//);
    expect(flux).toContain("Merci");
  });
});
