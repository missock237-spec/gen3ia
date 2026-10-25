import { CortexLangagierGen3 } from "/home/z/my-project/gen3ia/lib/neural/generation/language";
import { CORPUS_GEN3 } from "/home/z/my-project/gen3ia/lib/neural/generation/corpus";

const cortex = new CortexLangagierGen3();
cortex.apprendre(CORPUS_GEN3);

// paires apprises simulées (style auto-apprentissage)
cortex.apprendre([
  { motif: "مقاس 38 قطعة", reponse: "عندنا آخر قطعة مقاس 38", theme: "vente" },
  { motif: "quel est le résultat de mon entraînement", reponse: "Voici tes résultats d'entraînement.", theme: "hub:x" },
  { motif: "comment se passe le calcul des cycles étape par étape", reponse: "Le calcul des cycles suit chaque étape.", theme: "hub:x" },
  { motif: "yes there is a 65 nonrefundable application fee", reponse: "Yes, there is a 65 nonrefundable application fee.", theme: "hub:y" },
  { motif: "tu peux écrire quelque chose", reponse: "J'écris, oui : c'est même une de mes façons de penser.", theme: "écriture" },
] as never, { personnalisees: true });

const cas: Array<[string, boolean]> = [
  ["bonjour", true],
  ["Qui es-tu exactement ?", true],
  ["Que peux-tu faire pour moi ?", true],
  ["Comment tu as été entraîné ?", true],
  ["C'est quoi Gen3ia ?", true],
  ["ÉTÉ... tu es là ??", true],
  ["et toi ?", true],
  // hors-sujet (doivent être null)
  ["Calcule 47 + 38 en montrant chaque étape du calcul, puis vérifie le résultat.", false],
  ["Quel est le résultat de 47 plus 38 ? Détaille le calcul étape par étape.", false],
  ["Qu'est-ce que l'effet de serre ? Explique le mécanisme cause à effet avec un ordre de grandeur.", false],
  ["Écris une fonction TypeScript typée qui calcule la moyenne d'un tableau de nombres, avec gestion du cas vide.", false],
  ["explique la thermodynamique quantique des trous noirs", false],
];

for (const [q, attenduOk] of cas) {
  const r = cortex.repondre(q);
  const verdict = (r !== null) === attenduOk ? "OK " : "✗✗ ";
  console.log(`${verdict} score=${r ? r.score.toFixed(3) : "null  "} th=${r?.theme ?? "-"} | ${q.slice(0, 60)}`);
}
