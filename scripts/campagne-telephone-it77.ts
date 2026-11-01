/**
 * CAMPAGNE TÉLÉPHONE it.77 — MATIÈRE D'ALIGNEMENT ÉLARGIE (100 % locale,
 * zéro service IA externe, mêmes outils que la production).
 *
 * CANDIDAT №1 déclaré it.76 §8 : « Élargir la matière d'alignement (au-delà
 * des époques) : le plateau époques 3-4 montre que la matière (gabarits
 * it.72) est le facteur limitant — des textes d'alignement inédits (indices
 * 5000+, gabarits re-arrangés par domaine) sont le levier suivant du
 * plancher ».
 *
 * PROTOCOLE (mesuré, jamais estimé) — IDENTIQUE À it.76 SAUF LA MATIÈRE
 * ÉLARGIE DÉCLARÉE (mécanique inchangée, époques inchangées) :
 *  1. SUPERVISION EOD — cortex compact 2^17 (131 072 colonnes, seed 42,
 *     homéostasie ON, budget 6.0 — config production) entraîné PAR ONDES
 *     (entrainerDomainesParOndes, mécanique it.57/63 INCHANGÉE) : 2 vagues
 *     × 2 000 gabarits/domaine (it.72, indices 0..3999) — INCHANGÉ vs it.76.
 *  2. ALIGNEMENT INFÉRENCE À MATIÈRE ÉLARGIE — projection hash (mêmes
 *     colonnes que l'inférence utilisera), MÊME mécanique de plasticité
 *     supervisée que le trainer, 4 ÉPOQUES (inchangées it.76 — le levier
 *     est la matière, pas les époques) × ~1 428 textes/domaine :
 *       - matière it.76 : indices 4000..4899 (900 gabarits/domaine) ;
 *       - MATIÈRE INÉDITE : indices 5000..5499 (500 gabarits/domaine,
 *         bijection texteDomaine → textes JAMAIS vus par l'EOD ni par
 *         l'alignement it.76) ;
 *       + charte (label/mission/tâches/outils) + questions canoniques.
 *     Le travail réel est mesuré époque par époque (arêtes à cap 1.0 par
 *     bande) — la progression des caps teste si la nouvelle matière CASSE
 *     le plateau époques 3-4 constaté it.76.
 *  3. SONDES — questions canoniques + 2 gabarits NON supervisés (indices
 *     4901/4902 — LES MÊMES QUE it.76 : l'écart it.77↔it.76 est mesuré sur
 *     le MÊME jeu de sondes, comparabilité exacte avec l'artefact committé ;
 *     ces indices sont dans le VIDE entre les plages 4000..4899 et
 *     5000..5999, donc JAMAIS supervisés) : cortex entraîné vs cortex NEUF
 *     (même seed, zéro supervision) → le RATIO mesuré est publié tel quel.
 *  4. QUANTIFICATION u8 + SNAPSHOT CONDITIONNEL — erreur ≤ 1/510 par poids,
 *     accord argmax f32↔u8 mesuré sondes par sondes. RÈGLE DE LIVRAISON
 *     DÉCLARÉE (garde anti-régression) : le snapshot n'est écrit dans
 *     public/ (donc jamais livré aux utilisateurs) que si la variance
 *     N'AUGMENTE PAS vs it.76 ET que le plancher reste au-dessus du socle
 *     it.73 gelé (anti-retour accumulé) ; en cas de régression mesurée, le
 *     snapshot it.76 RESTE en production et la mesure est publiée telle
 *     quelle.
 *  5. COMPARAISON it.76 — l'artefact committé it.76 est relu : delta de
 *     ratio par domaine, plancher avant/après, variance avant/après —
 *     l'amélioration est MESURÉE contre la campagne précédente, jamais
 *     affirmée.
 *
 * HONNÊTETÉ (limites inchangées it.73/76) : la sonde NEURALE mesure la
 * résonance des bandes-porteuses (8 bandes, 19 domaines répartis par hash —
 * des domaines partagent une bande, ce n'est PAS une détection de domaine) ;
 * la détection de domaine en production reste le pont lexical. Les ratios
 * faibles sont publiés tels quels.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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

const COLONNES_TELEPHONE = 131072; // 2^17 (inchangé it.73)
const ECHANTILLONS_GABARITS = 2000; // par vague EOD et par domaine (inchangé it.73)
const GABARITS_ALIGNEMENT = 900; // matière it.76 : indices 4000..4899 (inchangée)
const GABARITS_INEDITS = 1000; // MATIÈRE INÉDITE : indices 5000..5999 (levier it.77 — paramètre du tick parallèle adopté)
const DEBUT_INEDITS = 5000;
const INDICE_SONDE_PRIMAIRE_1 = 4901; // identique it.76 — comparabilité exacte
const INDICE_SONDE_PRIMAIRE_2 = 4902; // identique it.76 — comparabilité exacte
const PLANCHER_SOCLE_IT73 = 1.242484; // socle gelé (artefact it.73) — anti-retour accumulé
const EPOQUES_ALIGNEMENT = 4; // INCHANGÉ it.76 — le levier it.77 est la matière
const CYCLES_SONDE = 4;
const GRAINE = 42;

const ARTEFACT_PRECEDENT = "assets/neural-pretrained/cortex-telephone-it76.json";

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
  activationCumuleePorteur: number;
  activationCumuleeArgmax: number;
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

/** Arêtes à cap 1.0 par bande [0..8) — le travail réel de plasticité. */
function poidsCapParBande(cortex: CortexColumnnaire): number[] {
  const parBandeCortex = Math.floor(cortex.config.colonnes / cortex.config.bandes);
  const cap = new Array(8).fill(0) as number[];
  for (let p = 0; p < cortex.csrPoids.length; p++) {
    const cible = cortex.csrCible[p]!;
    const bande = Math.floor(cible / parBandeCortex);
    if (bande < 8 && cortex.csrPoids[p]! >= 1.0) cap[bande] += 1;
  }
  return cap;
}

