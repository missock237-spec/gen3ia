/**
 * DIAGNOSTIC it.86-b : reproduit localement le chemin de réponse du chat
 * (compositionCorpusPrioritaire = scoreur cortex → méthode générique)
 * pour les 5 questions de l'interrogatoire utilisateur réel.
 */
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import { detecterMethodeRaisonnement } from "../lib/gen3/familles-methodes";

const QUESTIONS = [
  "4435 enfants mangent à la cantine le midi et 29 le soir. Combien de repas sont servis en tout ?",
  "Un bus transporte 512 passagers le matin et 87 l'après-midi. Combien de passagers en tout ?",
  "Tous les roses sont des fleurs. Cette plante est une rose. Qu'est-ce qu'on en déduit ?",
  "Paul est à gauche de Kim, Kim est à gauche de Sam. Qui est au milieu ?",
  "Il est 14 h. J'attends 3 h. Quelle heure sera-t-il ?",
];

const cortex = new CortexLangagierGen3();
cortex.apprendre(CORPUS_GEN3);

for (const q of QUESTIONS) {
  const rep = cortex.repondre(q);
  console.log("=== Q:", q.slice(0, 60));
  if (rep) {
    console.log("   score:", rep.score.toFixed(2), "| theme:", rep.theme, "| cle:", rep.cle?.slice(0, 40));
    console.log("   texte:", rep.texte.slice(0, 140).replace(/\n/g, " "));
  } else {
    console.log("   scoreur: null");
  }
  const m = detecterMethodeRaisonnement(q);
  console.log("   méthode détectée:", m ? m.famille : "null");
  console.log();
}
