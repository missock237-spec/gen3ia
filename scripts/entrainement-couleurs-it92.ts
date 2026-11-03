/**
 * ENTRAÎNEMENT COULEURS it.92 (demande propriétaire : 10 M couleurs /
 * propriétés / mélanges — consolidation SNN par polarisation de bande).
 *
 * Héritage mesuré :
 *   · it.88 — première polarisation bande 1 : 11/30 → 30/30 ;
 *   · it.89 — bande 3 SANS plasticitéSupervisée : 2/30 → 2/30 (échec) ;
 *   · it.90 — bande 1 AVEC plasticitéSupervisée : 12/30 → 29/30 (méthode validée) ;
 *   · it.92 — MÊME méthode (plasticitéSupervisée, 5 cycles/onde) sur la
 *     BANDE 2, bande suivante de la rotation [1,2,3] : la bande 1 est
 *     consolidée (29/30), la bande 2 devient porteuse secondaire.
 *
 * Phases (toutes mesurées) :
 *   1. Import du snapshot cumulatif cortex-couleurs-it90.bin (état SNN
 *      porté par it.90) — fallback it89 puis interrogation-it86.
 *   2. Mesure AVANT sur 30 questions couleur réservées (graine fraîche,
 *      ≠ réservées it.90) — honnêteté : la baseline est mesurée, pas supposée.
 *   3. Gravure NB_ONDES ondes couleurs (voies reconnaissance/propriétés/
 *      mélanges du générateur injectif) + 34 paires multimodales réelles,
 *      5 cycles/onde, plasticitéSupervisée contre les bandes concurrentes.
 *   4. Mesure APRÈS sur le même jeu réservé + snapshot cumulatif exporté.
 *
 * Usage :
 *   BANDE=2 NB_ONDES=5000 NODE_OPTIONS=--max-old-space-size=3072 \
 *     npx tsx scripts/entrainement-couleurs-it92.ts
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
import { PAIRES_MULTIMODAL_IT90 } from "../lib/neural/generation/multimodal-it90";
import {
  capaciteTotale,
  echantillonCouleurs,
} from "../lib/gen3/couleurs-it89";

const SNAPSHOT_SOURCE = existsSync("public/neural/cortex-couleurs-it90.bin")
  ? "public/neural/cortex-couleurs-it90.bin"
  : existsSync("public/neural/cortex-couleurs-it89.bin")
    ? "public/neural/cortex-couleurs-it89.bin"
    : "public/neural/cortex-interrogation-it86.bin";
const SNAPSHOT_SORTIE = "public/neural/cortex-couleurs-it92.bin";
const DIR_OUT = "var/entrainement-couleurs-it92";

const BANDE_CIBLE = Number(process.env.BANDE ?? "2");
const NB_COULEURS = Number(process.env.NB_COULEURS ?? "30000");
const NB_ONDES = Number(process.env.NB_ONDES ?? "5000");
const CYCLES = 5;
const PREFIXE_LABEL = "couleurs-it92-b";
const GRAINE = Number(process.env.GRAINE ?? "20261105");

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
  log(`DÉBUT it.92 — polarisation bande ${BANDE_CIBLE}, ondes ${NB_ONDES}, graine ${GRAINE}, source ${SNAPSHOT_SOURCE}`);

  // ─── Phase 1 : capacité couleurs (re-vérification par calcul) ─────────────
  const capacite = capaciteTotale(1);
  const couleurs = echantillonCouleurs(NB_COULEURS, GRAINE);
  log(`couleurs : ${couleurs.length} paires générées — capacité vérifiable re-mesurée : ${capacite.toLocaleString("fr-FR")}`);

  // ─── Phase 2..5 : SNN (import → mesure avant → gravure → mesure après) ────
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
      log(`SNN importé (${brut.byteLength} octets, ${nbColonnes} colonnes, ${nbBandes} bandes) ; bande cible ${bande} (label « ${label} »)`);

      // Baseline sur graine FRAÎCHE (≠ it.90 : 20261104+777 → ici GRAINE+777)
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
      log(`mesure AVANT (bande ${bande}, 30 questions réservées graine ${GRAINE + 777}) : ${avant.hits}/${avant.total}`);

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
      // les 34 paires multimodales réelles gravées dans la MÊME bande
      for (const p of PAIRES_MULTIMODAL_IT90) graver(p.motif, p.reponse);
      const apres = mesurer();
      log(`mesure APRÈS (bande ${bande}) : ${apres.hits}/${apres.total} après ${gravees} ondes (${CYCLES} cycles/onde, plasticitéSupervisée)`);

      const enteteSortie: EnteteSnapshotTelephone = {
        colonnes: cortexSnn.config.colonnes, voisins: cortexSnn.config.voisins,
        bandes: cortexSnn.config.bandes, bandesLecture: cortexSnn.config.bandesLecture,
        seed: cortexSnn.config.seed, seuil: cortexSnn.config.seuil,
        decroissance: cortexSnn.config.decroissance, plasticiteFenetre: cortexSnn.config.plasticiteFenetre,
        aretes: cortexSnn.config.colonnes * cortexSnn.config.voisins,
      };
      const snapshot = exporterSnapshotTelephone(enteteSortie, quantiserPoidsU8(cortexSnn.csrPoids));
      writeFileSync(SNAPSHOT_SORTIE, snapshot);
      log(`snapshot cumulatif écrit : ${SNAPSHOT_SORTIE} (${snapshot.length} octets)`);
      snn = { source: SNAPSHOT_SOURCE, octetsSource: brut.byteLength, bandePorteuse: bande, label, ondesGravees: gravees, avant: avant.hits, apres: apres.hits, total: avant.total, graine: GRAINE, snapshot: SNAPSHOT_SORTIE, octets: snapshot.length };
    } else {
      log(`snapshot source absent (${SNAPSHOT_SOURCE}) — phase SNN sautée`);
    }
  } catch (err) {
    log(`phase SNN en échec (non bloquant) : ${String(err)}`);
  }

  const rapport = {
    date: new Date().toISOString(),
    dureeMs: Date.now() - t0,
    couleurs: { paires: couleurs.length, capacite, bande: BANDE_CIBLE },
    multimodales: PAIRES_MULTIMODAL_IT90.length,
    snn,
    snapshot: SNAPSHOT_SORTIE,
  };
  writeFileSync(join(DIR_OUT, "rapport-it92.json"), JSON.stringify(rapport, null, 2));
  log(`TERMINÉ en ${((Date.now() - t0) / 1000).toFixed(1)} s — rapport : ${join(DIR_OUT, "rapport-it92.json")}`);
}

main();
