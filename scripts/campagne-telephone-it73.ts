/**
 * CAMPAGNE TÉLÉPHONE it.73 — sobriété énergétique (100 % locale, zéro
 * service IA externe, mêmes outils que la production).
 *
 * DEMANDE PROPRIÉTAIRE : « cherche un moyen de diminuer la consommation
 * d'énergie de gen3 tout en gardant sa qualité de réponse et son
 * efficacité pour que gen3 puisse fonctionner même sur un téléphone tout
 * en gardant sa qualité de compétences ».
 *
 * PROTOCOLE (mesuré, jamais estimé) :
 *  1. SUPERVISION EOD — cortex compact 2^17 (131 072 colonnes, seed 42,
 *     homéostasie ON, budget 6.0 — config production) entraîné PAR ONDES
 *     (entrainerDomainesParOndes, mécanique it.57/63 INCHANGÉE) sur la
 *     matière charte-ancrée : 2 vagues × 2 000 gabarits/domaine (it.72).
 *  2. ALIGNEMENT INFÉRENCE — l'inférence de chat (et du téléphone)
 *     projette le texte par HASH (projetterTokens) alors que l'EOD
 *     injecte par colonnes DÉRIVÉES DES ONDES : la phase 2 re-supervise
 *     la matière (questions canoniques + charte + gabarits) avec les
 *     MÊMES colonnes hash que l'inférence utilisera (même mécanique de
 *     plasticité supervisée que le trainer — déclaré, mesuré, séparé).
 *  3. SONDE (convention production chat) — par domaine : questions
 *     canoniques FR/EN + gabarits NON supervisés → projection hash →
 *     4 pas → résonance de spikes CUMULÉE par bande sur la fenêtre +
 *     lecture graduée du dernier pas. COMPARAISON cortex entraîné vs
 *     cortex NEUF (même seed, zéro supervision) : le signal appris est
 *     le RATIO mesuré, publié tel quel.
 *  4. QUANTIFICATION u8 — poids → Uint8Array (erreur ≤ 1/510), snapshot
 *     binaire committé ; les MÊMES sondes à travers le moteur EMBARQUÉ
 *     (CortexTelephone : u8 déquantifié à la volée, lecture seule) →
 *     accord f32↔u8.
 *  5. MESURES ÉNERGIE — mémoires réelles (typed arrays) plein 2^20 /
 *     eco 2^20 / téléphone 2^17 ; coût structurel d'une fenêtre
 *     neuronale serveur à 2^20 (cortex neuf seedé, mesuré localement) ;
 *     taille du snapshot (téléchargement unique, cacheable).
 *
 * HONNÊTETÉ : la détection de domaine en production est le pont lexical
 * (predireDomaineVocation) — exécutée à l'identique sur le téléphone :
 * la qualité de réponse est conservée PAR CONSTRUCTION. La sonde NEURALE
 * mesure la résonance des bandes-porteuses (8 bandes du vocabulaire
 * d'ondes, 19 domaines répartis par hash : des domaines partagent une
 * bande — ce n'est PAS une détection de domaine). Les ratios faibles
 * sont publiés tels quels.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import { CortexTelephone } from "../lib/neural/core/v2/cortex-telephone";
import {
  erreurMaxQuantisation,
  estimerMemoireCortexOctets,
  exporterSnapshotTelephone,
  importerSnapshotTelephone,
  quantiserPoidsU8,
} from "../lib/neural/core/v2/energie";
import {
  bandeDuDomaine,
  entrainerDomainesParOndes,
  porteurBande,
} from "../lib/neural/training/entrainement-ondes";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { texteDomaine } from "../lib/gen3/gabarits-domaines";
import { CORPUS_QUESTIONS_VOCATION } from "../lib/gen3/corpus-questions";
import { DOMAINES_VOCATION } from "../lib/gen3/vocation";

const COLONNES_TELEPHONE = 131072; // 2^17
const ECHANTILLONS_GABARITS = 2000; // par vague EOD et par domaine
const GABARITS_ALIGNEMENT = 500; // phase 2, par domaine
const CYCLES_SONDE = 4; // fenêtre de chat (NEURAL_CYCLES_PAR_GENERATION)
const GRAINE = 42;

function horodatage(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " (UTC)";
}

/** Arrondi métrique (6 décimales — jamais un arrondi au maquillage). */
function m6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Surface minimale commune entre la classe de production et le moteur embarqué. */
interface MoteurSonde {
  reinitialiserEnergies(): void;
  projetterTokens(tokens: string[]): Array<[number, number]>;
  pas(injections: Array<[number, number]> | null, t: number): number[];
  activationBandes(): number[];
  resonanceBandes(): number[];
}

