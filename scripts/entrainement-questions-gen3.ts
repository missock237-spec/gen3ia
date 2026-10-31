/**
 * ENTRAÎNEMENT DE GEN3 AUX QUESTIONS DE SON CADRE (it.66 — demande
 * propriétaire : « entraîne gen3 depuis tes propres serveurs locaux…
 * fais en sorte qu'il soit capable de répondre à des questions qui
 * rentrent dans son cadre d'apprentissage »).
 *
 * CE QUE FAIT CETTE CAMPAGNE (100 % locale, zéro service IA externe) :
 *  1. SOURCE : les paires question→réponse générées DÉTERMINISTEMENT
 *     depuis la charte de vocation (lib/gen3/generateur-datasets.ts —
 *     bijection mixte-radix, espace ≥ 141,9 M/domaine) avec un OFFSET
 *     ANTI-REJOUE (index 10 M+) : matière NOUVELLE, jamais les textes des
 *     campagnes it.63/it.65. Chaque texte est au format
 *     « Q: <question> R: <réponse charte> » — la forme QUESTION→RÉPONSE.
 *  2. ENTRAÎNEMENT : la mécanique EOD réelle (entrainerDomainesParOndes,
 *     it.57/63 — inchangée), plan INTERCLASSÉ round-robin sur les 19
 *     domaines (leçon it.63 : les blocs séquentiels effondrent les bandes
 *     dominées), lots ≤ 2000, continuité d'horloge (horlogeInitiale).
 *  3. SONDES HONNÊTES (leçon it.65 — jamais d'horloge arrière sur le vif) :
 *     - AVANT : trace porteur/autres mesurée sur un cortex-SCRATCH neuf
 *       (baseline non entraînée), horloge lointaine 90e9 ;
 *     - APRÈS : MÊME sonde, MÊMES points, MÊME horloge 90e9 sur le cortex
 *       entraîné (monotone — dt>0, décroissance amortie).
 *  4. ARTEFACT : assets/neural-pretrained/entrainement-questions-it66.json
 *     — chiffres mesurés, bilan QA honnête (un critère non atteint est
 *     rapporté comme tel), limites documentées. Vérifié par la 34ᵉ garde.
 *
 * REPRODUCTIBILITÉ : graine fixe, bijection déterministe — deux exécutions
 * avec les mêmes paramètres traitent les MÊMES textes dans le MÊME ordre.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

import { DOMAINES_VOCATION, IDS_VOCATION } from "../lib/gen3/vocation";
import { paireGenere } from "../lib/gen3/generateur-datasets";
import {
  entrainerDomainesParOndes,
  bandeDuDomaine,
  analyserOndeTexte,
  colonnesDepuisOndes,
} from "../lib/neural/training/entrainement-ondes";
import type { ExempleOnde } from "../lib/neural/training/entrainement-ondes";
import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";

/* ------------------------------------------------------------------ */
/* Paramètres de session                                              */
/* ------------------------------------------------------------------ */

/** Cible d'échantillons QA par domaine (1,9 M au total — échelle réelle
 *  mesurée en quelques minutes sur serveur local, extensible par CLI). */
const CIBLE_PAR_DOMAINE = Number(process.env.GEN3IA_QUESTIONS_PAR_DOMAINE ?? 100_000);
/** Taille des lots (= cap garde-fou du trainer EOD). */
const TAILLE_LOT = 2000;
/** OFFSET ANTI-REJOUE : les campagnes it.63/65 ont entraîné les indexes
 *  0..~1M ; cette campagne part à 10M — matière TOUJOURS nouvelle. */
const OFFSET_BIJECTION = 10_000_000;
/** Cycles EOD par échantillon (sémantique it.57/63 inchangée). */
const CYCLES = 3;
/** Longueur maximale d'un texte d'entraînement (les ondes lisent les tokens). */
const LONGUEUR_TEXTE_MAX = 400;
/** Horloge des sondes AVANT/APRÈS (lointaine — leçon it.65 : monotone,
 *  jamais d'horloge arrière sur le cortex vif). */
const HORLOGE_SONDE = 90_000_000_000;
/** Graine déterministe de la session. */
const GRAINE = 20261101;

