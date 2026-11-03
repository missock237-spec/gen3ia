/**
 * GARDES it.86-b — réponses instanciées + garde de cohérence numérique.
 *
 * Anomalie corrigée (interrogatoire utilisateur réel, tick 05:10) :
 * « 4435 … et 29 le soir » recevait « Somme : 3 + 2 = 5 » (nombres figés
 * d'une paire voisine) ; « Paul … Kim … Sam. Qui est au milieu ? »
 * recevait la même paire math ; « Il est 14 h. J'attends 3 h. » tombait
 * sur une intention système hors-sujet.
 */
import { describe, expect, it } from "vitest";

import { CortexLangagierGen3 } from "../neural/generation/language";
import { nombresDe, reponseInstantiee } from "../gen3/reponses-instantiees";
import {
  ANALOGIES,
  CHAINES_CAUSALES,
  N_TOTAL_MILLIARD,
  PLANIFICATIONS,
  REGLES_CONDITIONNELLES,
  questionStratifiee,
} from "../gen3/interrogation-milliard";
import type { PaireLangage } from "../neural/generation/corpus";

describe("Réponses instanciées (lib/gen3/reponses-instantiees.ts)", () => {
  it("extraction d'entiers robuste (espaces fines absorbées)", () => {
    expect(nombresDe("4435 enfants et 29 le soir")).toEqual([4435, 29]);
    expect(nombresDe("Il est 14 h. J'attends 3 h.")).toEqual([14, 3]);
    expect(nombresDe("aucun nombre ici")).toEqual([]);
  });

  it("addition verbale : le résultat est CALCULÉ depuis la question", () => {
    const r = reponseInstantiee(
      "Un bus transporte 512 passagers le matin et 87 l'après-midi. Combien de passagers en tout ?",
    );
    expect(r).not.toBeNull();
    expect(r).toContain("512 + 87 = 599");
    expect(r).toContain("Donc : il y a 599 en tout.");
    // jamais un nombre qui n'est pas dans la question
    expect(r).not.toContain("3 + 2 = 5");
  });

  it("anomalie motrice : 4435 + 29 = 4464, jamais 3 + 2 = 5", () => {
    const r = reponseInstantiee(
      "4435 enfants mangent à la cantine le midi et 29 le soir. Combien de repas sont servis en tout ?",
    );
    expect(r).toContain("4435 + 29 = 4464");
  });

  it("heure + durée : 14 h + 3 h = 17 h", () => {
    const r = reponseInstantiee("Il est 14 h. J'attends 3 h. Quelle heure sera-t-il ?");
    expect(r).toContain("17 h");
    expect(r).toContain("14 + 3 = 17");
  });

  it("chaîne spatiale : le milieu est l'entité entre les deux extrémités", () => {
    const r = reponseInstantiee(
      "Paul est à gauche de Kim, Kim est à gauche de Sam. Qui est au milieu ?",
    );
    expect(r).toContain("Kim est au milieu");
  });

  it("syllogisme : conclusion instanciée + garde de la converse", () => {
    const simple = reponseInstantiee(
      "Tous les roses sont des fleurs. Cette plante est une rose. Qu'est-ce qu'on en déduit ?",
    );
    expect(simple).toContain("fait partie des fleurs");
    expect(simple).not.toContain("PAS valide");

    const converse = reponseInstantiee(
      "Tous les chats sont des félins. Mimo est un chat. Et si je dis « tous les félins sont des chats », est-ce valable ?",
    );
    expect(converse).toContain("PAS valide");
  });

  it("aucun déclenchement hors gabarit (conversation normale)", () => {
    expect(reponseInstantiee("Merci beaucoup pour ton aide !")).toBeNull();
    expect(reponseInstantiee("Bonjour, qui es-tu ?")).toBeNull();
    expect(reponseInstantiee("Écris un poème sur la mer.")).toBeNull();
  });

  it("déterminisme : même question → même réponse", () => {
    const q = "Un entrepôt reçoit 640 paquets le lundi et 359 paquets le mardi. Combien de paquets au total ?";
    expect(reponseInstantiee(q)).toBe(reponseInstantiee(q));
  });
});

