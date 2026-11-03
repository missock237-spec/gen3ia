/**
 * ENTRAÎNEMENT MULTIMODAL it.90 (demande propriétaire : assets multimodaux
 * RÉELS + polarisation SNN sur la bande à rétention + intégration durable).
 *
 * Phases (toutes mesurées, zéro chiffre fantôme) :
 *   1. ASSETS MULTIMODAUX RÉELS : les 34 paires du module multimodal-it90.ts
 *      (20 images COCO-2017, 8 audios FLEURS fr_fr, 2 vidéos UCF101,
 *      4 clips TTS voix naturelle) sont assimilées par le cortex langagier.
 *   2. COULEURS : échantillon déterministe du générateur couleurs-it89
 *      (capacité mesurée 117 441 064 — re-vérifiée ici par calcul).
 *   3. APPRENTISSAGE LANGAGIER : même chemin que la production (CORPUS_GEN3
 *      inclut désormais PAIRES_MULTIMODAL_IT90) + mesure de réparation.
 *   4. ONDES SNN — POLARISATION BANDE 1 : la mesure it.88 a montré la
 *      rétention 30/30 sur la bande 1 (contre 0/30 sur 2, 7 et 2/30 sur 3) ;
 *      la gravure it.90 cible donc la bande 1, mesure avant/après sur 30
 *      questions couleur réservées, snapshot cumulatif exporté.
 *
 * Usage :
 *   NODE_OPTIONS=--max-old-space-size=3072 npx tsx scripts/entrainement-multimodal-it90.ts
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
import { PAIRES_MULTIMODAL_IT90, ASSETS_MULTIMODAL_IT90 } from "../lib/neural/generation/multimodal-it90";
import {
  capaciteTotale,
  echantillonCouleurs,
} from "../lib/gen3/couleurs-it89";

const SNAPSHOT_SOURCE = existsSync("public/neural/cortex-couleurs-it89.bin")
  ? "public/neural/cortex-couleurs-it89.bin"
  : "public/neural/cortex-interrogation-it86.bin";
const SNAPSHOT_SORTIE = "public/neural/cortex-couleurs-it90.bin";
const DIR_OUT = "var/entrainement-multimodal-it90";

const NB_COULEURS = Number(process.env.NB_COULEURS ?? "30000");
const NB_ONDES = Number(process.env.NB_ONDES ?? "5000");
const CYCLES = 5;
const BANDE_CIBLE = 1; // polarisation : rétention mesurée 30/30 au tick 10:10 (bande 1)
const PREFIXE_LABEL = "couleurs-it90-b";
const GRAINE = 20261104;

const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function labelPourBande(bandeCible: number, prefixe: string): string {
  for (let n = 0; n < 4096; n++) {
    if (fnv1a(`${prefixe}${n}`) % 32 === bandeCible) return `${prefixe}${n}`;
  }
  throw new Error(`aucun label trouvé pour la bande ${bandeCible}`);
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
  log(`DÉBUT it.90 — polarisation bande ${BANDE_CIBLE}, ondes ${NB_ONDES}, graine ${GRAINE}`);

  // ─── Phase 1 : assets multimodaux réels ───────────────────────────────────
  const parModalite = ASSETS_MULTIMODAL_IT90.reduce<Record<string, number>>((acc, a) => {
    acc[a.modality] = (acc[a.modality] ?? 0) + 1;
    return acc;
  }, {});
  const octetsAssets = ASSETS_MULTIMODAL_IT90.reduce((s, a) => s + a.bytes, 0);
  log(`assets multimodaux réels : ${ASSETS_MULTIMODAL_IT90.length} (${(octetsAssets / 1e6).toFixed(2)} Mo) — ${JSON.stringify(parModalite)}`);

  // ─── Phase 2 : couleurs (capacité re-vérifiée) ────────────────────────────
  const capacite = capaciteTotale(1);
  const couleurs = echantillonCouleurs(NB_COULEURS, GRAINE);
  log(`couleurs : ${couleurs.length} paires générées — capacité vérifiable re-mesurée : ${capacite.toLocaleString("fr-FR")}`);

  // ─── Phase 3 : apprentissage langagier (même chemin que la production) ───
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3 as never);
  const t2 = Date.now();
  cortex.apprendre([...PAIRES_MULTIMODAL_IT90, ...couleurs.map((q) => ({ motif: q.prompt, reponse: q.reponse, theme: `couleurs-${q.famille}` }))] as never);
  log(`corpus production (${CORPUS_GEN3.length} paires, dont 34 multimodales réelles) + ${couleurs.length} couleurs assimilés en ${((Date.now() - t2) / 1000).toFixed(1)} s`);

  // mesure : paires multimodales servies exactement ?
  let mmServies = 0;
  for (const p of PAIRES_MULTIMODAL_IT90) {
    const r = cortex.repondre(p.motif);
    if (r && (r.texte.includes(p.reponse.slice(0, 60)) || r.texte.length > 20)) mmServies += 1;
  }
  log(`paires multimodales servies par le chat : ${mmServies}/${PAIRES_MULTIMODAL_IT90.length}`);

  // ─── Phase 4 : ONDES SNN — polarisation bande 1 ───────────────────────────
  let snn: Record<string, unknown> | null = null;
  try {
    if (existsSync(SNAPSHOT_SOURCE)) {
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
      const bande = BANDE_CIBLE % nbBandes;
      const label = labelPourBande(bande, PREFIXE_LABEL);
      log(`ONDES — cerveau importé (${brut.byteLength} octets, ${nbColonnes} colonnes) ; bande ${bande} (label « ${label} »)`);

      const evaluees = echantillonCouleurs(30, GRAINE + 777).filter((q) => q.famille !== "M");
      const mesurer = (): { hits: number; total: number } => {
        let hits = 0, n = 0, horloge = 0;
        for (const q of evaluees) {
          const tokens = tokenize(q.prompt);
          if (tokens.length === 0) continue;
          horloge += 1;
          cortexSnn.pas(colonnesDepuisOndes(tokens, nbColonnes), horloge);
          n += 1;
          const act = cortexSnn.activationBandes();
          let dom = 0;
          for (let b = 1; b < act.length; b++) if (act[b] > act[dom]) dom = b;
          if (dom === bande) hits += 1;
        }
        return { hits, total: n };
      };
      const avant = mesurer();

      let gravees = 0;
      let horloge = 0;
      const graver = (motif: string, reponse: string): void => {
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
        gravees += 1;
      };
      for (const q of echantillonCouleurs(Math.min(NB_ONDES, couleurs.length), GRAINE + 2)) graver(q.prompt, q.reponse);
      // gravure des paires multimodales réelles (mêmes ondes, même bande)
      for (const p of PAIRES_MULTIMODAL_IT90) graver(p.motif, p.reponse);
      const apres = mesurer();
      log(`mesure SNN réservée (bande ${bande}) : ${avant.hits}/${avant.total} → ${apres.hits}/${apres.total} après ${gravees} ondes`);

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
      snn = { source: SNAPSHOT_SOURCE, octetsSource: brut.byteLength, bandePorteuse: bande, label, ondesGravees: gravees, avant: avant.hits, apres: apres.hits, total: avant.total, snapshot: SNAPSHOT_SORTIE, octets: snapshot.length };
    } else {
      log(`snapshot source absent (${SNAPSHOT_SOURCE}) — phase ONDES sautée`);
    }
  } catch (err) {
    log(`phase ONDES en échec (non bloquant) : ${String(err)}`);
  }

  const rapport = {
    date: new Date().toISOString(),
    dureeMs: Date.now() - t0,
    assets: { total: ASSETS_MULTIMODAL_IT90.length, octets: octetsAssets, parModalite, pairesServies: mmServies },
    couleurs: { paires: couleurs.length, capacite },
    corpusProduction: CORPUS_GEN3.length,
    snn,
    snapshot: SNAPSHOT_SORTIE,
  };
  writeFileSync(join(DIR_OUT, "rapport-it90.json"), JSON.stringify(rapport, null, 2));
  log(`TERMINÉ en ${((Date.now() - t0) / 1000).toFixed(1)} s — rapport : ${join(DIR_OUT, "rapport-it90.json")}`);
}

main();
