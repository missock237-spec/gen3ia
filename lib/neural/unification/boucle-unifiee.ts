/**
 * BOUCLE D'APPRENTISSAGE UNIFIÉE SNN / RPIA / LANGAGE (LOT 4 — unification
 * de l'apprentissage neuronal, mission « GEN3IA BRAIN COMPLETION »).
 *
 * AVANT : trois entraînements séparés — le trainer SNN (training/trainer.ts,
 * plasticité synaptique), l'entraîneur RPIA (lib/ondes, résonance d'ondes)
 * et le cortex langagier (paires). Une même connaissance ne nourrissait pas
 * les trois couches de façon cohérente et mesurée.
 *
 * CETTE BOUCLE : pour chaque connaissance (question → réponse) —
 *  1. LANGAGE : la paire est enregistrée dans le cortex (répond au chat) ;
 *  2. SNN : échantillon (texte→label) entraîné par plasticité synaptique ;
 *  3. RPIA : la question est encodée en onde cible (encodeur lexical
 *     ondulatoire — vecteur partagé entre mots/trigrammes) et la couche
 *     d'ondes résonne vers elle (erreur mesurée avant/après) ;
 *  puis des PROBES PARTAGÉES mesurent la cohérence des trois couches sur
 *  les MÊMES sondes (langage : recouvrement des réponses réelles ; SNN :
 *  accuracies du rapport réel ; RPIA : erreur de résonance réelle).
 *
 * Les ports sont injectables : les tests unitaires fournissent des doubles
 * fidèles, l'intégration utilise les COMPOSANTS RÉELS du runtime
 * (creerPortsReels). Aucune donnée n'est prétendue : le rapport reflète
 * exactement ce que les couches ont mesuré.
 */

import { encoderTexteLexicalEnOnde } from "../brain/encodeur-lexical-ondulatoire";
import { racineLegere } from "../generation/language";
import { EntraineurRPIA } from "../../ondes/entrainement-rpia";
import { RPIA_DEFAUTS, calculerTempsGlobalRPIA, type RapportEntrainement } from "../../ondes/types-entrainement";
import type { TrainingSample } from "../training/dataset";

/** Une connaissance à unifier (question → réponse, label SNN optionnel). */
export interface ConnaissanceUnifiee {
  question: string;
  reponse: string;
  /** Label SNN (défaut : « connaissance » — pools d'intention). */
  label?: string;
}

/** Une sonde partagée (évaluée sur les trois couches). */
export interface SondeUnifiee {
  question: string;
  attendu: string;
}

/** Ports des trois couches (réels en production, doubles en test unitaire). */
export interface PortsUnification {
  langage: {
    apprendre: (paires: ReadonlyArray<{ motif: string; reponse: string; theme: string }>) => { pairesAjoutees: number; pairesDoublons?: number };
    repondre: (requete: string) => string | null;
  };
  snn: {
    entrainer: (samples: TrainingSample[], epochs: number) => Promise<{ accuracyTrain: number; accuracyTest: number; epochs: number }>;
  };
  rpia: {
    /** Encode un texte en onde cible — À LA TAILLE DE SA COUCHE (nbNoeuds). */
    encoder: (texte: string) => Float32Array;
    /** Résonne vers l'onde cible du texte ; retourne le rapport réel. */
    entrainer: (cible: Float32Array, epoques: number) => RapportEntrainement;
    /** MESURE sans apprentissage (l'état « avant » ne doit pas muter la couche). */
    mesurer: (cible: Float32Array) => number;
  };
}

/** Rapport unifié d'une passe (données 100 % mesurées). */
export interface RapportUnifie {
  connaissancesTraitees: number;
  langage: { pairesAjoutees: number; doublons: number };
  snn: { epochs: number; accuracyTrain: number; accuracyTest: number; echantillons: number };
  rpia: {
    erreurAvantMoyenne: number;
    erreurApresMoyenne: number;
    /** Nombre de cibles dont la résonance a CONVERGÉ (mesure de la couche). */
    convergences: number;
    /**
     * DISCRIMINABILITÉ mesurée à temps global constant : |err(A) − err(B)|
     * entre deux textes distincts après la passe (>0 = la couche encode la
     * différence — propriété documentée du pont-chat). Mesurée honnêtement,
     * jamais prétendue.
     */
    discriminabilite: number | null;
  };
  probes: {
    taille: number;
    /** Score langage moyen (recouvrement lexical des réponses réelles). */
    langage: number;
  };
  /** Durée réelle de la passe (ms). */
  dureeMs: number;
}

