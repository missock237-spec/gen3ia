import type {
  AdaptateurEntrainementIA,
  DonneesEntrainement,
  ResultatEvaluationIA,
  ResultatEntrainementIA,
} from "@/lib/training/adaptateurs-ia";
import { separerDonnees } from "@/lib/training/synthetique";

/**
 * BANC DE TEST INTERNE — exigence produit : gen3 entraîne un modèle À LA
 * DEMANDE puis le TESTE DIRECTEMENT EN INTERNE, avant tout usage. Le banc
 * sépare les données en train/test (mélange seedé), entraîne sur le train,
 * ÉVALUE, et prononce un verdict honnête contre des seuils explicites par
 * famille :
 *
 *   - cortex-langagier : rappel exact ≥ 0.9 — évalué sur le TRAIN (mémoire
 *     de rétention : le banc vérifie que l'entraînement a RÉELLEMENT pris ;
 *     le rappel flou de questions inédites n'est pas la promesse du cortex) ;
 *   - tenseur-mlp      : exactitude argmax ≥ 0.9 — évaluée sur le TEST
 *     (généralisation sur des vecteurs jamais vus) ;
 *   - onde-rpia        : cibles test convergées rapides (erreur < 0.15) ≥ 0.8
 *     — cibles jamais vues (apprentissabilité).
 *
 * Un verdict « insuffisant » n'est PAS une erreur : c'est un résultat
 * mesuré — gen3 l'assume et propose d'allonger l'entraînement ou les
 * données plutôt que de déclarer un modèle prêt à tort.
 */

export const SEUILS_BANC_TEST: Record<string, number> = {
  "cortex-langagier": 0.9,
  "tenseur-mlp": 0.9,
  "onde-rpia": 0.8,
};

export interface RapportTestInterne {
  famille: string;
  trainCount: number;
  testCount: number;
  /** Ensemble effectivement évalué (test = généralisation, train = rétention). */
  evaluationEchantillon: "train" | "test";
  /** Métrique principale de la famille (exactitude ou taux de convergence). */
  score: number;
  seuil: number;
  verdict: "conforme" | "insuffisant";
  metriques: Array<{ nom: string; valeur: number }>;
  entrainement: ResultatEntrainementIA;
  evaluation: ResultatEvaluationIA;
  dureeMs: number;
  details: string;
}

/** Exécute le cycle complet : entraîner sur train → évaluer → verdict. */
export async function bancTestInterne(params: {
  adaptateur: AdaptateurEntrainementIA;
  donnees: DonneesEntrainement;
  ratioTest?: number;
  epoques?: number;
  graine?: number;
  pasParCible?: number;
}): Promise<RapportTestInterne> {
  const debut = Date.now();
  const graine = params.graine ?? 20261122;
  const donnees = params.donnees;
  const items: number = donnees.langage?.length ?? donnees.classification?.length ?? donnees.onde?.length ?? 0;
  if (items < 4) {
    throw new Error(
      `Banc de test interne : au moins 4 échantillons requis pour un split train/test honnête (reçu ${items}).`,
    );
  }
  // Split : chaque famille a sa structure propre — on découpe PAR INDEX pour
  // garantir des ensembles disjoints sans connaître le contenu.
  const tailleTest = Math.max(1, Math.floor(items * Math.min(0.5, params.ratioTest ?? 0.25)));
  const indicesTest = new Set(separerDonnees(Array.from({ length: items }, (_, i) => i), tailleTest / items, graine).test);
  const couper = <T>(liste: T[] | undefined): { train: T[]; test: T[] } => {
    if (!liste) return { train: [], test: [] };
    const train: T[] = [];
    const test: T[] = [];
    liste.forEach((item, i) => (indicesTest.has(i) ? test : train).push(item));
    return { train, test };
  };
  const train: DonneesEntrainement = {
    langage: couper(donnees.langage).train,
    classification: couper(donnees.classification).train,
    onde: couper(donnees.onde).train,
  };
  const test: DonneesEntrainement = {
    langage: couper(donnees.langage).test,
    classification: couper(donnees.classification).test,
    onde: couper(donnees.onde).test,
  };

  const entrainement = await params.adaptateur.entrainer(train, { epoques: params.epoques ?? 40 });
  // Échantillon d'évaluation PAR FAMILLE (sémantique honnête).
  const evaluerSurTest = params.adaptateur.famille !== "cortex-langagier";
  const evaluation = await params.adaptateur.evaluer(evaluerSurTest ? test : train, {
    pasParCible: params.pasParCible,
  });

  // Score principal selon la famille (exactitude mesurée OU taux de convergence RPIA).
  const famille = params.adaptateur.famille;
  const seuil = SEUILS_BANC_TEST[famille] ?? 0.9;
  const score =
    famille === "onde-rpia"
      ? (evaluation.metriques.find((m) => m.nom === "cibles_convergees_rapide")?.valeur ?? 0)
      : (evaluation.exactitude ?? 0);
  const verdict: RapportTestInterne["verdict"] = score >= seuil ? "conforme" : "insuffisant";
  const testCount = evaluation.echantillons;
  return {
    famille,
    trainCount: items - testCount,
    testCount,
    evaluationEchantillon: evaluerSurTest ? "test" : "train",
    score: Number(score.toFixed(4)),
    seuil,
    verdict,
    metriques: evaluation.metriques,
    entrainement,
    evaluation,
    dureeMs: Date.now() - debut,
    details:
      verdict === "conforme"
        ? `Test interne CONFORME (${evaluerSurTest ? "généralisation sur test" : "rétention du train"}) : score ${score.toFixed(3)} ≥ seuil ${seuil} sur ${testCount} échantillon(s).`
        : `Test interne INSUFFISANT (${evaluerSurTest ? "généralisation sur test" : "rétention du train"}) : score ${score.toFixed(3)} < seuil ${seuil} sur ${testCount} échantillon(s) — allonger l'entraînement ou agrandir le dataset, ne PAS déployer ce modèle.`,
  };
}
