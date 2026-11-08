/**
 * ENTRAÎNEMENT MULTIMODAL it.128 (demande propriétaire Job 478451 :
 * « Utilise Hugging Face pour obtenir ou générer des ressources
 * multimodales : images photoréalistes, vidéos réalistes et audios avec
 * voix naturelles. Exploite-les pour améliorer l'analyse et la génération
 * multimodales de Gen3 »).
 *
 * it.128 = fenêtre réelle SUIVANTE (mesurée le 07 nov 2026) :
 *   - 20 images COCO-2017 (rafaelpadilla/coco2017, val, offset 724,
 *     après l'offset 704 d'it.127) — annotations officielles ;
 *   - 8 audios FLEURS fr_fr (validation, offset 276, après l'offset 268
 *     d'it.127) — transcriptions officielles ;
 *   - 0 vidéo UCF101 (offset 4 → 0 ligne : fenêtre épuisée depuis it.90,
 *     preuve refaite à chaque tick).
 *
 * Ce script :
 *   1. APPRENTISSAGE LANGAGIER : même chemin que la production (CORPUS_GEN3
 *      inclut désormais PAIRES_MULTIMODAL_IT128) + mesure de service des
 *      28 nouvelles paires ;
 *   2. ONDES SNN : gravure des 28 paires sur la bande 9 (multimodal —
 *      celle d'it.127) avec plasticité supervisée, depuis le snapshot
 *      cumulatif it.127 (les bandes 0..8 ne sont PAS retouchées sauf
 *      concurrence mesurée) ; mesure AVANT/APRÈS sur les motifs des
 *      nouvelles paires (rétention — assets réels à espace fini) ;
 *   3. SNAPSHOT cumulatif exporté + rapport honnête.
 *
 * Usage :
 *   NODE_OPTIONS=--max-old-space-size=3072 npx tsx scripts/entrainement-multimodal-it128.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { ASSETS_MULTIMODAL_IT128, PAIRES_MULTIMODAL_IT128 } from "../lib/neural/generation/multimodal-it128";

const SNAPSHOT_SOURCE = "public/neural/cortex-multimodal-it127.bin";
const SNAPSHOT_SORTIE = "public/neural/cortex-multimodal-it128.bin";
const DIR_OUT = "var/entrainement-multimodal-it128";

const CYCLES = Number(process.env.CYCLES ?? "4");
const ONDES_CIBLE = Number(process.env.ONDES_CIBLE ?? "2000");
const BANDE_MULTIMODAL = 9;

const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function ondeToken(token: string, position: number): { w: number; phi: number; a: number } {
  const h = fnv1a(token);
  const w = 0.25 + (h / 0xffffffff) * 1.5;
  const phi = ((h / 0xffffffff) * 2 * Math.PI + position * 1.6180339) % (2 * Math.PI);
  const a = Math.min(1, 0.25 + token.length / 24);
  return { w, phi, a };
}

function colonnesDepuisOndes(tokens: string[], nbColonnes: number): Array<[number, number]> {
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

function main(): void {
  mkdirSync(DIR_OUT, { recursive: true });
  const t0 = Date.now();
  log(`DÉBUT it.128 — perception multimodale, fenêtre réelle suivante (${ASSETS_MULTIMODAL_IT128.length} assets)`);

  const octetsAssets = ASSETS_MULTIMODAL_IT128.reduce((s, a) => s + a.bytes, 0);
  // Honnêteté : chaque asset du module DOIT exister sur le disque (fichier réel servi).
  const absents = ASSETS_MULTIMODAL_IT128.filter((a) => !existsSync(join("public", a.file)));
  if (absents.length > 0) throw new Error(`assets déclarés absents du disque : ${absents.map((a) => a.file).join(", ")}`);
  log(`assets multimodaux réels : ${ASSETS_MULTIMODAL_IT128.length} (${(octetsAssets / 1e6).toFixed(2)} Mo) — tous présents sur le disque, 0 fantôme`);

  // ─── Phase 1 : apprentissage langagier (même chemin que la production) ───
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3 as never);
  const t2 = Date.now();
  log(`corpus production (${CORPUS_GEN3.length} paires) appris — dont ${PAIRES_MULTIMODAL_IT128.length} paires it.128`);
  let servies = 0;
  let exactes = 0;
  for (const p of PAIRES_MULTIMODAL_IT128) {
    const r = cortex.repondre(p.motif);
    if (!r) continue;
    if (r.texte.includes(p.reponse.slice(0, 60))) exactes += 1;
    if (r.texte.length > 20) servies += 1;
  }
  log(`paires it.128 servies par le chat : ${servies}/${PAIRES_MULTIMODAL_IT128.length} (réponse exacte : ${exactes}/${PAIRES_MULTIMODAL_IT128.length}) en ${((Date.now() - t2) / 1000).toFixed(1)} s`);

  // ─── Phase 2 : ONDES SNN — bande 9 multimodale ───────────────────────────
  let snn: Record<string, unknown> | null = null;
  try {
    if (!existsSync(SNAPSHOT_SOURCE)) throw new Error(`snapshot source absent : ${SNAPSHOT_SOURCE}`);
    const brut = readFileSync(SNAPSHOT_SOURCE);
    const u8 = new Uint8Array(brut.buffer, brut.byteOffset, brut.byteLength);
    const { entete, poidsU8 } = importerSnapshotTelephone(u8);
    const cortexSnn = new CortexColumnnaire({
      colonnes: entete.colonnes, voisins: entete.voisins, bandes: entete.bandes,
      bandesLecture: entete.bandesLecture, seed: entete.seed,
      seuil: entete.seuil, decroissance: entete.decroissance, plasticiteFenetre: entete.plasticiteFenetre,
    });
    const poidsF32 = new Float32Array(poidsU8.length);
    for (let i = 0; i < poidsU8.length; i++) poidsF32[i] = poidsU8[i] / ECHELLE_QUANTISATION_U8;
    if (!cortexSnn.importerPoids(poidsF32)) throw new Error("import poids : longueur inattendue");
    const nbColonnes = cortexSnn.config.colonnes;
    const nbBandes = cortexSnn.config.bandes;
    log(`ONDES — cerveau importé (${brut.byteLength} octets, ${nbColonnes} colonnes, ${nbBandes} bandes)`);

    // ─── MESURE PRIMAIRE (déterministe, au niveau des poids) ───────────────
    // Constat mesuré (sondes it.96b/c + rapports it.92/94) : la résonance
    // 1-pas est une loterie de collisions — une colonne ne spike que si
    // ≥ 2 tokens tombent sur la MÊME colonne (injection × 0,9 ≥ seuil 1),
    // ~3 % des paires ; les it.92/94 ne mesuraient eux-mêmes que 12→29 et
    // 0-5 hits. La preuve DÉTERMINISTE de la gravure est le delta de
    // POIDS : arêtes des colonnes stimulées vers la bande 9, somme et
    // moyenne, AVANT vs APRÈS gravure (boost → 1.0).
    const poidsVersBande = (texte: string, bande: number): { aretes: number; somme: number; moyenne: number } => {
      const tokens = tokenize(texte);
      if (tokens.length === 0) return { aretes: 0, somme: 0, moyenne: 0 };
      const injections = colonnesDepuisOndes(tokens, nbColonnes);
      const parBande = Math.floor(nbColonnes / nbBandes);
      const debutBande = bande * parBande;
      const finBande = Math.min(nbColonnes, debutBande + parBande);
      let aretes = 0;
      let somme = 0;
      for (const [c] of injections) {
        const base = c * cortexSnn.config.voisins;
        for (let k = 0; k < cortexSnn.config.voisins; k++) {
          const p = base + k;
          const cible = cortexSnn.csrCible[p]!;
          if (cible >= debutBande && cible < finBande) {
            aretes += 1;
            somme += cortexSnn.csrPoids[p]!;
          }
        }
      }
      return { aretes, somme, moyenne: aretes > 0 ? somme / aretes : 0 };
    };

    // ─── MESURE SECONDAIRE (résonance, protocole it.94c documenté) ────────
    let horlogeMesure = 0;
    interface MesureUne { hit: number; sepTrained: number; top3: number; dom: number }
    const mesurerBande = (texte: string, bande: number): MesureUne | null => {
      const tokens = tokenize(texte);
      if (tokens.length === 0) return null;
      const injections = colonnesDepuisOndes(tokens, nbColonnes);
      let act: number[] = [];
      for (let cycle = 0; cycle < 4; cycle++) {
        horlogeMesure += 1;
        cortexSnn.pas(cycle === 0 ? injections : null, horlogeMesure);
        act = cortexSnn.activationBandes();
      }
      cortexSnn.reinitialiserEnergies();
      let dom = 0;
      for (let b = 1; b < act.length; b++) if (act[b] > act[dom]) dom = b;
      const tri = act.map((v, b) => [b, v] as const).sort((x, y) => y[1] - x[1]);
      const top3 = new Set(tri.slice(0, 3).map(([b]) => b));
      let maxTrainedB = 2;
      for (let b = 3; b <= 9; b++) if (act[b] > act[maxTrainedB]) maxTrainedB = b;
      return {
        hit: dom === bande ? 1 : 0,
        sepTrained: maxTrainedB === bande ? 1 : 0,
        top3: top3.has(bande) ? 1 : 0,
        dom,
      };
    };
    const mesures = (questions: readonly string[]): { hits: number; sep: number; top3: number; total: number } => {
      const agg = { hits: 0, sep: 0, top3: 0, total: 0 };
      for (const q of questions) {
        const r = mesurerBande(q, BANDE_MULTIMODAL);
        if (!r) continue;
        agg.hits += r.hit; agg.sep += r.sepTrained; agg.top3 += r.top3; agg.total += 1;
      }
      return agg;
    };

    const questions = PAIRES_MULTIMODAL_IT128.map((p) => `${p.motif} ${p.reponse}`);
    const avant = mesures(questions);
    log(`AVANT : b9 dom:${avant.hits}/${avant.total} sepTrained(b2..b9):${avant.sep}/${avant.total} top3:${avant.top3} (état hérité d'it.127, avant gravure it.128 — onde complète, 4 cycles)`);
    const avantPoids = questions.map((q) => poidsVersBande(q, BANDE_MULTIMODAL));
    const sommeAvant = avantPoids.reduce((s, m) => s + m.somme, 0);
    const aretesAvant = avantPoids.reduce((s, m) => s + m.aretes, 0);
    log(`AVANT poids : ${aretesAvant} arêtes stimulées→b9, somme ${sommeAvant.toFixed(1)}, moyenne ${aretesAvant > 0 ? (sommeAvant / aretesAvant).toFixed(4) : "0"}`);

    // Gravure (plasticité supervisée vers la bande 9 — mécanisme réel it.92/94)
    let gravees = 0;
    let horloge = 0;
    const graver = (motif: string, reponse: string, bande: number): void => {
      const tokens = tokenize(`${motif} ${reponse}`);
      if (tokens.length === 0) return;
      const injections = colonnesDepuisOndes(tokens, nbColonnes);
      const stimulees = injections.map(([c]) => c);
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        horloge += 1;
        cortexSnn.pas(cycle === 0 ? injections : null, horloge);
      }
      const act = cortexSnn.activationBandes();
      const concurrentes: number[] = [];
      for (let b = 0; b < nbBandes; b++) if (b !== bande && act[b] > act[bande]) concurrentes.push(b);
      cortexSnn.plasticiteSupervisee(stimulees, bande, cortexSnn.config.lrBoost, concurrentes);
      // REPOS entre présentations (it.96 — constat mesuré) : les boosts
      // répétés portent les arêtes gravées à 1.0 et la cascade de spikes
      // grossit d'onde en onde (4,2 s par onde à l'onde 15 sur 1 048 576
      // colonnes). reinitialiserEnergies() draine la dynamique (énergies,
      // file d'attente, résonances) SANS toucher aux poids appris — la
      // mémoire gravée reste intacte, le coût par onde redevient ~ms.
      cortexSnn.reinitialiserEnergies();
      gravees += 1;
    };
    const reps = Math.max(1, Math.ceil(ONDES_CIBLE / PAIRES_MULTIMODAL_IT128.length));
    for (let rep = 0; rep < reps; rep++) {
      for (let pi = 0; pi < PAIRES_MULTIMODAL_IT128.length; pi++) {
        const tGrave = Date.now();
        const p = PAIRES_MULTIMODAL_IT128[pi];
        graver(p.motif, p.reponse, BANDE_MULTIMODAL);
        const duree = Date.now() - tGrave;
        if (rep === 0 && (duree > 2000 || pi < 3 || pi === PAIRES_MULTIMODAL_IT128.length - 1)) {
          log(`wave rep0 ${pi + 1}/${PAIRES_MULTIMODAL_IT128.length} — ${duree} ms`);
        }
      }
      if (rep === 0 || rep === reps - 1 || rep % 12 === 11) log(`gravure rep ${rep + 1}/${reps} — ${gravees} ondes gravées à ce stade`);
    }
    log(`gravure : ${gravees} ondes (${PAIRES_MULTIMODAL_IT128.length} paires × ${reps} répétitions) → bande ${BANDE_MULTIMODAL}`);

    const apres = mesures(questions);
    log(`APRÈS : b9 dom:${apres.hits}/${apres.total} sepTrained(b2..b9):${apres.sep}/${apres.total} top3:${apres.top3}`);
    const apresPoids = questions.map((q) => poidsVersBande(q, BANDE_MULTIMODAL));
    const sommeApres = apresPoids.reduce((s, m) => s + m.somme, 0);
    const aretesApres = apresPoids.reduce((s, m) => s + m.aretes, 0);
    log(`APRÈS poids : ${aretesApres} arêtes stimulées→b9, somme ${sommeApres.toFixed(1)}, moyenne ${aretesApres > 0 ? (sommeApres / aretesApres).toFixed(4) : "0"} (delta gravure : ${aretesAvant > 0 && sommeAvant > 0 ? ((sommeApres - sommeAvant) / sommeAvant * 100).toFixed(1) : "n/a"} %)`);

    const enteteSortie: EnteteSnapshotTelephone = {
      colonnes: cortexSnn.config.colonnes, voisins: cortexSnn.config.voisins,
      bandes: cortexSnn.config.bandes, bandesLecture: cortexSnn.config.bandesLecture,
      seed: cortexSnn.config.seed, seuil: cortexSnn.config.seuil,
      decroissance: cortexSnn.config.decroissance, plasticiteFenetre: cortexSnn.config.plasticiteFenetre,
      aretes: cortexSnn.config.colonnes * cortexSnn.config.voisins,
    };
    const snapshot = exporterSnapshotTelephone(enteteSortie, quantiserPoidsU8(cortexSnn.csrPoids));
    writeFileSync(SNAPSHOT_SORTIE, snapshot);
    log(`snapshot écrit : ${SNAPSHOT_SORTIE} (${snapshot.length} octets)`);
    snn = {
      source: SNAPSHOT_SOURCE, octetsSource: brut.byteLength, ondesGravees: gravees,
      bande: BANDE_MULTIMODAL,
      mesurePoids: {
        avant: { aretes: aretesAvant, somme: sommeAvant, moyenne: aretesAvant > 0 ? sommeAvant / aretesAvant : 0 },
        apres: { aretes: aretesApres, somme: sommeApres, moyenne: aretesApres > 0 ? sommeApres / aretesApres : 0 },
        type: "arêtes des colonnes stimulées (onde complète motif+réponse) vers la bande 9 — mesure déterministe du niveau des poids",
      },
      typeMesure: "rétention (assets réels, onde gravée complète motif+réponse, 4 cycles) + mesure déterministe des poids",
      avant, apres,
      noteMesure: "MESURE PRIMAIRE = delta de poids (déterministe — arêtes stimulées→b9, boost lrBoost → 1.0). MESURE SECONDAIRE = résonance (protocole it.94c : 4 cycles, onde complète) — limité structurellement par les collisions (une colonne ne spike que si injection × 0,9 ≥ seuil 1, ~3 % des paires — sondes it.96b/c) ; les it.92/94 ne mesuraient eux-mêmes que 12→29 et 0-5 hits. dominance stricte = b9 #1 de toutes (concurrence b0 999 935 paires, b1 101 138 ondes) ; sepTrained = b9 #1 parmi b2..b9.",
      snapshot: SNAPSHOT_SORTIE, octets: snapshot.length,
    };
  } catch (err) {
    log(`phase ONDES en échec (non bloquant) : ${String(err)}`);
  }

  const rapport = {
    date: new Date().toISOString(),
    dureeMs: Date.now() - t0,
    multimodal: {
      total: ASSETS_MULTIMODAL_IT128.length,
      parModalite: {
        image: ASSETS_MULTIMODAL_IT128.filter((a) => a.modality === "image").length,
        audio: ASSETS_MULTIMODAL_IT128.filter((a) => a.modality === "audio").length,
        video: ASSETS_MULTIMODAL_IT128.filter((a) => a.modality === "video").length,
      },
      octets: octetsAssets,
      fenetres: {
        image: "rafaelpadilla/coco2017#default/val offset 724 (20) — après offset 704 (it.127)",
        audio: "google/fleurs#fr_fr/validation offset 276 (8) — après offset 268 (it.127)",
        video: "sayakpaul/ucf101-subset#default/train offset 4 (0 — fenêtre épuisée depuis it.90, preuve refaite)",
      },
      pairesServies: servies,
      pairesExactes: exactes,
    },
    corpusProduction: CORPUS_GEN3.length,
    snn,
    snapshot: SNAPSHOT_SORTIE,
  };
  writeFileSync(join(DIR_OUT, "rapport-it128.json"), JSON.stringify(rapport, null, 2));
  // Copie du rapport dans var-copie (convention de la chaîne de ticks)
  writeFileSync("var-copie/rapport-it128.json", JSON.stringify(rapport, null, 2));
  log(`TERMINÉ en ${((Date.now() - t0) / 1000).toFixed(1)} s — rapport : ${join(DIR_OUT, "rapport-it128.json")}`);
}

main();