describe("Réponses instanciées it.87 (familles épuisables + gabarits générateur)", () => {
  it("modus ponens : conclusion dérivée depuis la règle posée (générique, toute règle)", () => {
    const regle = REGLES_CONDITIONNELLES[0];
    const prompt = `On sait que si ${regle.si}, alors ${regle.alors}. Or pour Amine, ${regle.si}. Que peut-on conclure ?`;
    const rep = reponseInstantiee(prompt);
    expect(rep).not.toBeNull();
    expect(rep).toContain(regle.alors);
  });

  it("modus tollens : négation de l'antécédent depuis la table du générateur", () => {
    const regle = REGLES_CONDITIONNELLES[2];
    const prompt = `On sait que si ${regle.si}, alors ${regle.alors}. Or pour Imani, ${regle.sansSi}. Que peut-on conclure sur « ${regle.si} » ?`;
    const rep = reponseInstantiee(prompt);
    expect(rep).not.toBeNull();
    expect(rep).toContain(regle.sansAlors);
  });

  it("modus tollens avec observation hors table : null (pas d'invention)", () => {
    const regle = REGLES_CONDITIONNELLES[0];
    const prompt = `On sait que si ${regle.si}, alors ${regle.alors}. Or pour Imani, le ciel est dégagé. Que peut-on conclure sur « ${regle.si} » ?`;
    expect(reponseInstantiee(prompt)).toBeNull();
  });

  it("analogie : les deux gabarits servent le même terme dérivé", () => {
    const [a, b, c, d] = ANALOGIES[0];
    const rep1 = reponseInstantiee(`Complète l'analogie : ${a} est à ${b} ce que ${c} est à quoi ?`);
    expect(rep1).not.toBeNull();
    expect(rep1).toContain(d);
    const rep2 = reponseInstantiee(`Si ${a} correspond à ${b}, à quoi correspond ${c} ?`);
    expect(rep2).not.toBeNull();
    expect(rep2).toContain(d);
  });

  it("causalité : chaîne complète milieu → effet", () => {
    const [cause, milieu, effet] = CHAINES_CAUSALES[0];
    const rep1 = reponseInstantiee(`Explique la chaîne de cause à effet : ${cause}. Que s'est-il passé ensuite ?`);
    expect(rep1).not.toBeNull();
    expect(rep1).toContain(milieu);
    expect(rep1).toContain(effet);
    const rep2 = reponseInstantiee(
      `${cause.charAt(0).toUpperCase()}${cause.slice(1)}. Quelle est la conséquence finale de cet événement ?`,
    );
    expect(rep2).not.toBeNull();
    expect(rep2).toContain(effet);
  });

  it("planification : plan ordonné complet", () => {
    const [objectif, plan] = PLANIFICATIONS[0];
    const rep1 = reponseInstantiee(`Comment faire pour ${objectif} ? Donne les étapes dans l'ordre.`);
    expect(rep1).not.toBeNull();
    expect(rep1).toContain(plan);
    const rep2 = reponseInstantiee(
      `${objectif.charAt(0).toUpperCase()}${objectif.slice(1)} : quel plan d'action propose-t-on, étape par étape ?`,
    );
    expect(rep2).not.toBeNull();
    expect(rep2).toContain(plan);
  });

  it("syllogisme gabarit générateur « fait partie des » : déduction + garde de la converse", () => {
    const rep1 = reponseInstantiee(
      "Tous les moineaux sont des oiseaux. Chirpy fait partie des moineaux. Qu'est-ce qu'on peut en déduire sur Chirpy ?",
    );
    expect(rep1).not.toBeNull();
    expect(rep1).toContain("appartient aussi aux oiseaux");
    const rep2 = reponseInstantiee(
      "Tous les moineaux sont des oiseaux. Chirpy fait partie des oiseaux. Peut-on conclure que Chirpy fait partie des moineaux ?",
    );
    expect(rep2).not.toBeNull();
    expect(rep2).toContain("n'est pas valide");
  });

  it("boussole : cap final CALCULÉ depuis la séquence de mouvements", () => {
    // nord → droite → est → droite → sud ; nord → demi-tour → sud
    const rep = reponseInstantiee(
      "Léo fait face au nord. Il tourne à droite, puis droite. Vers quelle direction fait il face maintenant ?",
    );
    expect(rep).not.toBeNull();
    expect(rep).toContain("sud");
    const rep2 = reponseInstantiee(
      "Zaid fait face au nord. Elle tourne à demi-tour, puis gauche. Vers quelle direction fait elle face maintenant ?",
    );
    expect(rep2).not.toBeNull();
    expect(rep2).toContain("est");
  });

  it("durée en minutes : 9 h 30 + 45 min = 10 h 15", () => {
    const rep = reponseInstantiee("Il est 9 h 30. Une tâche dure 45 minutes. À quelle heure sera-t-elle terminée ?");
    expect(rep).not.toBeNull();
    expect(rep).toContain("10 h 15");
  });

  it("it.88 : le syntagme démonstratif complet est préservé (sujet + complément)", () => {
    const rep = reponseInstantiee(
      "Tous les pins sont des arbres. Ce conifère du jardin est un pin. Que déduis-tu ?",
    );
    expect(rep).not.toBeNull();
    // la prémisse reprend le sujet ENTIER, jamais tronqué (« jardin » seul)
    expect(rep).toContain("Ce conifère du jardin est un pin");
    // la conclusion instancie le sujet complet
    expect(rep).toContain("Donc : Ce conifère du jardin fait partie des arbres");
    // garde anti-régression sur le sujet sans complément
    const simple = reponseInstantiee(
      "Tous les pins sont des arbres. Cet arbre est un pin. Que déduis-tu ?",
    );
    expect(simple).toContain("Donc : Cet arbre fait partie des arbres");
  });

  it("it.89 couleurs : reconnaissance, propriétés, mélange, complémentaire — calculés depuis la question", () => {
    // reconnaissance : couleur canonique — nom exact Kaggle + repli palette
    const rec = reponseInstantiee("Quelle couleur porte le code hexa #FF0000 ?");
    expect(rec).not.toBeNull();
    expect(rec).toContain("« Red »");
    expect(rec).toContain("une couleur chaude");
    // couleur non canonique : plus proche voisin + nom exact
    const proche = reponseInstantiee("À quelle couleur de la palette correspond #00FFFF ?");
    expect(proche).toContain("cyan");
    // propriétés
    const prop = reponseInstantiee("La couleur #0000FF est-elle chaude ou froide, et claire, sombre ou moyenne ?");
    expect(prop).toContain("froide");
    expect(prop).toContain("sombre");
    // mélange lumière (additif)
    const mel = reponseInstantiee(
      "On mélange de la lumière rouge (#FF0000) et de la lumière vert (#00FF00). Quelle couleur obtient-on ?",
    );
    expect(mel).toContain("#FFFF00");
    expect(mel).toContain("jaune");
    // complémentaire
    const comp = reponseInstantiee("Quelle est la couleur complémentaire de #FF0000 ?");
    expect(comp).toContain("#00FFFF");
    expect(comp).toContain("cyan");
    // décomposition
    const dec = reponseInstantiee("Décompose le code hexa #4B0082 en valeurs de rouge, vert et bleu.");
    expect(dec).toContain("rouge = 75");
    expect(dec).toContain("bleu = 130");
    // hors gabarit couleur : null (conversation normale)
    expect(reponseInstantiee("Peux-tu me parler de l'histoire de l'art ?")).toBeNull();
  });

  it("it.90 ROBUSTESSE MÉLANGES (faille mesurée en production, re-test Q4) : accords réels et phrasé sans hexa servis", () => {
    // accord féminin réel (« lumière verte ») — avant it.90 : non servi,
    // tombait dans la famille reconnaissance (mesuré 4/5 sur gen3ia.online)
    const accorde = reponseInstantiee(
      "On mélange de la lumière rouge (#FF0000) et de la lumière verte (#00FF00). Quelle couleur obtient-on ?",
    );
    expect(accorde).not.toBeNull();
    expect(accorde).toContain("#FFFF00");
    expect(accorde).toContain("jaune");
    // phrasé courant SANS codes hexa
    const sansHexa = reponseInstantiee(
      "On mélange de la lumière rouge et de la lumière verte. Quelle couleur obtient-on ?",
    );
    expect(sansHexa).not.toBeNull();
    expect(sansHexa).toContain("#FFFF00");
    // phrasé « en mélangeant … » + accord « bleue »
    // bleu (0,0,255) + jaune (255,255,0) en lumière = (255,255,255) blanc
    const melangeant = reponseInstantiee(
      "Qu'obtient-on en mélangeant de la lumière bleue et de la lumière jaune ?",
    );
    expect(melangeant).not.toBeNull();
    expect(melangeant).toContain("#FFFFFF");
    // accord pluriel « pigments rouges » (voie pigmentaire)
    const pluriel = reponseInstantiee(
      "On mélange des pigments rouges (#FF0000) et des pigments verts (#00FF00).",
    );
    expect(pluriel).not.toBeNull();
    expect(pluriel).toContain("pigments (soustractif");
    // « vert anis » (nom composé) reste servi sans hexa
    const compose = reponseInstantiee(
      "On mélange de la lumière vert anis et de la lumière magenta.",
    );
    expect(compose).not.toBeNull();
    // anti-régression : le phrasé générateur d'origine reste servi
    const generateur = reponseInstantiee(
      "On mélange de la lumière rouge (#FF0000) et de la lumière vert (#00FF00). Quelle couleur obtient-on ?",
    );
    expect(generateur).toContain("#FFFF00");
  });

  it("it.89 : le nom EXACT du dataset réel Kaggle color-names est servi (1 156 couleurs intégrées)", () => {
    // #0048BA « Absolute zero » — une couleur RÉELLE de la base Kaggle,
    // impossible à deviner par la seule palette (24 couleurs)
    const kaggle = reponseInstantiee("Quelle couleur porte le code hexa #0048BA ?");
    expect(kaggle).toContain("« Absolute zero »");
    expect(kaggle).toContain("bleu");
    // couleur non canonique hors base Kaggle : repli palette propre
    const horsBase = reponseInstantiee("Quelle couleur porte le code hexa #0F1E2D ?");
    expect(horsBase).not.toBeNull();
    expect(horsBase).toContain("couleur");
  });

  it("COHÉRENCE GÉNÉRATEUR ↔ CHAT : les questions stratifiées des 7 familles de diversité reçoivent leur extrait vérifiable", () => {
    // Le plan stratifié pose les 7 familles de diversité DÈS LES PREMIERS
    // indices (math_verbal absorbe la fin) — on vérifie le chat sur les
    // questions réelles du balayage, la même source de vérité que le harnais.
    const N = N_TOTAL_MILLIARD;
    const famillesCiblees = new Set([
      "deduction",
      "conditionnel",
      "spatial",
      "temporel",
      "analogie",
      "causalite",
      "planification",
    ]);
    let couvertes = 0;
    for (let j = 0; j < 900 && couvertes < 240; j++) {
      const q = questionStratifiee(j, N);
      if (!famillesCiblees.has(q.famille)) continue;
      const rep = reponseInstantiee(q.prompt);
      expect(rep, `famille ${q.famille} sans réponse instanciée à j=${j} : ${q.prompt}`).not.toBeNull();
      const bas = (rep ?? "").toLowerCase();
      const present = q.extraitsVerifiables.some((ex) => bas.includes(ex.toLowerCase()));
      expect(present, `extrait absent pour ${q.famille} à j=${j} : ${q.prompt} → ${rep}`).toBe(true);
      couvertes += 1;
    }
    expect(couvertes).toBeGreaterThanOrEqual(200);
  });
});