interface ResultatSonde {
  texte: string;
  bandeAttendue: number;
  argmaxBande: number;
  /** Activation d'ÉNERGIE cumulée de la bande attendue sur la fenêtre
   *  (somme des 4 pas de la lecture graduée — le signal porté par les
   *  poids trained se transporte au cycle 1). */
  activationCumuleePorteur: number;
  /** Activation cumulée de la bande argmax [0..8). */
  activationCumuleeArgmax: number;
  /** Résonance de spikes cumulée (publiée telle quelle — faible par
   *  physique du substrat : une arête ≤ 1.0 × 0.9 < seuil 1.0). */
  resonanceSpikesCumulee: number;
  transmissions: number;
  evaluees: number;
  spikes: number;
  ms: number;
}

/** Sonde en convention production : projection hash, 4 pas, métabolisme capté dans la boucle. */
function sonder(
  moteur: MoteurSonde & {
    metabolismeDernierPas: { transmissions: number; evaluees: number; ms: number };
  },
  texte: string,
  bandeAttendue: number,
  horlogeDepart: number,
): ResultatSonde {
  moteur.reinitialiserEnergies();
  const injections = moteur.projetterTokens(tokenize(texte));
  const activationCumulee = new Array(8).fill(0) as number[];
  const resonanceCumulee = new Array(8).fill(0) as number[];
  let transmissions = 0;
  let evaluees = 0;
  let spikes = 0;
  let ms = 0;
  for (let c = 0; c < CYCLES_SONDE; c++) {
    const sortants = moteur.pas(c === 0 ? injections : null, horlogeDepart + c + 1);
    spikes += sortants.length;
    transmissions += moteur.metabolismeDernierPas.transmissions;
    evaluees += moteur.metabolismeDernierPas.evaluees;
    ms += moteur.metabolismeDernierPas.ms;
    const res = moteur.resonanceBandes();
    for (let b = 0; b < 8; b++) resonanceCumulee[b] += res[b] ?? 0;
    const actPas = moteur.activationBandes();
    for (let b = 0; b < 8; b++) activationCumulee[b] += actPas[b] ?? 0;
  }
  let argmax = 0;
  let maxAct = activationCumulee[0] ?? 0;
  for (let b = 1; b < 8; b++) {
    if ((activationCumulee[b] ?? 0) > maxAct) {
      maxAct = activationCumulee[b] ?? 0;
      argmax = b;
    }
  }
  return {
    texte,
    bandeAttendue,
    argmaxBande: argmax,
    activationCumuleePorteur: m6(activationCumulee[bandeAttendue] ?? 0),
    activationCumuleeArgmax: m6(maxAct),
    resonanceSpikesCumulee: m6(resonanceCumulee.reduce((a, b) => a + b, 0)),
    transmissions,
    evaluees,
    spikes,
    ms: m6(ms),
  };
}

