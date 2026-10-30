/**
 * Benchmark contrôlé du prototype Gen3 Brain sur CPU.
 *
 * Exécuter avec : npm run benchmark:brain
 * Les métriques décrivent cette exécution locale ; elles ne sont pas une
 * comparaison publiée contre des modèles tiers ni une preuve de qualité générale.
 */

import { performance } from "node:perf_hooks";

import { CerveauOndulatoireGen3 } from "../lib/neural/brain/cerveau-ondulatoire";
import type { RapportApprentissageCerveau } from "../lib/neural/brain/cerveau-ondulatoire";

interface Exemple {
  entree: string;
  sortie: string;
}

const entrainement: Exemple[] = [
  { entree: "Quelle est la capitale du Cameroun ?", sortie: "Yaoundé." },
  { entree: "Combien font deux plus deux ?", sortie: "Quatre." },
  { entree: "Que signifie HTTP ?", sortie: "Hypertext Transfer Protocol." },
  { entree: "Quelle planète est surnommée la planète rouge ?", sortie: "Mars." },
  { entree: "Quelle est la formule chimique de l'eau ?", sortie: "H2O." },
  { entree: "À quoi sert un processeur CPU ?", sortie: "Il exécute des instructions et des opérations." },
  { entree: "Qu'est-ce qu'une variable en programmation ?", sortie: "Un nom qui référence une valeur." },
  { entree: "Quelle langue parle-t-on principalement au Brésil ?", sortie: "Le portugais." },
  { entree: "Quel organe pompe le sang ?", sortie: "Le cœur." },
  { entree: "Quelle est la fonction des racines d'une plante ?", sortie: "Elles absorbent l'eau et les nutriments et ancrent la plante." },
];

const variantes = [
  { entree: "Capitale du Cameroun", attendu: "Yaoundé." },
  { entree: "Que veut dire HTTP", attendu: "Hypertext Transfer Protocol." },
  { entree: "Le CPU sert à quoi", attendu: "Il exécute des instructions et des opérations." },
];

const inconnues = [
  "La météo demain à Tokyo",
  "Raconte une histoire de dragons sur la lune",
  "Comment changer une roue de voiture",
];

const cerveau = new CerveauOndulatoireGen3({
  taille: 128,
  budgetActif: 8,
  capaciteMemoire: 64,
  seuilRappel: 0.4,
  epoquesParAssociation: 12,
  graine: 42,
});

const heapInitialBytes = process.memoryUsage().heapUsed;
let heapObservedPeakBytes = heapInitialBytes;
const depart = performance.now();
const apprentissages: RapportApprentissageCerveau[] = [];
for (const exemple of entrainement) {
  apprentissages.push(cerveau.apprendre(exemple.entree, exemple.sortie));
  heapObservedPeakBytes = Math.max(heapObservedPeakBytes, process.memoryUsage().heapUsed);
}
const dureeApprentissageMs = performance.now() - depart;

let rappelsExactsCorrects = 0;
for (const exemple of entrainement) {
  const resultat = cerveau.percevoir(exemple.entree);
  if (resultat.mode === "RAPPEL_EXACT" && resultat.sortie === exemple.sortie) {
    rappelsExactsCorrects += 1;
  }
  heapObservedPeakBytes = Math.max(heapObservedPeakBytes, process.memoryUsage().heapUsed);
}

let rappelsApproximatifsCorrects = 0;
const rapportsVariantes = variantes.map((variante) => {
  const resultat = cerveau.percevoir(variante.entree);
  if (
    resultat.mode === "RAPPEL_ASSOCIATIF" &&
    resultat.sortie === variante.attendu
  ) {
    rappelsApproximatifsCorrects += 1;
  }
  heapObservedPeakBytes = Math.max(heapObservedPeakBytes, process.memoryUsage().heapUsed);
  return {
    entree: variante.entree,
    attendu: variante.attendu,
    obtenu: resultat.sortie,
    mode: resultat.mode,
    scoreCosinus: resultat.confiance,
    correct: resultat.sortie === variante.attendu,
  };
});

let inconnuesRejetees = 0;
const rapportsInconnus = inconnues.map((entree) => {
  const resultat = cerveau.percevoir(entree);
  if (resultat.sortie === null && resultat.mode === "INCONNU") inconnuesRejetees += 1;
  heapObservedPeakBytes = Math.max(heapObservedPeakBytes, process.memoryUsage().heapUsed);
  return {
    entree,
    rejete: resultat.sortie === null,
    mode: resultat.mode,
    scoreCosinus: resultat.confiance,
  };
});

const etatFinal = cerveau.exporterEtat();
heapObservedPeakBytes = Math.max(heapObservedPeakBytes, process.memoryUsage().heapUsed);
const statistiques = cerveau.statistiques();
const memoireFinale = process.memoryUsage();
const rapport = {
  nature: "prototype expérimental CPU Gen3 Brain — non représentatif d'un benchmark tiers",
  configuration: {
    tailleOndulatoire: cerveau.taille,
    budgetActifParEtage: cerveau.budgetActif,
    seuilRappelLexical: cerveau.seuilRappel,
    epoquesRPIAParAssociation: cerveau.epoquesParAssociation,
    exemplesEntrainement: entrainement.length,
  },
  apprentissage: {
    dureeMs: Math.round(dureeApprentissageMs * 100) / 100,
    associationsAvecErreurRPIAFinie: apprentissages.filter((item) => Number.isFinite(item.erreurRPIAFinale)).length,
    associationsAvecBaisseErreurRPIA: apprentissages.filter((item) => item.convergenceRPIA).length,
    erreurRPIAMoyenneInitiale: moyenne(apprentissages.map((item) => item.erreurRPIAInitiale)),
    erreurRPIAMoyenneFinale: moyenne(apprentissages.map((item) => item.erreurRPIAFinale)),
  },
  evaluation: {
    rappelsExactsCorrects,
    rappelsExactsTotal: entrainement.length,
    exactRecallRate: rappelsExactsCorrects / entrainement.length,
    rappelsApproximatifsCorrects,
    rappelsApproximatifsTotal: variantes.length,
    approximateRecallRate: rappelsApproximatifsCorrects / variantes.length,
    inconnuesRejetees,
    inconnuesTotal: inconnues.length,
    unknownRejectionRate: inconnuesRejetees / inconnues.length,
    variantes: rapportsVariantes,
    inconnues: rapportsInconnus,
  },
  ressourcesObservees: {
    dureeTotaleMs: Math.round((performance.now() - depart) * 100) / 100,
    heapInitialBytes,
    heapObservedPeakBytes,
    heapActuelBytes: memoireFinale.heapUsed,
    rssActuelBytes: memoireFinale.rss,
    tailleCheckpointJsonBytes: Buffer.byteLength(JSON.stringify(etatFinal), "utf8"),
    ...statistiques,
  },
};

console.log(JSON.stringify(rapport, null, 2));

const controlesReussis =
  rappelsExactsCorrects === entrainement.length &&
  rappelsApproximatifsCorrects === variantes.length &&
  inconnuesRejetees === inconnues.length;
if (!controlesReussis) {
  console.error(
    "ÉCHEC DU BENCHMARK : un rappel exact, un rappel lexical attendu ou un rejet d'inconnue n'a pas satisfait le scénario de référence.",
  );
  process.exitCode = 1;
}

function moyenne(valeurs: number[]): number {
  if (valeurs.length === 0) return 0;
  return valeurs.reduce((total, valeur) => total + valeur, 0) / valeurs.length;
}