describe("Garde de cohérence numérique du scoreur (language.ts)", () => {
  const PAIRE_VOISINE_FAUSSE: PaireLangage = {
    motif: "3 enfants mangent à la cantine le midi et 2 le soir. Combien de repas sont servis en tout ?",
    reponse: "1) On repère l'opération : deux quantités s'additionnent. 2) Première quantité : 3. Seconde : 2. 3) Somme : 3 + 2 = 5. Donc : il y a 5 en tout.",
    theme: "math_verbal",
  };

  it("la paire 3+2 ne répond JAMAIS à la question 4435/29 (désinformation tuée)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre([PAIRE_VOISINE_FAUSSE]);
    const rep = cortex.repondre(
      "4435 enfants mangent à la cantine le midi et 29 le soir. Combien de repas sont servis en tout ?",
    );
    // soit null (la méthode/généralisation prend la main), soit une réponse
    // NUMÉRIQUEMENT cohérente — jamais « 3 + 2 = 5 »
    if (rep) {
      expect(rep.texte).not.toContain("3 + 2 = 5");
    }
  });

  it("la paire cohérente répond toujours à sa propre question (zéro régression)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre([PAIRE_VOISINE_FAUSSE]);
    const rep = cortex.repondre(
      "3 enfants mangent à la cantine le midi et 2 le soir. Combien de repas sont servis en tout ?",
    );
    expect(rep).not.toBeNull();
    expect(rep!.texte).toContain("3 + 2 = 5");
  });
});