async function principal(): Promise<void> {
  console.log("=== CAMPAGNE TÉLÉPHONE it.73 — sobriété énergétique ===");
  console.log(horodatage());

  // ---- 1. CORTEX ENTRAÎNÉ (2^17) -----------------------------------------
  console.log("\n[1] Cortex compact (2^17) + supervision EOD…");
  const cortex = new CortexColumnnaire({
    colonnes: COLONNES_TELEPHONE,
    seed: GRAINE,
    normalisationHomeostatique: true,
  });
  const champ = new ChampCorticalGen3(GRAINE);
  console.log(
    `    ${COLONNES_TELEPHONE} colonnes × ${cortex.config.voisins} voisins = ${cortex.csrCible.length} arêtes — ${cortex.stats().memoireMo} Mo`,
  );

  // Matière charte-ancrée : 4 000 gabarits/domaine (2 vagues × 2 000) +
  // questions canoniques + phrases charte (label/mission/tâches/outils).
  const gabaritsParDomaine = new Map<string, string[]>();
  const alignementParDomaine = new Map<string, string[]>();
  for (const domaine of DOMAINES_VOCATION) {
    const tous: string[] = [];
    for (let i = 0; i < 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT; i++) {
      tous.push(texteDomaine(domaine.id, i));
    }
    gabaritsParDomaine.set(
      domaine.id,
      tous.slice(0, 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT),
    );
    const questions = CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === domaine.id).map((p) => p.question);
    alignementParDomaine.set(domaine.id, [
      domaine.label,
      domaine.mission,
      ...domaine.taches,
      ...domaine.outils,
      ...questions,
      ...tous.slice(2 * ECHANTILLONS_GABARITS, 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT),
    ]);
  }

  const metabolismeEod = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0, normalisations: 0 };
  const vagues: { vague: number; horlogeInitiale: number; echantillons: number }[] = [];
  const debutsHorloges = [0, 200000];
  const tDebut = performance.now();
  for (let vague = 0; vague < 2; vague++) {
    const exemples: { texte: string; domaine: string }[] = [];
    for (const domaine of DOMAINES_VOCATION) {
      const textes = gabaritsParDomaine.get(domaine.id) ?? [];
      const debut = vague * ECHANTILLONS_GABARITS;
      for (let i = debut; i < debut + ECHANTILLONS_GABARITS && i < textes.length; i++) {
        exemples.push({ texte: textes[i]!, domaine: domaine.id });
      }
    }
    const rapport = entrainerDomainesParOndes(cortex, champ, exemples, {
      cyclesParEchantillon: 3,
      lrBoost: 0.15,
      maxParDomaine: ECHANTILLONS_GABARITS,
      horlogeInitiale: debutsHorloges[vague]!,
    });
    metabolismeEod.evaluees += rapport.metabolisme.evaluees;
    metabolismeEod.reposes += rapport.metabolisme.reposes;
    metabolismeEod.transmissions += rapport.metabolisme.transmissions;
    metabolismeEod.ms = m6(metabolismeEod.ms + rapport.metabolisme.ms);
    metabolismeEod.normalisations += rapport.metabolisme.normalisations;
    vagues.push({
      vague: vague + 1,
      horlogeInitiale: debutsHorloges[vague]!,
      echantillons: rapport.totalEchantillons,
    });
    console.log(
      `    EOD vague ${vague + 1} : ${rapport.totalEchantillons} échantillons, transmissions ${rapport.metabolisme.transmissions}`,
    );
  }

  // ---- 2. ALIGNEMENT INFÉRENCE (colonnes hash = mécanique d'inférence) ---
  // Même mécanique de plasticité que le trainer (pas 2-3a), mais sur les
  // colonnes HASH que l'inférence de chat / du téléphone utilisera.
  console.log("\n[2] Alignement inférence (projection hash, plasticité supervisée)…");
  let horloge = 400000; // monotone > vagues EOD
  const alignement: { echantillons: number; renforts: number } = { echantillons: 0, renforts: 0 };
  for (let epoque = 0; epoque < 2; epoque++) {
    for (const domaine of DOMAINES_VOCATION) {
      const bande = bandeDuDomaine(domaine.id);
      const textes = alignementParDomaine.get(domaine.id) ?? [];
      for (const texte of textes) {
        cortex.reinitialiserEnergies();
        const injections = cortex.projetterTokens(tokenize(texte));
        const stimulees = injections.map(([c]) => c);
        for (let c = 0; c < CYCLES_SONDE; c++) {
          cortex.pas(c === 0 ? injections : null, horloge + c + 1);
        }
        const activation = cortex.activationBandes();
        const concurrentes: number[] = [];
        for (let b = 0; b < activation.length; b++) {
          if (b !== bande && (activation[b] ?? 0) > (activation[bande] ?? 0)) concurrentes.push(b);
        }
        cortex.plasticiteSupervisee(stimulees, bande, 0.15, concurrentes);
        alignement.echantillons += 1;
        horloge += CYCLES_SONDE;
      }
    }
    console.log(`    alignement époque ${epoque + 1} terminée (horloge ${horloge})`);
  }
  // Renforts réellement écrits : comptage des poids à 1.0 (cap) par bande [0..8).
  const parBandeCortex = Math.floor(cortex.config.colonnes / cortex.config.bandes);
  const poidsCapParBande = new Array(8).fill(0) as number[];
  for (let p = 0; p < cortex.csrPoids.length; p++) {
    const cible = cortex.csrCible[p]!;
    const bande = Math.floor(cible / parBandeCortex);
    if (bande < 8 && cortex.csrPoids[p]! >= 1.0) poidsCapParBande[bande] += 1;
  }
  console.log(`    arêtes à cap 1.0 dans les bandes-porteuses [0..8) : ${poidsCapParBande.join(", ")}`);
  const dureeSupervision = m6(performance.now() - tDebut);

  // ---- 3. SONDES (entraîné vs NEUF, même seed) ---------------------------
  console.log("\n[3] Sondes (convention chat, entraîné vs cortex NEUF)…");
  const cortexNeuf = new CortexColumnnaire({
    colonnes: COLONNES_TELEPHONE,
    seed: GRAINE,
    normalisationHomeostatique: true,
  });
  const horlogeSonde = 1_000_000; // loin de toute supervision
  const sondesEntraîne: Record<string, ResultatSonde[]> = {};
  const sondesNeuf: Record<string, ResultatSonde[]> = {};
  for (const domaine of DOMAINES_VOCATION) {
    const bandeAttendue = bandeDuDomaine(domaine.id);
    // Sondes : questions canoniques (supervisées phase 2) + 2 gabarits NON
    // supervisés (généralisation) — les deux familles sont publiées.
    const questions = CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === domaine.id).map((p) => p.question);
    const textes = [
      ...questions,
      texteDomaine(domaine.id, 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT + 1),
      texteDomaine(domaine.id, 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT + 2),
    ];
    sondesEntraîne[domaine.id] = textes.map((t) => sonder(cortex, t, bandeAttendue, horlogeSonde));
    sondesNeuf[domaine.id] = textes.map((t) => sonder(cortexNeuf, t, bandeAttendue, horlogeSonde));
  }

  // ---- 4. QUANTIFICATION u8 + SNAPSHOT + SONDES EMBARQUÉES ---------------
  console.log("\n[4] Quantification u8 + snapshot + sondes embarquées…");
  const poidsU8 = quantiserPoidsU8(cortex.csrPoids);
  const entete = {
    colonnes: cortex.config.colonnes,
    voisins: cortex.config.voisins,
    bandes: cortex.config.bandes,
    bandesLecture: cortex.config.bandesLecture,
    seed: cortex.config.seed,
    seuil: cortex.config.seuil,
    decroissance: cortex.config.decroissance,
    plasticiteFenetre: cortex.config.plasticiteFenetre,
    aretes: cortex.csrCible.length,
  };
  const snapshot = exporterSnapshotTelephone(entete, poidsU8);
  console.log(`    snapshot : ${snapshot.length} octets (${(snapshot.length / 1048576).toFixed(2)} Mo)`);
  const recharge = importerSnapshotTelephone(snapshot);
  const telephone = new CortexTelephone(
    {
      colonnes: recharge.entete.colonnes,
      voisins: recharge.entete.voisins,
      bandes: recharge.entete.bandes,
      bandesLecture: recharge.entete.bandesLecture,
      seed: recharge.entete.seed,
      seuil: recharge.entete.seuil,
      decroissance: recharge.entete.decroissance,
      plasticiteFenetre: recharge.entete.plasticiteFenetre,
    },
    recharge.poidsU8,
  );
  const sondesU8: Record<string, ResultatSonde[]> = {};
  for (const domaine of DOMAINES_VOCATION) {
    const bandeAttendue = bandeDuDomaine(domaine.id);
    const questions = CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === domaine.id).map((p) => p.question);
    const textes = [
      ...questions,
      texteDomaine(domaine.id, 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT + 1),
      texteDomaine(domaine.id, 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT + 2),
    ];
    sondesU8[domaine.id] = textes.map((t) => sonder(telephone, t, bandeAttendue, horlogeSonde));
  }

  // ---- 5. MESURES ÉNERGIE -------------------------------------------------
  console.log("\n[5] Mesures énergie…");
  const memoirePlein = estimerMemoireCortexOctets({
    colonnes: 1048576, voisins: 12, horlogesCompactes: false, poidsU8: false,
  });
  const memoireEco = estimerMemoireCortexOctets({
    colonnes: 1048576, voisins: 12, horlogesCompactes: true, poidsU8: false,
  });
  const statsTelephone = telephone.stats();
  const memoireTelephone = statsTelephone.octetsResidentiels;

  const cortexServeur = new CortexColumnnaire({ seed: GRAINE });
  const questionReelle = "Peux-tu faire une veille sur l'intelligence artificielle ?";
  const serveurSonde = sonder(
    cortexServeur,
    questionReelle,
    bandeDuDomaine("ia-specialisee-emergente"),
    1,
  );
  const serveurMemoireMo = cortexServeur.stats().memoireMo;
  const serveurOctets = cortexServeur.octetsResidentiels();

  // ---- 6. SYNTHÈSE PAR DOMAINE --------------------------------------------
  const parDomaine = DOMAINES_VOCATION.map((domaine) => {
    const ens = sondesEntraîne[domaine.id] ?? [];
    const neuf = sondesNeuf[domaine.id] ?? [];
    const u8 = sondesU8[domaine.id] ?? [];
    const bandeAttendue = bandeDuDomaine(domaine.id);
    const moy = (l: ResultatSonde[], f: (s: ResultatSonde) => number) =>
      l.length ? m6(l.reduce((a, s) => a + f(s), 0) / l.length) : 0;
    const accordsU8 = ens.filter((s, i) => s.argmaxBande === u8[i]?.argmaxBande).length;
    const argmaxAttenduEns = ens.filter((s) => s.argmaxBande === bandeAttendue).length;
    return {
      domaineId: domaine.id,
      bandeAttendue,
      porteur: m6(porteurBande(bandeAttendue)),
      sondes: ens.length,
      activationCumuleeEntraîne: moy(ens, (s) => s.activationCumuleePorteur),
      activationCumuleeNeuf: moy(neuf, (s) => s.activationCumuleePorteur),
      ratioAppris:
        moy(neuf, (s) => s.activationCumuleePorteur) > 0
          ? m6(moy(ens, (s) => s.activationCumuleePorteur) / moy(neuf, (s) => s.activationCumuleePorteur))
          : null,
      resonanceSpikesCumuleeEntraîne: moy(ens, (s) => s.resonanceSpikesCumulee),
      argmaxAttenduEntraîne: argmaxAttenduEns,
      accordArgmaxF32U8: accordsU8,
      transmissionsEntraîne: ens.reduce((a, s) => a + s.transmissions, 0),
      msEntraîne: m6(ens.reduce((a, s) => a + s.ms, 0)),
    };
  });
  const totalSondes = parDomaine.reduce((a, d) => a + d.sondes, 0);
  const totalAccord = parDomaine.reduce((a, d) => a + d.accordArgmaxF32U8, 0);
  const totalAttendu = parDomaine.reduce((a, d) => a + d.argmaxAttenduEntraîne, 0);
  const ratios = parDomaine.map((d) => d.ratioAppris ?? 0);
  const domaineAvecGain = ratios.filter((r) => r > 1).length;

  // ---- 7. ARTEFACT + SNAPSHOT COMMITTÉS -----------------------------------
  const artefact = {
    iteration: 73,
    titre: "Sobriété énergétique — cortex compact embarqué (téléphone)",
    horodatage: horodatage(),
    graine: GRAINE,
    configTelephone: entete,
    supervision: {
      mecanique: "EOD it.57/63 (entrainerDomainesParOndes) inchangée + alignement inférence (projection hash, même plasticité que le trainer — phase déclarée et séparée)",
      matiere: "gabarits it.72 charte-ancrés + questions canoniques + phrases charte",
      vagues,
      totalEchantillonsEod: vagues.reduce((a, v) => a + v.echantillons, 0),
      alignement: { ...alignement, epoques: 2 },
      metabolismeEod,
      poidsCapParBande,
      dureeMs: dureeSupervision,
    },
    sonde: {
      convention: "projection hash (production chat), 4 pas, activation d'ÉNERGIE cumulée par bande (le signal des poids trained se transporte au cycle 1) + résonance de spikes publiée telle quelle",
      horloge: horlogeSonde,
      totalSondes,
      accordArgmaxF32U8: totalAccord,
      tauxAccordF32U8: m6(totalAccord / totalSondes),
      argmaxAttenduEntraîne: totalAttendu,
      domaineAvecGain,
      limites: "19 domaines sur 8 bandes-porteuses (hash) : des domaines partagent une bande — l'argmax de bande n'est PAS une détection de domaine",
    },
    parDomaine,
    energie: {
      memoireOctets: {
        plein_2p20_f64_f32: memoirePlein,
        eco_2p20_u32_f32: memoireEco,
        telephone_2p17_u32_u8: memoireTelephone,
      },
      reductionTelephoneVsPlein: m6(memoirePlein / memoireTelephone),
      reductionEcoVsPlein: m6(memoirePlein / memoireEco),
      erreurMaxQuantisation: erreurMaxQuantisation(),
      snapshotOctets: snapshot.length,
      coutFenetreNeuronaleServeur2p20: {
        note: "cortex NEUF seedé 2^20 config défaut (f64), 4 cycles, question réelle — mesuré localement",
        question: questionReelle,
        transmissions: serveurSonde.transmissions,
        evaluees: serveurSonde.evaluees,
        spikes: serveurSonde.spikes,
        ms: serveurSonde.ms,
        memoireMo: serveurMemoireMo,
        memoireOctetsMesures: serveurOctets,
      },
      telephoneStats: statsTelephone,
    },
    moteur: {
      classe: "CortexTelephone (lib/neural/core/v2/cortex-telephone.ts)",
      structurePartagee: "remplirStructureCSR — identité bit à bit avec la production (garde 42ᵉ)",
      poids: "u8 déquantifié à la volée (×1/255) — aucune copie f32 résidente",
      lectureSeule: true,
    },
    limitesHonnetes: [
      "La sonde NEURALE mesure la résonance des bandes-porteuses (8 bandes du vocabulaire d'ondes) — 19 domaines y sont répartis par hash : des domaines partagent une bande, l'argmax de bande n'est PAS une détection de domaine.",
      "La détection de domaine en production (pont lexical predireDomaineVocation) est exécutée à l'identique sur le téléphone — la qualité de réponse est conservée par construction (même fonction, même charte).",
      "Le poids u8 introduit une erreur ≤ 1/510 par poids — l'accord d'argmax f32↔u8 est mesuré et publié tel quel.",
      "Le coût serveur 2^20 est mesuré sur un cortex NEUF seedé (structure) — l'état appris de production est plus dense ; le chiffre borne le coût structurel d'une fenêtre.",
      "Le moteur embarqué est en lecture seule : le téléphone répond, il ne s'entraîne pas — l'apprentissage reste un rôle du serveur.",
      "La phase d'alignement inférence (projection hash) est une supervision DÉCLARÉE, distincte de l'EOD — sa matière et son métabolisme sont publiés séparément.",
    ],
  };

  const dirAssets = "assets/neural-pretrained";
  const dirPublic = "public/neural";
  mkdirSync(dirAssets, { recursive: true });
  mkdirSync(dirPublic, { recursive: true });
  writeFileSync(join(dirAssets, "cortex-telephone-it73.json"), JSON.stringify(artefact, null, 2));
  writeFileSync(join(dirPublic, "cortex-telephone-it73.bin"), snapshot);

  console.log("\n=== SYNTHÈSE ===");
  console.log(`Sondes : ${totalSondes} · accord argmax f32↔u8 : ${totalAccord}/${totalSondes} (${artefact.sonde.tauxAccordF32U8})`);
  console.log(`Bande attendue gagnante (entraîné) : ${totalAttendu}/${totalSondes} · domaines avec gain > 1 : ${domaineAvecGain}/19`);
  console.log(`Mémoire : plein 2^20 ${memoirePlein} o · éco 2^20 ${memoireEco} o · téléphone 2^17 ${memoireTelephone} o (÷${artefact.energie.reductionTelephoneVsPlein})`);
  console.log(`Fenêtre serveur 2^20 : ${serveurSonde.transmissions} transmissions, ${serveurSonde.evaluees} évaluées, ${serveurSonde.ms} ms`);
  console.log(`Snapshot : ${snapshot.length} octets → public/neural/cortex-telephone-it73.bin`);
  console.log(`Artefact : assets/neural-pretrained/cortex-telephone-it73.json`);
}

principal().catch((erreur) => {
  console.error("CAMPAGNE TÉLÉPHONE it.73 — ÉCHEC :", erreur);
  process.exit(1);
});