/** Recouvrement lexical borné (racines — cohérent avec le cortex). */
function recouvrement(a: string, b: string): number {
  const racines = (t: string) => new Set(tokeniseRacines(t));
  const ensA = racines(a);
  const ensB = racines(b);
  if (ensA.size === 0 || ensB.size === 0) return 0;
  let inter = 0;
  for (const x of ensA) if (ensB.has(x)) inter += 1;
  return inter / (ensA.size + ensB.size - inter);
}

function tokeniseRacines(texte: string): string[] {
  return texte
    .toLowerCase()
    .split(/[^a-zàâäéèêëîïôöùûüç0-9]+/)
    .filter((m) => m.length >= 4)
    .map(racineLegere);
}

/** Options de la boucle (bornes de ressources — RAM 2 cœurs). */
export interface OptionsBoucleUnifiee {
  epochsSnn?: number;
  epoquesRPIA?: number;
  /** Max de connaissances par passe (backpressure). */
  maxConnaissances?: number;
}

/** LA BOUCLE UNIFIÉE — une passe, trois couches, des mesures réelles. */
export async function boucleUnifiee(
  connaissances: readonly ConnaissanceUnifiee[],
  ports: PortsUnification,
  sondes: readonly SondeUnifiee[],
  options: OptionsBoucleUnifiee = {},
): Promise<RapportUnifie> {
  const debut = Date.now();
  const epochsSnn = Math.max(1, options.epochsSnn ?? 2);
  const epoquesRPIA = Math.max(1, options.epoquesRPIA ?? 20);
  const retenues = connaissances.slice(0, options.maxConnaissances ?? 50).filter(
    (c) => c.question.trim().length >= 4 && c.reponse.trim().length >= 4,
  );
  if (retenues.length === 0) {
    throw new Error("aucune connaissance exploitable — boucle unifiée refusée (jamais prétendre)");
  }

  // État RPIA AVANT (mesure SANS apprentissage — la couche n'est pas mutée).
  const erreurRPIA = (): number => {
    if (sondes.length === 0) return NaN;
    let somme = 0;
    for (const s of sondes.slice(0, 20)) {
      somme += ports.rpia.mesurer(ports.rpia.encoder(s.question));
    }
    return somme / Math.min(sondes.length, 20);
  };
  const erreurAvant = erreurRPIA();

  // 1) LANGAGE — les paires entrent au cortex.
  let ajoutees = 0;
  let doublons = 0;
  for (const c of retenues) {
    const stats = ports.langage.apprendre([
      { motif: c.question.slice(0, 400), reponse: c.reponse.slice(0, 1_200), theme: "unifiee:lot4" },
    ]);
    ajoutees += stats.pairesAjoutees;
    doublons += stats.pairesDoublons ?? 0;
  }

  // 2) SNN — échantillons texte→label (plasticité synaptique réelle).
  const echantillons: TrainingSample[] = retenues.map((c) => ({
    text: c.question.slice(0, 400),
    label: c.label ?? "connaissance",
  }));
  const rapportSnn = await ports.snn.entrainer(echantillons, epochsSnn);

  // 3) RPIA — résonance vers les ondes cibles des questions (encodées par
  // le port à SA propre taille — la boucle n'impose rien aux couches).
  let sommeAvant = 0;
  let sommeApres = 0;
  for (const c of retenues) {
    const cible = ports.rpia.encoder(c.question);
    const rapport = ports.rpia.entrainer(cible, epoquesRPIA);
    sommeAvant += rapport.erreurInitiale;
    sommeApres += rapport.erreurFinale;
  }
  const erreurApres = retenues.length > 0 ? sommeApres / retenues.length : NaN;
  const erreurAvantMoy = retenues.length > 0 ? sommeAvant / retenues.length : NaN;

  // CONVERGENCES : combien de cibles réellement convergées — honnête :
  // peut être 0 (oscillation naturelle, cf. le métabolisme documenté de
  // la couche RPIA). Une cible est comptée convergée si sa MESURE à temps
  // constant est strictement inférieure à l'erreur moyenne d'après-passe.
  let convergences = 0;
  for (const c of retenues) {
    const cible = ports.rpia.encoder(c.question);
    const erreurMesuree = ports.rpia.mesurer(cible);
    if (Number.isFinite(erreurMesuree) && erreurMesuree < erreurApres) convergences += 1;
  }

  // DISCRIMINABILITÉ (temps global constant) : deux textes distincts
  // produisent-ils des erreurs distinctes après la passe ?
  let discriminabilite: number | null = null;
  if (sondes.length >= 2) {
    const errA = ports.rpia.mesurer(ports.rpia.encoder(sondes[0].question));
    const errB = ports.rpia.mesurer(ports.rpia.encoder(sondes[1].question));
    discriminabilite = Math.round(Math.abs(errA - errB) * 1e4) / 1e4;
  }

  // PROBES PARTAGÉES — le langage est mesuré sur les MÊMES sondes.
  let scoreLangage = NaN;
  if (sondes.length > 0) {
    let somme = 0;
    for (const s of sondes.slice(0, 20)) {
      const reponse = ports.langage.repondre(s.question);
      somme += reponse ? recouvrement(s.attendu, reponse) : 0;
    }
    scoreLangage = Math.round((somme / Math.min(sondes.length, 20)) * 1000) / 1000;
  }

  return {
    connaissancesTraitees: retenues.length,
    langage: { pairesAjoutees: ajoutees, doublons },
    snn: {
      epochs: rapportSnn.epochs,
      accuracyTrain: rapportSnn.accuracyTrain,
      accuracyTest: rapportSnn.accuracyTest,
      echantillons: echantillons.length,
    },
    rpia: {
      erreurAvantMoyenne: Number.isFinite(erreurAvant) ? Math.round(erreurAvant * 1e4) / 1e4 : erreurAvantMoy,
      erreurApresMoyenne: Number.isFinite(erreurApres) ? Math.round(erreurApres * 1e4) / 1e4 : NaN,
      convergences,
      discriminabilite,
    },
    probes: { taille: sondes.length, langage: scoreLangage },
    dureeMs: Date.now() - debut,
  };
}

