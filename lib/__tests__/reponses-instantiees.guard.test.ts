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
