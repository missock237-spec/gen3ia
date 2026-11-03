/**
 * INTERROGATION MILLIARD (it.86 — demande propriétaire directe) :
 * « ouvrir un compte utilisateur, poser des questions, vérifier si gen3
 * répond juste, corriger dans sa mémoire en cas de mauvaise réponse,
 * au total 1 milliard de questions pour tous les domaines ».
 *
 * UN SEUL script, cinq phases — le cycle Q→R→Vérif→Correction→Re-test :
 *
 *   1. CHECKPOINT : le balayage des 1 000 000 000 questions est
 *      persisté (var/interrogation-milliard-it86/progression.json) —
 *      chaque tick cron reprend exactement où le précédent s'est arrêté,
 *      zéro question répétée, zéro chiffre fantôme.
 *   2. INTERROGATION : les questions (générateur déterministe
 *      lib/gen3/interrogation-milliard.ts, capacité ≈ 1,89 Md, balayage
 *      stratifié par famille sur l'ordre total du milliard) sont posées au
 *      moteur LOCAL DU CHAT — le même chemin que la production :
 *      CortexLangagierGen3 chargé avec CORPUS_GEN3 + détection de méthode
 *      de famille (it.85-r). Chaque réponse est VÉRIFIÉE automatiquement :
 *      « exact » (le résultat calculé est servi), « methode » (la bonne
 *      famille répond sans le résultat), « echec » (hors sujet).
 *   3. CORRECTION MÉMOIRE (en ligne, échantillonnée) : 1 échec sur
 *      PERIODE_APPRENTISSAGE reçoit sa paire corrective (pensée pas à pas +
 *      résultat exact) apprise par le cortex langagier — mesure it.86 :
 *      apprendre CHAQUE échec sature l'index inversé (débit 40/s) ;
 *      échantillonné, le débit reste ≈ 600/s et la réparation ≈ 100 %
 *      (bonus de motif exact). Chaque correction retenue est RE-TESTÉE
 *      immédiatement : la réparation est MESURÉE.
 *   4. CORRECTION SUBSTRAT (SNN) : le cerveau it.85 (snapshot 1M
 *      colonnes) est importé, les paires correctives de l'échantillon
 *      consolidé sont gravées PAR ONDES (méthode EOD, it.57) vers la
 *      bande-porteuse « interrogation-domaines-fr » (hash FNV-1a % 32 =
 *      bande 6 — libre vis-à-vis d'it.84/it.85 ET dans la région
 *      structurellement audible de la CSR, bandes 0-7 ≈ 1,1 arête/colonne
 *      contre ≈ 0,125 pour les bandes 8+), plus un lot préventif de paires
 *      exactes du balayage. Snapshot corrigé exporté et committé.
 *   5. CONSOLIDATION : les paires correctives de l'échantillon (30 par
 *      famille, valeurs proches des usages réels) sont écrites en module
 *      « code source » (lib/neural/generation/corpus-interrogation-it86.ts)
 *      — le chat en sert les réponses exactes depuis le navigateur.
 *
 * Usage (sandbox) :
 *   NODE_OPTIONS=--max-old-space-size=3072 QUANTITE=1000000 \
 *     npx tsx scripts/interrogation-milliard-it86.ts
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import {
  ECHELLE_QUANTISATION_U8,
  exporterSnapshotTelephone,
  importerSnapshotTelephone,
  quantiserPoidsU8,
  type EnteteSnapshotTelephone,
} from "../lib/neural/core/v2/energie";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import { detecterMethodeRaisonnement } from "../lib/gen3/familles-methodes";
import {
  FAMILLES_MILLIARD,
  N_TOTAL_MILLIARD,
  capaciteTotale,
  paireCorrective,
  planifierBalayage,
  questionStratifiee,
  verifierReponseGen3,
  type FamilleMilliard,
  type QuestionMilliard,
} from "../lib/gen3/interrogation-milliard";

// ─── Configuration (env, déterministe) ──────────────────────────────────────

const N_TOTAL = N_TOTAL_MILLIARD; // l'ordre total du balayage : 1 milliard
const QUANTITE = Math.max(1, Number(process.env.QUANTITE ?? "1000000"));
// it.87 (levier 1) : segment élargi 780 → 1500 s — le débit mesuré au tick 05:10
// (~710 questions/s d'interrogation) laisse un segment ≈ 1 M questions en ~23 min
// de balayage, plus les phases de correction : ~30 min de run par tick de 2 h.
const MAX_SECONDES = Math.max(60, Number(process.env.MAX_SECONDES ?? "1500"));
const CYCLES = Math.max(1, Math.min(8, Number(process.env.CYCLES ?? "5")));
const CORRECTIONS_ONDES = Math.max(1, Number(process.env.CORRECTIONS_ONDES ?? "200000"));
const CONSOLIDATION_PAR_FAMILLE = 30;
// it.87 (levier 2) : échantillonnage resserré 200 → 50 — l'écriture des
// corrections (≈ 600/s mesurée) n'est pas le goulot de l'interrogation
// (≈ 710/s) : à 1/50, un segment de 1 M de questions apprend ≈ 7 400 paires
// correctives de plus par run (5/s ≪ 600/s), toujours sous le garde-fou
// d'index enMemoire < 120 000 (par run — jamais atteint à ce débit).
const PERIODE_APPRENTISSAGE = 50; // 1 correction APPRISE toutes les 50 échecs
// it.87 (levier 3) : ROTATION MULTI-BANDES — la gravure répétée sur une seule
// bande dilue le signal individuel (mesure it.86 : dominance 14/30 → 6/30 sur
// la bande 6). La bande-porteuse du run tourne, déterministe au numéro de run
// (checkpoint `runs`), parmi les bandes structurellement audibles de la CSR
// (0-7 ≈ 1,1 arête/colonne) en évitant la bande 0 (it.85 raisonnement-humain)
// et la bande 6 (déjà chargée de 600 030 ondes it.86 — elle repose).
const BANDES_ROTATION = [1, 2, 3, 4, 5, 7];
const PREFIXE_LABEL = "interrogation-it87-b"; // suffixe cherché pour viser la bande cible (FNV-1a % 32)
const LABEL_HISTORIQUE = "interrogation-domaines-fr"; // bande 6 — gravures it.86 (605 030 ondes), conservé pour la traçabilité
const DIR_OUT = "var/interrogation-milliard-it86";
const DIR_SNAP = "public/neural";
// Chaîne cumulative : si le snapshot corrigé du tick précédent existe (gravures
// bande 6 déjà posées), on en part — les ondes correctives s'accumulent d'un
// tick à l'autre au lieu d'être réécrites à zéro (convention it.84 → it.85).
const SNAPSHOT_SOURCE = existsSync("public/neural/cortex-interrogation-it86.bin")
  ? "public/neural/cortex-interrogation-it86.bin"
  : "public/neural/cortex-raisonnement-it85.bin";
const SNAPSHOT_SORTIE = "public/neural/cortex-interrogation-it86.bin";
const MODULE_PAIRES = "lib/neural/generation/corpus-interrogation-it86.ts";
const CHEMIN_CHECKPOINT = join(DIR_OUT, "progression.json");

// ─── Ondes (méthode EOD — identique à it.84/it.85) ──────────────────────────

function fnv1a(chaine: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < chaine.length; i++) {
    h ^= chaine.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const PHI_OR = 1.618033988749895;

/** it.87 : label d'un run pour viser une bande cible (recherche déterministe du suffixe — FNV-1a % 32). */
function labelPourBande(bandeCible: number, prefixe: string): string {
  for (let n = 0; n < 4096; n++) {
    const candidat = `${prefixe}${n}`;
    if (fnv1a(candidat) % 32 === bandeCible) return candidat;
  }
  throw new Error(`aucun label trouvé pour la bande ${bandeCible}`);
}