const environnement = process.env.GEN3IA_ENV ?? "local-sandbox";
const cheminArtefact = join(process.cwd(), "assets", "neural-pretrained", "entrainement-questions-it66.json");

/* ------------------------------------------------------------------ */
/* Construction des exemples QA (bijection charte, offset anti-rejoue) */
/* ------------------------------------------------------------------ */

interface ExempleQA extends ExempleOnde {
  index: number;
}

function texteQA(domaine: string, index: number): string {
  const paire = paireGenere(domaine, index);
  const brut = `Q: ${paire.motif}\nR: ${paire.reponse}`;
  return brut.length <= LONGUEUR_TEXTE_MAX ? brut : `${brut.slice(0, LONGUEUR_TEXTE_MAX - 1)}…`;
}

/** Construit les exemples QA d'un domaine (déterministe, index offset). */
function exemplesDuDomaine(domaine: string, quantite: number): ExempleQA[] {
  const sortie: ExempleQA[] = [];
  for (let i = 0; i < quantite; i++) {
    const index = OFFSET_BIJECTION + i;
    sortie.push({ texte: texteQA(domaine, index), domaine, index });
  }
  return sortie;
}

/* ------------------------------------------------------------------ */
/* Plan interclassé (round-robin) — leçon it.63                        */
/* ------------------------------------------------------------------ */

