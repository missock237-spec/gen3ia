import "server-only";

import type { PaireLangage } from "@/lib/neural/generation/corpus";
import type { TrainingSample } from "@/lib/neural/training/dataset";
import { NeuralTrainer } from "@/lib/neural/training/trainer";
import {
  getNeuralRuntime,
  sauvegarderCerveauRuntime,
  type NeuralRuntime,
} from "@/lib/neural/runtime";

/**
 * L'ENTRAÎNEUR AUTO — applique la matière ingérée depuis les hubs au
 * runtime neuronal RÉEL (aucune simulation) :
 *
 *  1. Paires conversationnelles → cortex langagier (`apprendre`, budget
 *     interne de paires personnalisées respecté, doublons déduits) ;
 *  2. Échantillons { text, label } → entraîneur supervisé du SNN
 *     (`NeuralTrainer.train` : plasticité synaptique réelle, accuracies
 *     mesurées sur un jeu de test jamais vu) ;
 *  3. Sauvegarde du cerveau (synapses + registre lexical + état du cortex)
 *     pour que l'apprentissage survive aux redémarrages.
 *
 * Le runtime peut être injecté (tests) ; par défaut le singleton réel est
 * utilisé — le même cerveau que celui qui répond aux utilisateurs.
 */

export interface ResultatEntrainementAuto {
  langage?: {
    pairesAjoutees: number;
    doublons: number;
    vocabulaire: number;
  };
  intention?: {
    echantillons: number;
    epoques: number;
    accuracyTrain: number;
    accuracyTest: number;
    dureeMs: number;
  };
  cerveauSauvegarde: boolean;
}

/** Cap de l'historique d'entraînement conservé en mémoire vive (runtime). */
const HISTORIQUE_RUNTIME_CAP = 50;

export async function appliquerEntrainementAuto(
  apports: {
    paires: readonly PaireLangage[];
    echantillons: readonly TrainingSample[];
    maxEchantillonsParCycle: number;
  },
  runtime?: NeuralRuntime,
): Promise<ResultatEntrainementAuto> {
  const rt = runtime ?? getNeuralRuntime();
  const resultat: ResultatEntrainementAuto = { cerveauSauvegarde: false };

  if (apports.paires.length > 0) {
    // POUR MESURE : la matière hub nourrit la mesure de rétention du Studio,
    // PAS la conversation — les paires hub ne répondent jamais au chat
    // (bug réel : hors-sujets inter-langues pour tous les comptes).
    const stats = rt.cortex.apprendre(apports.paires, {
      personnalisees: true,
      pourMesure: true,
    });
    resultat.langage = {
      pairesAjoutees: stats.pairesAjoutees,
      doublons: stats.pairesDoublons,
      vocabulaire: stats.vocabulaire,
    };
  }

  if (apports.echantillons.length > 0) {
    const retenus = apports.echantillons.slice(0, apports.maxEchantillonsParCycle);
    const entraineur = new NeuralTrainer(rt.reseau, rt.espace, rt.veille, rt.noyau);
    // Deux époques suffisent par cycle : la boucle recommence toutes les
    // heures — l'apprentissage est incrémental, pas monolithique.
    const rapport = await entraineur.train(retenus, { epochs: 2, testRatio: 0.15 });
    rt.historiqueEntrainement.push(rapport);
    if (rt.historiqueEntrainement.length > HISTORIQUE_RUNTIME_CAP) {
      rt.historiqueEntrainement.splice(
        0,
        rt.historiqueEntrainement.length - HISTORIQUE_RUNTIME_CAP,
      );
    }
    resultat.intention = {
      echantillons: retenus.length,
      epoques: rapport.epochs,
      accuracyTrain: rapport.accuracyTrain,
      accuracyTest: rapport.accuracyTest,
      dureeMs: rapport.dureeMs,
    };
  }

  if (resultat.langage || resultat.intention) {
    resultat.cerveauSauvegarde = await sauvegarderCerveauRuntime();
  }
  return resultat;
}