async function principal(): Promise<void> {
  console.log("=== CAMPAGNE TÉLÉPHONE it.77 — matière d'alignement ÉLARGIE ===");
  console.log(horodatage());

  // ---- 1. CORTEX ENTRAÎNÉ (2^17) — INCHANGÉ it.73/76 ----------------------
  console.log("\n[1] Cortex compact (2^17) + supervision EOD (inchangée it.73/76)…");
  const cortex = new CortexColumnnaire({
    colonnes: COLONNES_TELEPHONE,
    seed: GRAINE,
    normalisationHomeostatique: true,
  });
  const champ = new ChampCorticalGen3(GRAINE);
  console.log(
    `    ${COLONNES_TELEPHONE} colonnes × ${cortex.config.voisins} voisins = ${cortex.csrCible.length} arêtes — ${cortex.stats().memoireMo} Mo`,
  );

  const gabaritsParDomaine = new Map<string, string[]>();
  const alignementParDomaine = new Map<string, string[]>();
  for (const domaine of DOMAINES_VOCATION) {
    const total = 2 * ECHANTILLONS_GABARITS + GABARITS_ALIGNEMENT;
    const tous: string[] = [];
    for (let i = 0; i < total; i++) {
      tous.push(texteDomaine(domaine.id, i));
    }
    gabaritsParDomaine.set(domaine.id, tous.slice(0, total));
    const inedits: string[] = [];
    for (let i = DEBUT_INEDITS; i < DEBUT_INEDITS + GABARITS_INEDITS; i++) {
      inedits.push(texteDomaine(domaine.id, i));
    }
    const questions = CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === domaine.id).map((p) => p.question);
    alignementParDomaine.set(domaine.id, [
      domaine.label,
      domaine.mission,
      ...domaine.taches,
      ...domaine.outils,
      ...questions,
      ...tous.slice(2 * ECHANTILLONS_GABARITS, total),
      ...inedits,
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

  // ---- 2. ALIGNEMENT INFÉRENCE — MATIÈRE ÉLARGIE (4 époques) --------------
  console.log(
    `\n[2] Alignement inférence (${EPOQUES_ALIGNEMENT} époques, matière ÉLARGIE : ${GABARITS_ALIGNEMENT} it.76 + ${GABARITS_INEDITS} inédits/domaine)…`,
  );
  let horloge = 400000; // monotone > vagues EOD (inchangé it.73/76)
  const alignement: { echantillons: number; parEpoque: number[] } = { echantillons: 0, parEpoque: [] };
  const capParEpoque: number[][] = [poidsCapParBande(cortex)];
  console.log(`    arêtes à cap 1.0 APRÈS EOD : ${capParEpoque[0]!.join(", ")}`);
  for (let epoque = 0; epoque < EPOQUES_ALIGNEMENT; epoque++) {
    let echantillonsEpoque = 0;
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
        echantillonsEpoque += 1;
        horloge += CYCLES_SONDE;
      }
    }
    alignement.parEpoque.push(echantillonsEpoque);
    const cap = poidsCapParBande(cortex);
    capParEpoque.push(cap);
    console.log(`    époque ${epoque + 1}/${EPOQUES_ALIGNEMENT} : ${echantillonsEpoque} échantillons (horloge ${horloge}) — cap/bande : ${cap.join(", ")}`);
  }
  const poidsCapParBandeFinal = capParEpoque[capParEpoque.length - 1]!;
  const dureeSupervision = m6(performance.now() - tDebut);

  // Progression des caps (le plateau it.76 était : caps stables époques 3-4).
  const capsPlats = capParEpoque.map((c) => c.reduce((a, b) => a + b, 0));
  const croissanceTotaleAlignement = capsPlats[capsPlats.length - 1]! - capsPlats[0]!;
  const croissanceEpoques23 = capsPlats[2]! - capsPlats[1]!; // époque 2 → 3 (plateau it.76)
  const croissanceEpoques34 = capsPlats[3]! - capsPlats[2]!; // époque 3 → 4 (plateau it.76)

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
    const questions = CORPUS_QUESTIONS_VOCATION.filter((p) => p.domaineId === domaine.id).map((p) => p.question);
    // Jamais supervisés : indices 4901/4902, IDENTIQUES it.76 (dans le vide
    // entre les plages 4000..4899 et 5000..5999) — comparabilité exacte de
    // la comparaison d'artefact à artefact.
    const textes = [
      ...questions,
      texteDomaine(domaine.id, INDICE_SONDE_PRIMAIRE_1),
      texteDomaine(domaine.id, INDICE_SONDE_PRIMAIRE_2),
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
      texteDomaine(domaine.id, INDICE_SONDE_PRIMAIRE_1),
      texteDomaine(domaine.id, INDICE_SONDE_PRIMAIRE_2),
    ];
    sondesU8[domaine.id] = textes.map((t) => sonder(telephone, t, bandeAttendue, horlogeSonde));
  }

  // ---- 5. MESURES ÉNERGIE (structure identique → re-dérivables) ----------
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

  // ---- 6. SYNTHÈSE PAR DOMAINE + COMPARAISON it.76 ------------------------
  const precedent = JSON.parse(readFileSync(join(process.cwd(), ARTEFACT_PRECEDENT), "utf8")) as {
    parDomaine: Array<{ domaineId: string; ratioAppris: number | null }>;
  };
  const ratiosPrecedents = new Map<string, number | null>(
    precedent.parDomaine.map((d) => [d.domaineId, d.ratioAppris]),
  );

  const parDomaine = DOMAINES_VOCATION.map((domaine) => {
    const ens = sondesEntraîne[domaine.id] ?? [];
    const neuf = sondesNeuf[domaine.id] ?? [];
    const u8 = sondesU8[domaine.id] ?? [];
    const bandeAttendue = bandeDuDomaine(domaine.id);
    const moy = (l: ResultatSonde[], f: (s: ResultatSonde) => number) =>
      l.length ? m6(l.reduce((a, s) => a + f(s), 0) / l.length) : 0;
    const accordsU8 = ens.filter((s, i) => s.argmaxBande === u8[i]?.argmaxBande).length;
    const argmaxAttenduEns = ens.filter((s) => s.argmaxBande === bandeAttendue).length;
    const ratio =
      moy(neuf, (s) => s.activationCumuleePorteur) > 0
        ? m6(moy(ens, (s) => s.activationCumuleePorteur) / moy(neuf, (s) => s.activationCumuleePorteur))
        : null;
    const ratioIt76 = ratiosPrecedents.get(domaine.id) ?? null;
    return {
      domaineId: domaine.id,
      bandeAttendue,
      porteur: m6(porteurBande(bandeAttendue)),
      sondes: ens.length,
      activationCumuleeEntraîne: moy(ens, (s) => s.activationCumuleePorteur),
      activationCumuleeNeuf: moy(neuf, (s) => s.activationCumuleePorteur),
      ratioAppris: ratio,
      ratioApprisIt76: ratioIt76,
      deltaRatioVsIt76: ratio !== null && ratioIt76 !== null ? m6(ratio - ratioIt76) : null,
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
  const plancher = Math.min(...ratios);
  const plafond = Math.max(...ratios);
  const moyenne = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const variance = m6(ratios.reduce((a, b) => a + (b - moyenne) ** 2, 0) / ratios.length);
  const ratios76 = parDomaine.map((d) => d.ratioApprisIt76 ?? 0);
  const plancherIt76 = Math.min(...ratios76);
  const plafondIt76 = Math.max(...ratios76);
  const moyenne76 = ratios76.reduce((a, b) => a + b, 0) / ratios76.length;
  const varianceIt76 = m6(ratios76.reduce((a, b) => a + (b - moyenne76) ** 2, 0) / ratios76.length);
  const deltasPositifs = parDomaine.filter((d) => (d.deltaRatioVsIt76 ?? 0) > 0).length;

  // ---- 7. ARTEFACT + SNAPSHOT COMMITTÉS ----------------------------------
  const artefact = {
    iteration: 77,
    titre: "Matière d'alignement ÉLARGIE — cortex compact embarqué v3 (téléphone)",
    horodatage: horodatage(),
    graine: GRAINE,
    configTelephone: entete,
    elargissement: {
      candidat: "№1 déclaré it.76 §8 — la matière (gabarits it.72) est le facteur limitant après le plateau époques 3-4 ; des textes inédits sont le levier suivant du plancher",
      changementDeclare: `matière d'alignement ÉLARGIE : indices 4000..4899 (it.76, 900/domaine) + indices ${DEBUT_INEDITS}..${DEBUT_INEDITS + GABARITS_INEDITS - 1} INÉDITS (${GABARITS_INEDITS}/domaine) — époques INCHANGÉES (${EPOQUES_ALIGNEMENT}), EOD INCHANGÉE, mécanique INCHANGÉE`,
      comparaison: {
        artefactPrecedent: ARTEFACT_PRECEDENT,
        plancherIt76: m6(plancherIt76),
        plancherIt77: m6(plancher),
        plancherAmeliore: plancher > plancherIt76,
        plafondIt76: m6(plafondIt76),
        plafondIt77: m6(plafond),
        varianceIt76: varianceIt76,
        varianceIt77: variance,
        varianceReduite: variance < varianceIt76,
        domainesRatioEnHausse: deltasPositifs,
        domainesRatioEnBaisse: parDomaine.filter((d) => (d.deltaRatioVsIt76 ?? 0) < 0).length,
      },
      plateau: {
        note: "it.76 avait constaté un plateau (caps stables époques 3-4, bande 1 : 4 712 → 4 719). La progression des caps sous la matière élargie est publiée telle quelle.",
        totalAreteCapApresEod: capsPlats[0]!,
        totalAreteCapFinal: capsPlats[capsPlats.length - 1]!,
        croissanceTotaleAlignement,
        croissanceEpoque2vers3: croissanceEpoques23,
        croissanceEpoque3vers4: croissanceEpoques34,
        capsParEpoque: capsPlats,
      },
    },
    supervision: {
      mecanique: "EOD it.57/63 (entrainerDomainesParOndes) inchangée + alignement inférence à MATIÈRE ÉLARGIE (projection hash, même plasticité que le trainer — phase déclarée et séparée)",
      matiere: `gabarits it.72 charte-ancrés (indices 4000..4899, matière it.76) + matière INÉDITE (indices ${DEBUT_INEDITS}..${DEBUT_INEDITS + GABARITS_INEDITS - 1}, jamais vus par l'EOD ni par it.76) + questions canoniques + phrases charte — sondes ${INDICE_SONDE_PRIMAIRE_1}/${INDICE_SONDE_PRIMAIRE_2} (identiques it.76, dans le vide entre les plages) JAMAIS supervisées`,
      vagues,
      totalEchantillonsEod: vagues.reduce((a, v) => a + v.echantillons, 0),
      alignement: {
        echantillons: alignement.echantillons,
        parEpoque: alignement.parEpoque,
        epoques: EPOQUES_ALIGNEMENT,
        gabaritsParDomaine: GABARITS_ALIGNEMENT,
        gabaritsIneditsParDomaine: GABARITS_INEDITS,
        debutInedits: DEBUT_INEDITS,
      },
      metabolismeEod,
      poidsCapParBande: poidsCapParBandeFinal,
      poidsCapParEpoque: capParEpoque,
      dureeMs: dureeSupervision,
    },
    sonde: {
      convention: "projection hash (production chat), 4 pas, activation d'ÉNERGIE cumulée par bande (le signal des poids trained se transporte au cycle 1) + résonance de spikes publiée telle quelle",
      horloge: horlogeSonde,
      indicesSondes: [INDICE_SONDE_PRIMAIRE_1, INDICE_SONDE_PRIMAIRE_2],
      noteComparabilite: "indices IDENTIQUES it.76 — la comparaison d'artefact à artefact est mesurée sur le MÊME jeu de sondes",
      totalSondes,
      accordArgmaxF32U8: totalAccord,
      tauxAccordF32U8: m6(totalAccord / totalSondes),
      argmaxAttenduEntraîne: totalAttendu,
      domaineAvecGain,
      plancherRatio: m6(plancher),
      plafondRatio: m6(plafond),
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
      "La phase d'alignement inférence (projection hash) est une supervision DÉCLARÉE, distincte de l'EOD — sa matière (indices 4000..4899 + 5000..5999), ses époques (4) et son métabolisme sont publiés séparément ; les sondes (indices 4901/4902, identiques it.76) ne sont JAMAIS supervisées.",
      "Les ratios d'un domaine restent le signal de SA bande : l'amélioration du plancher est une amélioration du signal de bande, pas une détection par domaine.",
      "Le plateau de saturation des caps (constaté it.76 époques 3-4) est une borne du LEVIER ÉPOQUES ; l'élargissement de matière teste la borne MATIÈRE — si les caps plateauent à nouveau, la limite est publiée telle quelle (progression par époque dans plateau.capsParEpoque).",
    ],
  };

  const dirAssets = "assets/neural-pretrained";
  const dirPublic = "public/neural";
  mkdirSync(dirAssets, { recursive: true });
  mkdirSync(dirPublic, { recursive: true });

  // RÈGLE DE LIVRAISON (déclarée, alignée sur la garde 42ᵉ) : le snapshot
  // téléphone n'est livré aux utilisateurs QUE si la variance n'augmente pas
  // ET que le plancher reste au-dessus du socle gelé it.73 (anti-retour
  // accumulé). Sinon le it.76 reste en production.
  const livreSnapshot = variance <= varianceIt76 && plancher > PLANCHER_SOCLE_IT73;
  const artefactFinal = {
    ...artefact,
    livraison: {
      snapshotTelephone: livreSnapshot
        ? "committé : public/neural/cortex-telephone-it77.bin (variance non dégradée + plancher au-dessus du socle it.73)"
        : "NON committé — régression mesurée sur sondes IDENTIQUES it.76 : le snapshot it.76 RESTE en production, aucune bascule du composant /mobile",
      regleDeclaree: `le snapshot n'est livré que si variance(it.77) ≤ variance(it.76) ET plancher(it.77) > socle it.73 gelé (${PLANCHER_SOCLE_IT73}), mesurés sur les sondes identiques it.76 (4901/4902) — la règle est encodée dans ce script, jamais contée à la main`,
      livreSnapshot,
    },
  };
  writeFileSync(join(dirAssets, "cortex-telephone-it77.json"), JSON.stringify(artefactFinal, null, 2));
  if (livreSnapshot) {
    writeFileSync(join(dirPublic, "cortex-telephone-it77.bin"), snapshot);
  } else {
    // Supprimer toute trace d'un bin non livré (une campagne précédente
    // pourrait avoir laissé un fichier — la garde exige son absence).
    try { unlinkSync(join(dirPublic, "cortex-telephone-it77.bin")); } catch { /* absent : OK */ }
  }

  console.log("\n=== SYNTHÈSE ===");
  console.log(`Sondes (4901/4902, identiques it.76) : ${totalSondes} · accord argmax f32↔u8 : ${totalAccord}/${totalSondes} (${artefact.sonde.tauxAccordF32U8})`);
  console.log(`Bande attendue gagnante (entraîné) : ${totalAttendu}/${totalSondes} · domaines avec gain > 1 : ${domaineAvecGain}/19`);
  console.log(`PLANCHER ratio : it.76 ${m6(plancherIt76)} → it.77 ${m6(plancher)} (amélioré : ${plancher > plancherIt76}) · socle it.73 ${PLANCHER_SOCLE_IT73}`);
  console.log(`VARIANCE ratio : it.76 ${varianceIt76} → it.77 ${variance} (réduite : ${variance < varianceIt76})`);
  console.log(`Domaines en hausse : ${deltasPositifs}/19 · en baisse : ${parDomaine.filter((d) => (d.deltaRatioVsIt76 ?? 0) < 0).length}/19`);
  console.log(`PLATEAU (total arêtes à cap) : après EOD ${capsPlats[0]} → final ${capsPlats[capsPlats.length - 1]} · ép.2→3 : +${croissanceEpoques23} · ép.3→4 : +${croissanceEpoques34}`);
  console.log(`Mémoire : plein 2^20 ${memoirePlein} o · éco 2^20 ${memoireEco} o · téléphone 2^17 ${memoireTelephone} o (÷${artefact.energie.reductionTelephoneVsPlein})`);
  console.log(`Fenêtre serveur 2^20 : ${serveurSonde.transmissions} transmissions, ${serveurSonde.evaluees} évaluées, ${serveurSonde.ms} ms`);
  console.log(`Snapshot : ${snapshot.length} octets — ${livreSnapshot ? "LIVRÉ → public/neural/cortex-telephone-it77.bin" : "NON LIVRÉ (régression mesurée : le it.76 reste en production)"}`);
  console.log(`Artefact : assets/neural-pretrained/cortex-telephone-it77.json`);
}

principal().catch((erreur) => {
  console.error("CAMPAGNE TÉLÉPHONE it.77 — ÉCHEC :", erreur);
  process.exit(1);
});