function planInterclasse(exemplesParDomaine: Map<string, ExempleQA[]>): ExempleQA[] {
  const cursors = new Map<string, number>([...exemplesParDomaine.keys()].map((d) => [d, 0]));
  const plan: ExempleQA[] = [];
  let restants = true;
  while (restants) {
    restants = false;
    for (const domaine of IDS_VOCATION) {
      const curseur = cursors.get(domaine) ?? 0;
      const liste = exemplesParDomaine.get(domaine) ?? [];
      if (curseur >= liste.length) continue;
      const fin = Math.min(liste.length, curseur + Math.ceil(TAILLE_LOT / IDS_VOCATION.length));
      for (let i = curseur; i < fin; i++) plan.push(liste[i]!);
      cursors.set(domaine, fin);
      if (fin < liste.length) restants = true;
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ */
/* Sonde de trace (porteur/autres) — horloge lointaine monotone        */
/* ------------------------------------------------------------------ */

interface SondePoint {
  porteur: number;
  autres: number;
  ratio: number;
}

function sonderTrace(cortex: CortexColumnnaire, champ: ChampCorticalGen3, points: readonly { domaine: string; texte: string }[]): Map<string, SondePoint> {
  const accumule = new Map<string, { p: number; a: number; n: number }>();
  for (const pt of points) {
    const bande = bandeDuDomaine(pt.domaine);
    const paquets = analyserOndeTexte(pt.texte, HORLOGE_SONDE);
    const injections = colonnesDepuisOndes(paquets, cortex.config.colonnes);
    cortex.pas(injections, HORLOGE_SONDE + 1);
    void champ;
    const activation = cortex.activationBandes();
    const porteur = activation[bande] ?? 0;
    let somme = 0;
    for (let b = 0; b < activation.length; b++) {
      if (b !== bande) somme += activation[b] ?? 0;
    }
    const autres = somme / Math.max(1, activation.length - 1);
    const acc = accumule.get(pt.domaine) ?? { p: 0, a: 0, n: 0 };
    acc.p += porteur;
    acc.a += autres;
    acc.n += 1;
    accumule.set(pt.domaine, acc);
  }
  const sortie = new Map<string, SondePoint>();
  for (const [domaine, acc] of accumule) {
    const porteur = acc.p / acc.n;
    const autres = acc.a / acc.n;
    sortie.set(domaine, { porteur, autres, ratio: porteur / Math.max(1e-12, autres) });
  }
  return sortie;
}

/** Points de sonde par domaine : 2 paires QA distinctes (début + fin). */
function pointsDeSonde(): { domaine: string; texte: string }[] {
  const points: { domaine: string; texte: string }[] = [];
  for (const domaine of IDS_VOCATION) {
    points.push({ domaine, texte: texteQA(domaine, OFFSET_BIJECTION) });
    points.push({ domaine, texte: texteQA(domaine, OFFSET_BIJECTION + CIBLE_PAR_DOMAINE - 1) });
  }
  return points;
}

/* ------------------------------------------------------------------ */
/* Session principale                                                  */
/* ------------------------------------------------------------------ */

interface BilanDomaine {
  id: string;
  label: string;
  bande: number;
  echantillons: number;
  renforts: number;
  annulations: number;
  resonanceMoyenne: number;
  traceAvant: number;
  traceApres: number;
  gainTrace: number;
}

function main(): void {
  console.log(`[it.66] Entraînement de gen3 aux questions de son cadre — ${CIBLE_PAR_DOMAINE}/domaine, offset bijection ${OFFSET_BIJECTION}, graine ${GRAINE}`);
  const debut = Date.now();

  // 1. Exemples QA par domaine (déterministes, matière nouvelle).
  const exemplesParDomaine = new Map<string, ExempleQA[]>();
  for (const id of IDS_VOCATION) {
    exemplesParDomaine.set(id, exemplesDuDomaine(id, CIBLE_PAR_DOMAINE));
  }
  const totalCible = IDS_VOCATION.length * CIBLE_PAR_DOMAINE;
  console.log(`[it.66] Exemples QA construits : ${totalCible.toLocaleString("fr-FR")} (19 domaines)`);

  // 2. Cortex + champ (serveurs locaux — zéro service externe).
  const cortex = new CortexColumnnaire();
  const champ = new ChampCorticalGen3(GRAINE);

  // 3. Sonde AVANT — cortex-SCRATCH neuf (baseline honnête).
  const scratch = new CortexColumnnaire();
  const champScratch = new ChampCorticalGen3(GRAINE);
  const avant = sonderTrace(scratch, champScratch, pointsDeSonde());

  // 4. Plan interclassé + entraînement par lots (continuité d'horloge).
  const plan = planInterclasse(exemplesParDomaine);
  console.log(`[it.66] Plan interclassé : ${plan.length.toLocaleString("fr-FR")} échantillons, lots ≤ ${TAILLE_LOT}`);
  const bilanParDomaine = new Map<string, { echantillons: number; renforts: number; annulations: number; resonance: number; mesures: number }>();
  let horloge = 0;
  let totalTraite = 0;
  let lotNo = 0;
  const metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0 };

  for (let debut_lot = 0; debut_lot < plan.length; debut_lot += TAILLE_LOT) {
    const lot = plan.slice(debut_lot, debut_lot + TAILLE_LOT);
    const rapport = entrainerDomainesParOndes(cortex, champ, lot, {
      cyclesParEchantillon: CYCLES,
      lrBoost: 0.15,
      maxParDomaine: TAILLE_LOT,
      horlogeInitiale: horloge,
    });
    horloge += CYCLES * lot.length;
    totalTraite += rapport.totalEchantillons;
    metabolisme.evaluees += rapport.metabolisme.evaluees;
    metabolisme.reposes += rapport.metabolisme.reposes;
    metabolisme.transmissions += rapport.metabolisme.transmissions;
    metabolisme.ms += rapport.metabolisme.ms;
    for (const d of rapport.domaines) {
      const acc = bilanParDomaine.get(d.domaine) ?? { echantillons: 0, renforts: 0, annulations: 0, resonance: 0, mesures: 0 };
      acc.echantillons += d.echantillons;
      acc.renforts += d.renforts;
      acc.annulations += d.annulations;
      acc.resonance += d.resonanceMoyenne;
      acc.mesures += 1;
      bilanParDomaine.set(d.domaine, acc);
    }
    lotNo += 1;
    if (lotNo % 25 === 0) {
      const vitesse = (totalTraite / Math.max(1, Date.now() - debut) * 1000).toFixed(0);
      console.log(`[it.66] lot ${lotNo} — ${totalTraite.toLocaleString("fr-FR")} échantillons (${vitesse}/s)`);
    }
  }

  // 5. Sonde APRÈS — MÊMES points, MÊME horloge lointaine (monotone : dt>0
  //    sur le cortex vif, décroissance amortie — leçon it.65 respectée).
  const apres = sonderTrace(cortex, champ, pointsDeSonde());

  // 6. Bilan par domaine (mesures réelles, aucun chiffre fabriqué).
  const domaines: BilanDomaine[] = IDS_VOCATION.map((id) => {
    const acc = bilanParDomaine.get(id) ?? { echantillons: 0, renforts: 0, annulations: 0, resonance: 0, mesures: 0 };
    const traceAvant = avant.get(id)?.ratio ?? 0;
    const traceApres = apres.get(id)?.ratio ?? 0;
    return {
      id,
      label: DOMAINES_VOCATION.find((d) => d.id === id)?.label ?? id,
      bande: bandeDuDomaine(id),
      echantillons: acc.echantillons,
      renforts: acc.renforts,
      annulations: acc.annulations,
      resonanceMoyenne: acc.mesures > 0 ? acc.resonance / acc.mesures : 0,
      traceAvant,
      traceApres,
      gainTrace: traceApres / Math.max(1e-12, traceAvant),
    };
  });

  // 7. Bilan QA honnête (critères mesurés — un échec est rapporté tel quel).
  const c1Donnees = domaines.filter((d) => d.echantillons >= CIBLE_PAR_DOMAINE).length;
  const c2Renforts = domaines.filter((d) => d.renforts > 0).length;
  const c3Trace = domaines.filter((d) => d.gainTrace > 1).length;

  const artefact = {
    session: "entrainement-questions-it66",
    date: new Date().toISOString(),
    environnement,
    demandeProprietaire:
      "entraîne gen3 depuis tes propres serveurs locaux — 1 million de données par domaine (atteint it.63, campagne A : 1 005 000 textes uniques/domaine) — et fais en sorte qu'il soit capable de répondre à des questions qui rentrent dans son cadre d'apprentissage (it.66 : pont vocation + corpus de questions + cette campagne d'ondes QA)",
    parametres: {
      cibleParDomaine: CIBLE_PAR_DOMAINE,
      offsetBijection: OFFSET_BIJECTION,
      cyclesParEchantillon: CYCLES,
      tailleLot: TAILLE_LOT,
      lrBoost: 0.15,
      graine: GRAINE,
      horlogeSonde: HORLOGE_SONDE,
      formatTexte: "Q: <question> R: <réponse charte>",
    },
    sources: {
      generateur: "lib/gen3/generateur-datasets.ts (bijection mixte-radix, espace ≥ 141,9 M/domaine)",
      charte: "lib/gen3/vocation.ts (19 domaines — ordre du propriétaire)",
      antiRejoue: "indexes 10 000 000+ — matière nouvelle, jamais les textes it.63/it.65",
    },
    totalEchantillons: totalTraite,
    lots: lotNo,
    horlogeFinale: horloge,
    metabolisme,
    bilan: {
      criteres: {
        c1_donnees_19_domaines: { valeur: c1Donnees, sur: 19, atteint: c1Donnees === 19 },
        c2_renforts_positifs: { valeur: c2Renforts, sur: 19, atteint: c2Renforts === 19 },
        c3_gain_trace: { valeur: c3Trace, sur: 19, atteint: c3Trace === 19 },
      },
      limitesHonnetes: [
        "la trace reste limitée par le substrat sparse-colonne (limite documentée it.63/it.65 : à grande échelle les arêtes CSR saturent)",
        "les réponses de gen3 viennent du PONT VOCATION (ancrage charte déterministe) — cette campagne renforce le substrat neuronal (plasticité QA), elle ne remplace pas le pont",
        "corpus SYNTHÉTIQUE ancré charte : gen3 répond à des questions DE SON CADRE, pas au-delà (honnêteté it.61)",
      ],
    },
    parDomaine: domaines,
  };

  const dossier = join(process.cwd(), "assets", "neural-pretrained");
  if (!existsSync(dossier)) mkdirSync(dossier, { recursive: true });
  const tmp = `${cheminArtefact}.tmp`;
  writeFileSync(tmp, JSON.stringify(artefact, null, 2), "utf8");
  renameSync(tmp, cheminArtefact);

  console.log(`[it.66] Session terminée en ${((Date.now() - debut) / 1000).toFixed(0)} s`);
  console.log(`[it.66] Échantillons traités : ${totalTraite.toLocaleString("fr-FR")} (${lotNo} lots)`);
  console.log(`[it.66] Bilan QA : C1 données ${c1Donnees}/19 · C2 renforts ${c2Renforts}/19 · C3 gain trace ${c3Trace}/19`);
  console.log(`[it.66] Artefact : ${cheminArtefact}`);
}

main();