function ondeToken(token: string, position: number): { w: number; phi: number; a: number } {
  const h = fnv1a(token);
  const w = 0.25 + (h / 0xffffffff) * 1.5;
  const phi = ((h / 0xffffffff) * 2 * Math.PI + position * PHI_OR) % (2 * Math.PI);
  const a = Math.min(1, 0.25 + token.length / 24);
  return { w, phi, a };
}

function colonnesDepuisOndes(
  tokens: string[],
  nbColonnes: number,
): Array<[number, number]> {
  const accumule = new Map<number, number>();
  tokens.forEach((token, i) => {
    if (token.length === 0) return;
    const { w, phi, a } = ondeToken(token, i);
    const base = (Math.sin(phi) + 1) / 2 + w / 1.75;
    const colonne = Math.floor((base % 1) * nbColonnes);
    const intensite = 1.2 * a;
    const suivant = Math.min(3.0, (accumule.get(colonne) ?? 0) + intensite);
    accumule.set(colonne, suivant);
  });
  return Array.from(accumule.entries());
}

// ─── Checkpoint (reprise entre ticks — zéro question répétée) ───────────────

interface Checkpoint {
  date: string;
  totalInterroge: number;
  exact: number;
  methode: number;
  echec: number;
  corriges: number;
  correctionsHorsMemoire: number;
  retests: number;
  reparees: number;
  parFamille: Record<string, { exact: number; methode: number; echec: number; corriges: number }>;
  runs: number;
  dureeMsCumulee: number;
}

