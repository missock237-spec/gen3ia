import "server-only";

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  chargerWebdev,
  couvertureLexicaleWebdev,
  repartitionWebdev,
  versEchantillonsSNN,
  versPairesCortex,
  LABEL_WEBDEV,
  type EchantillonWebdev,
} from "./webdev";
import { NeuralTrainer, enregistrerPoolsDomaines } from "./trainer";
import {
  construireSignaturesDomaines,
  chargerEchantillonsDomaines,
  DOMAINES_GEN3,
} from "./domaines";
import { getNeuralRuntime, sauvegarderCerveauRuntime, type NeuralRuntime } from "../runtime";
import type { PaireLangage } from "../generation/corpus";
import { evaluerRetentionCortex } from "@/lib/entrainement-auto/maitrise";

/**
 * ORCHESTRATEUR D'ENTRAÎNEMENT WEB-DEV — fait de Gen3ia un développeur web.
 *
 * Exécute le cycle complet sur le corpus du pack gen3-webdev-pack
 * (des millions de lignes bilingues : création de SaaS, sites web, projets
 * de développement, API, authentification, données, UI, déploiement, tests) :
 *
 *   1. CHARGEMENT streaming du dataset (plafond configurable) ;
 *   2. ENTRAÎNEMENT SNN RÉEL — plasticité supervisée vers le pool
 *      DOM_DEVELOPPEMENT_WEB (trainDomaines), avec les échantillons commis
 *      des 17 AUTRES domaines comme négatifs — l'accuracy mesurée est une
 *      DISCRIMINATION réelle sur un jeu tenu à l'écart (jamais estimée) ;
 *   3. CORTEX LANGAGIER — paires { motif → réponse structurée } apprises
 *      par lots (idempotent : les motifs déjà connus sont ignorés), rétention
 *      mesurée sur des paires apprises ;
 *   4. PERSISTANCE du cerveau et rapport HONNÊTE écrit sur disque.
 *
 * Idempotent et ré-exécutable : après chaque redémarrage du process (le
 * cortex langagier n'applique que son corpus d'amorçage), un nouvel appel
 * ré-ingère la matière dev (les millions de lignes restent sur disque).
 */

export interface OptionsEntrainementWebdev {
  /** Échantillons SNN web-dev (défaut 2 000 — RÉGIME ÉQUILIBRÉ avec les
   *  négatifs des 17 autres domaines : c'est le régime où la plasticité
   *  supervisée apprend, cf. trainer-domaines.test.ts). */
  plafondSnn?: number;
  /** Paires langagières saupoudrées dans le cortex (défaut 40 000). */
  plafondCortex?: number;
  /** Époques SNN (défaut 3). */
  epoques?: number;
  /** Fraction test du SNN (défaut 0.15). */
  testRatio?: number;
  /** Réécrire le rapport même si vide (défaut true). */
  ecrireRapport?: boolean;
  /** Runtime injectable (tests) — le runtime singleton par défaut. */
  runtime?: NeuralRuntime;
}

export interface RapportEntrainementWebdev {
  v: 1;
  dateA: string;
  /** « termine » : SNN + cortex entraînés ; « partiel » : une seule des deux
   *  phases ; « echec » : rien d'ingéré (message explicite). */
  statut: "termine" | "partiel" | "echec";
  message: string;
  /** Source réellement chargée (chemin relatif) et volume total lu. */
  source: string;
  lignesLues: number;
  /** SNN — métriques RÉELLES du trainer (discrimination parmi 18 domaines). */
  snn: {
    echantillons: number;
    epoques: number;
    accuracyTrain: number;
    accuracyTest: number;
    dureeMs: number;
  } | null;
  /** Cortex langagier — stats réelles d'ingestion + rétention mesurée. */
  cortex: {
    pairesProposees: number;
    pairesAjoutees: number;
    doublons: number;
    vocabulaire: number;
    totalPaires: number;
    /** RÉTENTION mesurée sur des paires apprises. */
    retention: { accuracy: number; unites: number } | null;
  } | null;
  /** Couverture du corpus (diagnostic, pas une métrique de maîtrise). */
  couverture: {
    parTache: Record<string, number>;
    parLangue: Record<string, number>;
    tokensDistincts: number;
  };
  cerveauSauvegarde: boolean;
  dureeMs: number;
}

const CHEMIN_RAPPORT = path.join(process.cwd(), "var/neural/webdev/rapport.json");

/** Taille des lots du cortex (rend la main à l'event loop régulièrement). */
const LOT_CORTEX = 5_000;

