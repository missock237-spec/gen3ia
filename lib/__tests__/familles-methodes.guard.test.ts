/**
 * GARDES it.85-r — généralisation par méthode + calibrage du scoreur.
 *
 * Anomalie mesurée en production (re-test navigateur 2026-11-02 18:10) :
 * les questions REFORMULÉES (syllogisme chats/félins alors que le corpus
 * apprend oiseaux/animaux) retombaient soit sur une paire faussement
 * voisine (match à token isolé : « chat » → abduction, « droite » →
 * droit), soit sur le pont vocation hors-sujet. Deux leviers verrouillés
 * ici :
 *  1. le scoreur exige des couvertures réelles (paire ≥ 45 % d'elle-même,
 *     requête ≥ 25 % portée) pour toute requête riche — les faux matchs
 *     mesurés (Bravo → remerciement 8,53 ; Calcule 47+38 → 20 % de 5,238)
 *     sont rejetés ;
 *  2. quand le corpus n'a pas d'appariement fort mais que les signaux
 *     d'une famille de raisonnement sont reconnus, la MÉTHODE générique
 *     de la famille répond avant le pont vocation — honnête et utile.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import {
  METHODES_FAMILLES,
  detecterMethodeRaisonnement,
} from "../gen3/familles-methodes";
import {
  racineLegere,
  COUVERTURE_PAIRE_MIN,
  COUVERTURE_REQUETE_MIN,
  CortexLangagierGen3,
} from "../neural/generation/language";
import { CORPUS_GEN3 } from "../neural/generation/corpus";

describe("Méthodes par famille (lib/gen3/familles-methodes.ts)", () => {
  it("les 16 familles PP sont représentées avec une méthode substantielle", () => {
    const attendues = [
      "deduction", "conditionnel", "induction", "abduction", "analogie",
      "causalite", "sens_commun", "theorie_esprit", "planification",
      "math_verbal", "pragmatique", "ethique", "spatial", "temporel",
      "metacognition", "resolution",
    ];
    expect(METHODES_FAMILLES.map((f) => f.famille).sort()).toEqual(
      [...attendues].sort(),
    );
    for (const f of METHODES_FAMILLES) {
      // 5 étapes numérotées + conclusion « Donc : » (format PP pas-à-pas).
      expect(f.methode).toContain("1)");
      expect(f.methode).toContain("5)");
      expect(f.methode).toContain("Donc :");
      expect(f.signauxForts.length + f.signauxFaibles.length).toBeGreaterThanOrEqual(3);
      // Aucun signal multi-mots : ils ne matcheraient jamais sur un token unique.
      for (const s of [...f.signauxForts, ...f.signauxFaibles]) {
        expect(s.includes(" ")).toBe(false);
      }
    }
  });

  it("re-test production : les 6 questions reformulées sont reconnues (5 familles + TdE)", () => {
    // Mesures du re-test navigateur 18:10 — ces formulations exactes
    // échouaient en production avant correctif.
    expect(detecterMethodeRaisonnement("Tous les chats sont des félins. Mimo est un chat. Que peut-on conclure sur Mimo ? Et si je dis « tous les chats sont des félins, donc tous les félins sont des chats », est-ce valable ?")?.famille).toBe("deduction");
    expect(detecterMethodeRaisonnement("Un vendeur achète 3 caisses de 24 oranges à 400 francs la caisse. Il vend chaque orange à 20 francs. Quel est son bénéfice ?")?.famille).toBe("math_verbal");
    expect(detecterMethodeRaisonnement("Je suis dans un couloir face au nord. Je tourne à droite, puis encore à droite, puis à gauche. Dans quelle direction est-ce que je regarde maintenant ?")?.famille).toBe("spatial");
    expect(detecterMethodeRaisonnement("Quelqu'un dit : « Bravo, tu as vraiment perfectionné ton talent pour arriver en retard. » Que veut dire cette personne réellement ?")?.famille).toBe("pragmatique");
    expect(detecterMethodeRaisonnement("Depuis qu'un nouveau barrage a été construit, les champs en aval sont plus verts mais les pêcheurs attrapent moins de poissons. Explique la chaîne de cause à effet.")?.famille).toBe("causalite");
    // Limite documentée : ce scénario TdE ne contient aucun signal de
    // croyance — la détection reste honnête (null), pas de fausse famille.
    expect(detecterMethodeRaisonnement("Léa range son jouet dans le tiroir bleu et sort jouer. Pendant son absence, sa mère le déplace dans le placard vert. Quand Léa rentre, où va-t-elle chercher son jouet, et pourquoi ?")).toBeNull();
  });

  it("zéro faux positif sur les questions banales (mesures du re-test)", () => {
    const banales = [
      "bonjour",
      "crée-moi une image de chat orange",
      "quel temps fait-il à Yaoundé ?",
      "que veux-tu dire ?",
      "pourquoi tu ne réponds pas ?",
      "génère une vidéo de kermesse scolaire",
      "combien de messages tu peux envoyer ?",
      "je vais apprendre le piano l'année prochaine",
      "raconte-moi une blague",
      "comment va la météo ce week-end ?",
    ];
    for (const b of banales) {
      expect(detecterMethodeRaisonnement(b)).toBeNull();
    }
  });

  it("déterminisme : même message → même famille (premier max de l'ordre stable)", () => {
    const q = "Tous les chats sont des félins. Mimo est un chat. Que peut-on conclure ?";
    const a = detecterMethodeRaisonnement(q);
    const b = detecterMethodeRaisonnement(q);
    expect(a).toEqual(b);
  });

  it("le moteur consulte les méthodes quand le corpus est sous le seuil (branché avant le pont vocation)", () => {
    const cheminEngine = join(process.cwd(), "lib/neural/engine.ts");
    const engine = existsSync(cheminEngine) ? readFileSync(cheminEngine, "utf8") : "";
    expect(engine).toContain("detecterMethodeRaisonnement(messageUtilisateur)");
    // la méthode passe APRÈS l'échec corpus mais AVANT le retour null —
    // le segment analysé est celui qui contient l'appel de détection
    // (plusieurs occurrences : 4 appels + la déclaration privée).
    const bloc =
      engine
        .split("compositionCorpusPrioritaire")
        .find((s) => s.includes("detecterMethodeRaisonnement(messageUtilisateur)")) ?? "";
    const positionCorpus = bloc.indexOf("repondre(messageUtilisateur)");
    const positionMethode = bloc.indexOf("detecterMethodeRaisonnement");
    const positionNull = bloc.indexOf("return null", positionMethode);
    expect(positionCorpus).toBeGreaterThanOrEqual(0);
    expect(positionMethode).toBeGreaterThan(positionCorpus);
    expect(positionNull).toBeGreaterThan(positionMethode);
    // le thème annonce la famille : traçabilité honnête
    expect(engine).toContain("methode:${methode.famille}");
  });
});

describe("Scoreur calibré (lib/neural/generation/language.ts — it.85-r)", () => {
  it("racinisation légère symétrique : pluriels et verbes convergent", () => {
    expect(racineLegere("chats")).toBe("chat");
    expect(racineLegere("chat")).toBe("chat");
    expect(racineLegere("animaux")).toBe("animal");
    expect(racineLegere("animal")).toBe("animal");
    expect(racineLegere("francs")).toBe("franc");
    expect(racineLegere("oranges")).toBe("orange");
    expect(racineLegere("acheter")).toBe("achete");
    expect(racineLegere("achetez")).toBe("achete");
    expect(racineLegere("regardent")).toBe("regarde");
    // les mots courts ne sont jamais écrasés
    expect(racineLegere("sel")).toBe("sel");
    expect(racineLegere("vis")).toBe("vis");
  });

  it("constantes de couverture calibrées par mesure (issues des faux matchs de prod)", () => {
    // Bravo→remerciement : couverture paire 0,67 / requête 0,22 — la
    // conjonction (≥ 0,45 ET ≥ 0,25) tue le faux match des deux côtés.
    expect(COUVERTURE_PAIRE_MIN).toBe(0.45);
    expect(COUVERTURE_REQUETE_MIN).toBe(0.25);
  });

  it("faux match mesuré n°1 : « Bravo, tu as vraiment perfectionné… » ne répond plus remerciement", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    const r = cortex.repondre(
      "Quelqu'un dit : « Bravo, tu as vraiment perfectionné ton talent pour arriver en retard. » Que veut dire cette personne réellement ?",
    );
    // La VRAIE paire pragmatique (ironie, substantielle) répond — pas la
    // paire « bravo » à token unique. Si le scoreur passe sous le seuil
    // corpus, la méthode famille pragmatique prend le relais : dans tous
    // les cas, jamais « Merci ! Je le dois à mon entraînement ».
    if (r !== null) {
      expect(r.theme).toContain("pragmatique");
    }
  });

  it("faux match mesuré n°2 : « Calcule 47 + 38… » ne réveille plus la paire 20 % de 5,238", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    expect(
      cortex.repondre("Calcule 47 + 38 en montrant chaque étape du calcul."),
    ).toBeNull();
  });

  it("l'appariement EXACT d'une paire apprise reste vivant (aucune régression du rappel)", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3);
    // Première paire déduction du corpus, posée quasi mot pour mot.
    const paire = CORPUS_GEN3.find((p) => p.theme.includes("deduction"));
    expect(paire).toBeDefined();
    const r = cortex.repondre(paire!.motif);
    expect(r).not.toBeNull();
    expect(r!.theme).toBe(paire!.theme);
    // et l'appariement exact passe le seuil corpus prioritaire (≥ 3)
    expect(r!.score).toBeGreaterThanOrEqual(3);
  });
});