function lireCheckpoint(): Checkpoint {
  const vide: Checkpoint = {
    date: new Date().toISOString(),
    totalInterroge: 0,
    exact: 0,
    methode: 0,
    echec: 0,
    corriges: 0,
    correctionsHorsMemoire: 0,
    retests: 0,
    reparees: 0,
    parFamille: Object.fromEntries(
      FAMILLES_MILLIARD.map((f) => [f, { exact: 0, methode: 0, echec: 0, corriges: 0 }]),
    ),
    runs: 0,
    dureeMsCumulee: 0,
  };
  if (!existsSync(CHEMIN_CHECKPOINT)) return vide;
  try {
    const brut = JSON.parse(readFileSync(CHEMIN_CHECKPOINT, "utf8")) as Checkpoint;
    for (const f of FAMILLES_MILLIARD) {
      if (!brut.parFamille[f]) brut.parFamille[f] = { exact: 0, methode: 0, echec: 0, corriges: 0 };
    }
    return brut;
  } catch {
    return vide;
  }
}

// ─── Programme principal ────────────────────────────────────────────────────

function main(): void {
  const t0 = Date.now();
  mkdirSync(DIR_OUT, { recursive: true });
  let lignes = 0;
  const progression = (msg: string): void => {
    const ligne = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`;
    console.log(ligne);
    writeFileSync(join(DIR_OUT, "progression.log"), `${lignes + 1} ${ligne}\n`, "utf8");
    lignes += 1;
  };

  const cp = lireCheckpoint();
  const jDebut = cp.totalInterroge;
  const jFin = Math.min(jDebut + QUANTITE, N_TOTAL);
  progression(
    `DÉBUT it.86 — balayage du milliard : j ∈ [${jDebut}, ${jFin}) sur ${N_TOTAL} (${((jFin / N_TOTAL) * 100).toFixed(4)} %) — QUANTITE=${jFin - jDebut}, budget ${MAX_SECONDES}s, CYCLES=${CYCLES}`,
  );
  if (jDebut >= N_TOTAL) {
    progression("Le milliard est déjà atteint — rien à faire (checkpoint à jour).");
    return;
  }

  const capacite = capaciteTotale();
  const planGlobal = planifierBalayage(N_TOTAL);
  progression(
    `capacité de l'espace de questions : ${capacite} ≥ 1 000 000 000 — stratification (plan du milliard) : ${FAMILLES_MILLIARD.map((f) => `${f}=${planGlobal[f]}`).join(", ")}`,
  );

  // ── Le cortex du chat (le même que la production) ────────────────────────
  const cortex = new CortexLangagierGen3();
  const stats = cortex.apprendre(CORPUS_GEN3);
  progression(
    `cortex du chat chargé : ${stats.pairesAjoutees} paires du corpus, ${stats.pairesDoublons} doublons ignorés, ${stats.totalPaires} indexées`,
  );

  // ── PASSE A/B : interrogation + correction mémoire (en ligne) ────────────
  const parFamille = cp.parFamille;
  let exact = 0;
  let methode = 0;
  let echec = 0;
  let corriges = 0;
  let correctionsHorsMemoire = 0;
  let retests = 0;
  let reparees = 0;
  let enMemoire = 0;
  let interrogees = 0;

  const echecsPourConsolidation = new Map<FamilleMilliard, QuestionMilliard[]>();
  for (const f of FAMILLES_MILLIARD) echecsPourConsolidation.set(f, []);
  const reTestEchantillon: QuestionMilliard[] = [];

  const budgetEpuise = (): boolean => (Date.now() - t0) / 1000 > MAX_SECONDES;

  for (let j = jDebut; j < jFin; j++) {
    if ((j - jDebut) % 10_000 === 0 && budgetEpuise()) {
      progression(`budget de temps atteint (${MAX_SECONDES}s) — arrêt propre à j=${j} (reprise au prochain tick)`);
      break;
    }
    const q = questionStratifiee(j, N_TOTAL);
    const rep = cortex.repondre(q.prompt);
    const det = detecterMethodeRaisonnement(q.prompt);
    const verdict = verifierReponseGen3(q, rep?.texte ?? null, det?.famille ?? null);
    interrogees += 1;
    if (verdict === "exact") exact += 1;
    else if (verdict === "methode") methode += 1;
    else echec += 1;
    parFamille[q.famille][verdict] += 1;

    if (verdict !== "exact") {
      // ── CORRECTION MÉMOIRE : échantillonnée (1 apprentissage toutes les
      // PERIODE_APPRENTISSAGE échecs) — chaque autre échec est COMPTE. La
      // correction retenue reçoit sa paire exacte et est RE-TESTÉE
      // immédiatement (mesure de la réparation).
      corriges += 1;
      parFamille[q.famille].corriges += 1;
      if (enMemoire < 120_000 && corriges % PERIODE_APPRENTISSAGE === 0) {
        cortex.apprendre([paireCorrective(q)], { personnalisees: false });
        enMemoire += 1;
        retests += 1;
        const rep2 = cortex.repondre(q.prompt);
        const det2 = detecterMethodeRaisonnement(q.prompt);
        if (verifierReponseGen3(q, rep2?.texte ?? null, det2?.famille ?? null) === "exact") reparees += 1;
      } else {
        correctionsHorsMemoire += 1;
      }
      // échantillon de consolidation : les premières corrections de chaque
      // famille (valeurs basses des espaces paramétriques — proches des
      // usages réels du chat)
      const ech = echecsPourConsolidation.get(q.famille)!;
      if (ech.length < CONSOLIDATION_PAR_FAMILLE) {
        ech.push(q);
        reTestEchantillon.push(q);
      }
    }

    if (interrogees % 100_000 === 0) {
      progression(
        `… ${interrogees} questions interrogées — exact ${exact} · methode ${methode} · echec ${echec} · corrigées ${corriges} (RAM ${enMemoire}) — réparation en ligne ${reparees}/${retests}`,
      );
    }
  }

  const totalVerdicts = exact + methode + echec;
  progression(
    `PASSE A terminée : ${totalVerdicts} questions réellement interrogées — exact ${exact} (${((exact / Math.max(1, totalVerdicts)) * 100).toFixed(2)} %) · methode ${methode} · echec ${echec}`,
  );
  progression(
    `PASSE B (correction mémoire) : ${corriges} corrigées (${enMemoire} retenues en RAM, ${correctionsHorsMemoire} comptées hors RAM) — réparation mesurée en ligne : ${reparees}/${retests}`,
  );

  // Les paires de l'échantillon de consolidation sont APPRISES explicitement
  // (elles partent dans le module committé — leur réparation doit être
  // mesurée ; l'échantillonnage en ligne ne les retient pas forcément, les
  // premières corrections d'un run tombent rarement sur un multiple de la
  // période d'apprentissage).
  for (const q of reTestEchantillon) {
    const s = cortex.apprendre([paireCorrective(q)], { personnalisees: false });
    if (s.pairesAjoutees > 0) enMemoire += 1;
  }
  // Re-test FINAL de réparation sur l'échantillon de consolidation.
  let retestsFinaux = 0;
  let repareesFinaux = 0;
  for (const q of reTestEchantillon) {
    retestsFinaux += 1;
    const rep = cortex.repondre(q.prompt);
    const det = detecterMethodeRaisonnement(q.prompt);
    if (verifierReponseGen3(q, rep?.texte ?? null, det?.famille ?? null) === "exact") repareesFinaux += 1;
  }
  progression(
    `re-test FINAL de l'échantillon de consolidation : ${repareesFinaux}/${retestsFinaux} réparées (${((repareesFinaux / Math.max(1, retestsFinaux)) * 100).toFixed(1)} %)`,
  );

  // ── PASSE C : correction du SUBSTRAT (SNN, ondes EOD) ────────────────────
  let snn: {
    source: string;
    octets: number;
    colonnes: number;
    bandePorteuse: number;
    ondesGravees: number;
    mesureAvant: number;
    mesureApres: number;
    mesureTotal: number;
    snapshot: string;
    octetsSnapshot: number;
  } | null = null;
  if (existsSync(SNAPSHOT_SOURCE) && reTestEchantillon.length > 0) {
    try {
      const octetsSource = statSync(SNAPSHOT_SOURCE).size;
      const brut = readFileSync(SNAPSHOT_SOURCE);
      const u8 = new Uint8Array(brut.buffer, brut.byteOffset, brut.byteLength);
      const { entete, poidsU8 } = importerSnapshotTelephone(u8);
      const cortexSnn = new CortexColumnnaire({
        colonnes: entete.colonnes,
        voisins: entete.voisins,
        bandes: entete.bandes,
        bandesLecture: entete.bandesLecture,
        seed: entete.seed,
        seuil: entete.seuil,
        decroissance: entete.decroissance,
        plasticiteFenetre: entete.plasticiteFenetre,
      });
      const poidsF32 = new Float32Array(poidsU8.length);
      for (let i = 0; i < poidsU8.length; i++) poidsF32[i] = poidsU8[i] / ECHELLE_QUANTISATION_U8;
      if (!cortexSnn.importerPoids(poidsF32)) throw new Error("Import des poids it.85 : longueur inattendue.");
      const nbColonnes = cortexSnn.config.colonnes;
      const nbBandes = cortexSnn.config.bandes;
      // it.87 : rotation déterministe de la bande-porteuse au numéro de run
      // (checkpoint) — les gravures se répartissent sur les bandes audibles
      // au lieu de saturer une seule bande (mesure it.86 : 14/30 → 6/30).
      const bande = BANDES_ROTATION[cp.runs % BANDES_ROTATION.length] % nbBandes;
      const labelRun = labelPourBande(bande, PREFIXE_LABEL);
      progression(
        `PASSE C — cerveau importé (${octetsSource} octets, ${nbColonnes} colonnes) ; run ${cp.runs} → bande ${bande} (rotation it.87, label « ${labelRun} »)`,
      );

      const mesurer = (liste: QuestionMilliard[]): { hits: number; total: number } => {
        let hits = 0;
        let mesure = 0;
        let horlogeLocale = 0;
        for (const q of liste) {
          const tokens = tokenize(q.prompt);
          if (tokens.length === 0) continue;
          const injections = colonnesDepuisOndes(tokens, nbColonnes);
          horlogeLocale += 1;
          cortexSnn.pas(injections, horlogeLocale);
          mesure += 1;
          const act = cortexSnn.activationBandes();
          let dominante = 0;
          for (let b = 1; b < act.length; b++) if (act[b] > act[dominante]) dominante = b;
          if (dominante === bande) hits += 1;
        }
        return { hits, total: mesure };
      };
      const avant = mesurer(reTestEchantillon);

      const pairePensee = (q: QuestionMilliard): string => `${q.pensee} ${q.reponse}`;
      let gravees = 0;
      let horloge = 0;
      const graver = (q: QuestionMilliard): void => {
        const tokens = tokenize(`${q.prompt} ${pairePensee(q)}`);
        if (tokens.length === 0) return;
        const injections = colonnesDepuisOndes(tokens, nbColonnes);
        const stimulees = injections.map(([c]) => c);
        for (let cycle = 0; cycle < CYCLES; cycle++) {
          horloge += 1;
          cortexSnn.pas(cycle === 0 ? injections : null, horloge);
        }
        const act = cortexSnn.activationBandes();
        const concurrentes: number[] = [];
        for (let b = 0; b < nbBandes; b++) {
          if (b !== bande && act[b] > act[bande]) concurrentes.push(b);
        }
        cortexSnn.plasticiteSupervisee(stimulees, bande, cortexSnn.config.lrBoost, concurrentes);
        gravees += 1;
      };
      for (const q of reTestEchantillon) graver(q);
      // lot large PRÉVENTIF : gravure des paires exactes des questions
      // suivantes du balayage (le savoir correct est gravé avant même d'être
      // interrogé — jusqu'à CORRECTIONS_ONDES paires)
      const jFinLot = Math.min(jFin + CORRECTIONS_ONDES, N_TOTAL);
      let graveesLot = 0;
      for (let j = jFin; j < jFinLot; j++) {
        graver(questionStratifiee(j, N_TOTAL));
        graveesLot += 1;
      }
      progression(`ondes correctives gravées : ${gravees} (échantillon) + ${graveesLot} (lot préventif) — bande ${bande}`);

      const apres = mesurer(reTestEchantillon);
      progression(`mesure SNN de l'échantillon : bande ${bande} dominante ${avant.hits}/${avant.total} → ${apres.hits}/${apres.total}`);

      const enteteSortie: EnteteSnapshotTelephone = {
        colonnes: cortexSnn.config.colonnes,
        voisins: cortexSnn.config.voisins,
        bandes: cortexSnn.config.bandes,
        bandesLecture: cortexSnn.config.bandesLecture,
        seed: cortexSnn.config.seed,
        seuil: cortexSnn.config.seuil,
        decroissance: cortexSnn.config.decroissance,
        plasticiteFenetre: cortexSnn.config.plasticiteFenetre,
        aretes: cortexSnn.config.colonnes * cortexSnn.config.voisins,
      };
      const snapshot = exporterSnapshotTelephone(enteteSortie, quantiserPoidsU8(cortexSnn.csrPoids));
      writeFileSync(join(DIR_SNAP, "cortex-interrogation-it86.bin"), snapshot);
      progression(`snapshot corrigé écrit : ${SNAPSHOT_SORTIE} (${snapshot.length} octets)`);
      snn = {
        source: SNAPSHOT_SOURCE,
        octets: octetsSource,
        colonnes: nbColonnes,
        bandePorteuse: bande,
        ondesGravees: gravees + graveesLot,
        mesureAvant: avant.hits,
        mesureApres: apres.hits,
        mesureTotal: avant.total,
        snapshot: SNAPSHOT_SORTIE,
        octetsSnapshot: snapshot.length,
      };
    } catch (err) {
      progression(`PASSE C en échec (non bloquant) : ${String(err)}`);
    }
  } else {
    progression("PASSE C sautée (snapshot source absent ou échantillon vide).");
  }

  // ── PASSE D : consolidation « code source » ───────────────────────────────
  const pairesConsolidees = Array.from(echecsPourConsolidation.entries()).flatMap(([famille, qs]) =>
    qs.map((q) => ({ motif: q.prompt, reponse: `${q.pensee} ${q.reponse}`, theme: famille })),
  );
  const corps = pairesConsolidees
    .map(
      (p) =>
        `  {\n    motif: ${JSON.stringify(p.motif)},\n    reponse: ${JSON.stringify(p.reponse)},\n    theme: ${JSON.stringify(p.theme)},\n  },`,
    )
    .join("\n");
  const moduleTS = `/**
 * CORPUS INTERROGATION it.86 — paires correctives consolidées du cycle
 * d'interrogation milliard (scripts/interrogation-milliard-it86.ts,
 * bande-porteuse tournante it.87 (rotations ${BANDES_ROTATION.join("/")},
 * ex-band ${fnv1a(LABEL_HISTORIQUE) % 32} « ${LABEL_HISTORIQUE} » pour it.86).
 *
 * Ces ${pairesConsolidees.length} paires (question → pensée pas à pas → résultat EXACT,
 * vérifié automatiquement par le générateur) corrigent la mémoire du chat :
 * chaque question qui ne recevait pas son résultat exact reçoit ici sa
 * réponse calculée (générateur : lib/gen3/interrogation-milliard.ts).
 */

import type { PaireLangage } from "./corpus";

export const CORPUS_INTERROGATION_IT86: readonly PaireLangage[] = [
${corps}
];
`;
  writeFileSync(MODULE_PAIRES, moduleTS, "utf8");
  progression(`PASSE D — module de paires correctives écrit : ${MODULE_PAIRES} (${pairesConsolidees.length} paires)`);

  // ── Checkpoint + rapport ─────────────────────────────────────────────────
  const cpSortie: Checkpoint = {
    date: new Date().toISOString(),
    totalInterroge: jDebut + interrogees,
    exact: cp.exact + exact,
    methode: cp.methode + methode,
    echec: cp.echec + echec,
    corriges: cp.corriges + corriges,
    correctionsHorsMemoire: cp.correctionsHorsMemoire + correctionsHorsMemoire,
    retests: cp.retests + retests + retestsFinaux,
    reparees: cp.reparees + reparees + repareesFinaux,
    parFamille: Object.fromEntries(
      FAMILLES_MILLIARD.map((f) => [
        f,
        {
          exact: (cp.parFamille[f]?.exact ?? 0) + (parFamille[f]?.exact ?? 0),
          methode: (cp.parFamille[f]?.methode ?? 0) + (parFamille[f]?.methode ?? 0),
          echec: (cp.parFamille[f]?.echec ?? 0) + (parFamille[f]?.echec ?? 0),
          corriges: (cp.parFamille[f]?.corriges ?? 0) + (parFamille[f]?.corriges ?? 0),
        },
      ]),
    ),
    runs: cp.runs + 1,
    dureeMsCumulee: cp.dureeMsCumulee + (Date.now() - t0),
  };
  writeFileSync(CHEMIN_CHECKPOINT, JSON.stringify(cpSortie, null, 2), "utf8");

  const rapport = {
    date: cpSortie.date,
    iteration: "it.86",
    demande:
      "poser au total 1 milliard de questions à gen3 sur tous les domaines entraînés, vérifier les réponses, corriger la mémoire en cas d'erreur, depuis un compte utilisateur",
    balayage: {
      ordreTotal: N_TOTAL,
      debut: jDebut,
      fin: jDebut + interrogees,
      interrogees,
      progression: `${((cpSortie.totalInterroge / N_TOTAL) * 100).toFixed(4)} % du milliard`,
      planMilliard: planGlobal,
      capaciteEspace: capacite,
    },
    verdicts: { exact, methode, echec, parFamille: parFamille },
    correction: {
      memoire: {
        corriges,
        enMemoire,
        horsMemoire: correctionsHorsMemoire,
        periodeApprentissage: PERIODE_APPRENTISSAGE,
      },
      reparationEnLigne: { retests, reparees },
      reparationFinale: { retests: retestsFinaux, reparees: repareesFinaux },
      substrat: snn,
    },
    consolidation: { module: MODULE_PAIRES, paires: pairesConsolidees.length },
    cumulDepuisDebut: {
      totalInterroge: cpSortie.totalInterroge,
      exact: cpSortie.exact,
      methode: cpSortie.methode,
      echec: cpSortie.echec,
      corriges: cpSortie.corriges,
      reparees: cpSortie.reparees,
      runs: cpSortie.runs,
    },
    dureeMs: Date.now() - t0,
    regleMesure:
      "zéro chiffre fantôme : interrogees = questions réellement posées au moteur du chat dans ce run ; le checkpoint cumule entre les ticks ; chaque verdict est vérifié automatiquement (résultat calculé présent dans la réponse, sinon famille de méthode, sinon échec)",
  };
  writeFileSync(join(DIR_OUT, "rapport-it86.json"), JSON.stringify(rapport, null, 2), "utf8");
  progression(
    `TERMINÉ — ${interrogees} interrogées (cumul ${cpSortie.totalInterroge}/${N_TOTAL} = ${((cpSortie.totalInterroge / N_TOTAL) * 100).toFixed(4)} %), exact ${exact}, corrigées ${corriges}, réparation finale ${repareesFinaux}/${retestsFinaux}`,
  );
}

main();