/** FABRIQUE les ports RÉELS à partir du runtime Gen3 (intégration/prod). */
export async function creerPortsReels(options: { nbNoeudsRPIA?: number } = {}): Promise<PortsUnification> {
  const mod = await import("../runtime");
  const rt = mod.getNeuralRuntime();
  const { NeuralTrainer } = await import("../training/trainer");
  const nbNoeuds = options.nbNoeudsRPIA ?? Math.min(256, Math.max(16, rt.reseau.getStats().nbNeurones));
  const entraineurRPIA = new EntraineurRPIA(nbNoeuds);
  const trainer = new NeuralTrainer(rt.reseau, rt.espace, rt.veille, rt.noyau);
  return {
    langage: {
      apprendre: (paires) => {
        const stats = rt.cortex.apprendre(paires, { personnalisees: true });
        return { pairesAjoutees: stats.pairesAjoutees, pairesDoublons: stats.pairesDoublons };
      },
      repondre: (requete) => rt.cortex.repondre(requete, {}, { inclureMesure: true })?.texte ?? null,
    },
    snn: {
      entrainer: async (samples, epochs) => {
        const rapport = await trainer.train(samples, { epochs, testRatio: 0.15 });
        return { accuracyTrain: rapport.accuracyTrain, accuracyTest: rapport.accuracyTest, epochs: rapport.epochs };
      },
    },
    rpia: {
      encoder: (texte) => encoderTexteLexicalEnOnde(texte, nbNoeuds),
      entrainer: (cible, epoques) => entraineurRPIA.entrainer(cible, epoques),
      mesurer: (cible) => entraineurRPIA.erreurCourante(cible, calculerTempsGlobalRPIA(RPIA_DEFAUTS, 0)),
    },
  };
}

/** Métrique de surface (laboratoire, LOT 7). */
export function surfaceUnification(): { couches: number; borneMaxConnaissances: number } {
  return { couches: 3, borneMaxConnaissances: 50 };
}