export async function entrainerDeveloppementWeb(
  opts: OptionsEntrainementWebdev = {},
): Promise<RapportEntrainementWebdev> {
  const debut = Date.now();
  const plafondSnn = opts.plafondSnn ?? 2_000;
  const plafondCortex = opts.plafondCortex ?? 40_000;
  const epoques = opts.epoques ?? 3;
  const testRatio = opts.testRatio ?? 0.15;

  // 1. CHARGEMENT streaming (dataset complet si généré, échantillons sinon).
  //    Plafond = les DEUX lots (SNN puis cortex) prélevés dans le même
  //    échantillon aléatoire (le générateur écrit en ordre mélangé).
  const charge = await chargerWebdev({ plafond: plafondSnn + plafondCortex });
  const couverture = repartitionWebdev(charge.echantillons);

  const rapport: RapportEntrainementWebdev = {
    v: 1,
    dateA: new Date().toISOString(),
    statut: "echec",
    message: "",
    source: charge.source,
    lignesLues: charge.totalLu,
    snn: null,
    cortex: null,
    couverture: {
      parTache: couverture.parTache,
      parLangue: couverture.parLangue,
      tokensDistincts: couvertureLexicaleWebdev(charge.echantillons),
    },
    cerveauSauvegarde: false,
    dureeMs: 0,
  };

  if (charge.echantillons.length === 0) {
    rapport.message =
      "Aucune donnée web-dev disponible (ni dataset complet, ni échantillons commis). Exécuter le générateur du pack gen3-webdev-pack.";
    await persisterRapport(rapport, opts.ecrireRapport !== false);
    return rapport;
  }

  const rt = opts.runtime ?? getNeuralRuntime();

  // 2. ENTRAÎNEMENT SNN réel — pool DOM_DEVELOPPEMENT_WEB.
  //
  // Les échantillons web-dev sont transformés en TEXTES SIGNATURES
  // (texteEntrainement — max 6 ancres) : les instructions brutes saturent
  // la zone d'entrée du SNN et l'accuracy s'effondre au hasard.
  //
  // DISCRIMINATION HONNÊTE : le lot web-dev est mélangé aux échantillons
  // commis des 17 AUTRES domaines (négatifs, texte signature identique) —
  // l'accuracy mesurée est la capacité du SNN à RECONNAÎTRE le domaine web
  // parmi les 18, pas seulement à l'activer.
  const signatures = await construireSignaturesDomaines({ complet: false });
  const lotWebdevBrut = charge.echantillons.slice(0, plafondSnn);
  const lotWebdev = versEchantillonsSNN(lotWebdevBrut, signatures);
  // Amorçage lexical : le vocabulaire noyau du domaine web est en jeu.
  const ancresWebdev = signatures.parLabel[LABEL_WEBDEV] ?? [];
  const amorcage = ancresWebdev.map((motCle) => ({ text: motCle, label: LABEL_WEBDEV }));

  const autresDomaines = DOMAINES_GEN3
    .map((d) => d.id)
    .filter((id) => id !== "developpement_web");
  const negatifs = await chargerEchantillonsDomaines({
    domaines: autresDomaines,
    maxParDomaine: 150,
    complet: false,
  });

  const lotSnn = [...lotWebdev, ...amorcage, ...negatifs.samples];
  if (lotSnn.length === 0) {
    rapport.message =
      "Aucun échantillon web-dev avec token signature (honnêteté : rien à entraîner).";
    await persisterRapport(rapport, opts.ecrireRapport !== false);
    return rapport;
  }
  try {
    enregistrerPoolsDomaines(rt.espace);
    const entraineur = new NeuralTrainer(rt.reseau, rt.espace, rt.veille, rt.noyau);
    const rapportSnn = await entraineur.trainDomaines(lotSnn, { epochs: epoques, testRatio });
    rapport.snn = {
      echantillons: rapportSnn.samples,
      epoques: rapportSnn.epochs,
      accuracyTrain: rapportSnn.accuracyTrain,
      accuracyTest: rapportSnn.accuracyTest,
      dureeMs: rapportSnn.dureeMs,
    };
  } catch (erreur) {
    rapport.message = `Entraînement SNN échoué : ${erreur instanceof Error ? erreur.message : String(erreur)}`;
    await persisterRapport(rapport, opts.ecrireRapport !== false);
    return rapport;
  }

  // 3. CORTEX LANGAGIER — paires par lots (idempotent). Le lot cortex est
  //    prélevé APRÈS le lot SNN dans l'échantillon chargé (aucun recouvrement).
  //    La RÉTENTION est mesurée sur un sous-ensemble des paires INGÉRÉES :
  //    « le cortex retient-il ce qu'il vient d'apprendre ? » (même
  //    sémantique que la boucle de maîtrise — maitrise.ts).
  const matiereCortex = charge.echantillons.slice(
    plafondSnn,
    plafondSnn + plafondCortex,
  );
  const matiereBrute = matiereCortex.length > 0 ? matiereCortex : charge.echantillons.slice(0, plafondCortex);
  const UNITES_VALIDATION = 150;
  const echantillonsIngestion = matiereBrute.slice(0, Math.max(0, matiereBrute.length - UNITES_VALIDATION));
  const echantillonsRappel = matiereBrute.slice(Math.max(0, matiereBrute.length - UNITES_VALIDATION));
  const paires: PaireLangage[] = versPairesCortex(
    echantillonsIngestion.length > 0 ? echantillonsIngestion : matiereBrute,
  );
  const pairesRappel = versPairesCortex(
    echantillonsRappel.length > 0 ? echantillonsRappel : matiereBrute.slice(0, UNITES_VALIDATION),
    1400,
  );
  let cortex = rapport.cortex;
  try {
    for (let i = 0; i < paires.length; i += LOT_CORTEX) {
      const lot = paires.slice(i, i + LOT_CORTEX);
      const stats = rt.cortex.apprendre(lot, { pourMesure: false });
      cortex = {
        pairesProposees: (cortex?.pairesProposees ?? 0) + lot.length,
        pairesAjoutees: (cortex?.pairesAjoutees ?? 0) + stats.pairesAjoutees,
        doublons: (cortex?.doublons ?? 0) + stats.pairesDoublons,
        vocabulaire: stats.vocabulaire,
        totalPaires: stats.totalPaires,
        retention: cortex?.retention ?? null,
      };
    }
    // RÉTENTION MESURÉE sur des paires INGÉRÉES (le cortex répond-il avec
    // la matière web-dev qu'il vient d'apprendre ? — métrique honnête du
    // langage, même sémantique que la boucle de maîtrise).
    const retention = evaluerRetentionCortex(rt.cortex, pairesRappel);
    cortex = {
      ...(cortex as NonNullable<typeof cortex>),
      retention: { accuracy: retention.accuracy, unites: retention.unites },
    };
    rapport.cortex = cortex;
  } catch (erreur) {
    rapport.cortex = cortex;
    rapport.message = `Entraînement SNN réussi mais ingestion cortex partielle : ${erreur instanceof Error ? erreur.message : String(erreur)}`;
    rapport.statut = "partiel";
    // 4. Persistance du cerveau (SNN a appris même si le cortex a échoué).
    rapport.cerveauSauvegarde = await sauvegarderCerveauRuntime().catch(() => false);
    rapport.dureeMs = Date.now() - debut;
    await persisterRapport(rapport, opts.ecrireRapport !== false);
    return rapport;
  }

  rapport.statut = rapport.snn && rapport.cortex ? "termine" : "partiel";
  const retention = rapport.cortex?.retention;
  rapport.message =
    `Web-dev : ${lotWebdev.length + amorcage.length} échantillons web-dev (+${negatifs.samples.length} négatifs des 17 autres domaines) entraînés — discrimination test ${(100 * (rapport.snn?.accuracyTest ?? 0)).toFixed(1)} % — et ${rapport.cortex?.pairesAjoutees ?? 0} paires de développement web apprises par le cortex, rétention ${(100 * (retention?.accuracy ?? 0)).toFixed(1)} % sur ${retention?.unites ?? 0} paires apprises (corpus gen3-webdev-pack, ${charge.totalLu.toLocaleString("fr-FR")} lignes lues).`;

  // 4. Persistance du cerveau (les deux phases ont appris).
  rapport.cerveauSauvegarde = await sauvegarderCerveauRuntime().catch(() => false);
  rapport.dureeMs = Date.now() - debut;
  await persisterRapport(rapport, opts.ecrireRapport !== false);
  return rapport;
}

/** Écrit le rapport sur disque (var/neural/webdev/rapport.json). */
async function persisterRapport(rapport: RapportEntrainementWebdev, ecrire: boolean): Promise<void> {
  if (!ecrire) return;
  try {
    await mkdir(path.dirname(CHEMIN_RAPPORT), { recursive: true });
    await writeFile(CHEMIN_RAPPORT, JSON.stringify(rapport, null, 2), "utf8");
  } catch {
    // Écriture de rapport non bloquante : le retour de fonction reste la
    // vérité (le rapport est aussi renvoyé à l'appelant).
  }
}

/** Lit le dernier rapport persisté (null si absent — jamais inventé). */
export async function lireRapportWebdev(): Promise<RapportEntrainementWebdev | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const brut = await readFile(CHEMIN_RAPPORT, "utf8");
    return JSON.parse(brut) as RapportEntrainementWebdev;
  } catch {
    return null;
  }
}

/** Export du label pour les surfaces d'affichage (admin, observabilité). */
export { LABEL_WEBDEV };
export type { EchantillonWebdev };
