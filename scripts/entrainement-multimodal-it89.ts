/**
 * ENTRAÎNEMENT MULTIMODAL it.89 (demande propriétaire : datasets
 * professionnels HF/Kaggle + couleurs 10M + exemples de haute qualité).
 *
 * Phases (toutes mesurées, zéro chiffre fantôme) :
 *   1. SOURCES PROFESSIONNELLES v4 : les 19 domaines JSONL téléchargés du
 *      dépôt HF du propriétaire (Kings237/gen3ia-media-engine, jeton HF
 *      vérifié) — échantillon déterministe à DÉCALAGE NOUVEAU (graine
 *      it.89) pour assimiler des lignes fraîches vis-à-vis de it.84.
 *   2. COULEURS : échantillon déterministe du générateur couleurs-it89
 *      (reconnaissance/propriétés/mélanges/décomposition/complémentaire)
 *      + EXEMPLES PROPRES de haute qualité générés depuis la palette
 *      (module corpus committé pour le chat).
 *   3. APPRENTISSAGE LANGAGIER : cortex du chat (même chemin que la
 *      production) + mesure de réparation sur échantillon réservé.
 *   4. ONDES SNN : snapshot cumulatif importé, gravure bande-porteuse
 *      « reconnaissance-couleurs » (bande 3, région audible CSR),
 *      mesure avant/après sur 30 questions réservées, snapshot exporté.
 *
 * Usage :
 *   NODE_OPTIONS=--max-old-space-size=3072 npx tsx scripts/entrainement-multimodal-it89.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
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
import {
  capaciteTotale,
  echantillonCouleurs,
  PALETTE,
  parNom,
  questionCouleur,
  questionMelange,
} from "../lib/gen3/couleurs-it89";

const DIR_V4 = "var/datasets-hf";
const DIR_OUT = "var/entrainement-multimodal-it89";
const SNAPSHOT_SOURCE = existsSync("public/neural/cortex-couleurs-it89.bin")
  ? "public/neural/cortex-couleurs-it89.bin"
  : existsSync("public/neural/cortex-interrogation-it86.bin")
    ? "public/neural/cortex-interrogation-it86.bin"
    : "public/neural/cortex-raisonnement-it85.bin";
const SNAPSHOT_SORTIE = "public/neural/cortex-couleurs-it89.bin";
const MODULE_CORPUS = "lib/neural/generation/corpus-couleurs-it89.ts";

const DOMAINES_V4 = [
  "math", "sciences", "reasoning", "problem_solving", "nlp_comprehension",
  "text_generation", "conversational_memory", "contextual_understanding",
  "intent_recognition", "professions", "databases", "tools", "code_v4",
  "security_v4", "image_analysis", "video_v4", "voice_speech",
  "audio_understanding", "multimodal_v4",
] as const;

const PAR_DOMAINE_V4 = Number(process.env.PAR_DOMAINE_V4 ?? "200");
const NB_COULEURS = Number(process.env.NB_COULEURS ?? "30000");
const NB_ONDES = Number(process.env.NB_ONDES ?? "5000");
const CYCLES = 5;
const BANDE_CIBLE = 3; // audible CSR (mesure it.88 : rétention 30/30 sur bande 1, 0/30 sur 7 et 2 — bande 3 mesurée 2/30)
const PREFIXE_LABEL = "couleurs-it89-b";
const GRAINE = 20261103;

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

// ─── Phase 1 : sources professionnelles v4 ────────────────────────────────

interface PaireV4 { motif: string; reponse: string; theme: string; source: string }

function echantillonV4(): { paires: PaireV4[]; lignesParDomaine: Record<string, number>; totalLignes: number; octets: number } {
  const paires: PaireV4[] = [];
  const lignesParDomaine: Record<string, number> = {};
  let totalLignes = 0;
  let octets = 0;
  for (const d of DOMAINES_V4) {
    const f = join(DIR_V4, `${d}.jsonl`);
    if (!existsSync(f)) {
      log(`v4 ABSENT ${d} (téléchargement requis)`);
      continue;
    }
    octets += statSync(f).size;
    const lignes = readFileSync(f, "utf-8").split("\n").filter((l) => l.trim().length > 0);
    lignesParDomaine[d] = lignes.length;
    totalLignes += lignes.length;
    // échantillon déterministe à décalage neuf (graine it.89) : pas variable
    const pas = Math.max(1, Math.floor(lignes.length / Math.min(PAR_DOMAINE_V4, lignes.length)));
    let pris = 0;
    for (let i = (GRAINE % pas); i < lignes.length && pris < PAR_DOMAINE_V4; i += pas) {
      try {
        const o = JSON.parse(lignes[i]) as { instruction?: string; input?: string; output?: string };
        if (!o.output || o.output.length < 5) continue;
        const motif = `${o.instruction ?? ""} ${o.input ?? ""}`.trim();
        if (motif.length < 10) continue;
        paires.push({ motif, reponse: o.output, theme: d, source: `v4/${d}#${i}` });
        pris += 1;
      } catch {
        /* ligne corrompue : ignorée, comptée dans le total */
      }
    }
  }
  return { paires, lignesParDomaine, totalLignes, octets };
}

// ─── Phase 2 : couleurs + exemples propres ────────────────────────────────

function pairesCouleurs(): { motif: string; reponse: string; theme: string }[] {
  const qs = echantillonCouleurs(NB_COULEURS, GRAINE);
  return qs.map((q) => ({ motif: q.prompt, reponse: q.reponse, theme: `couleurs-${q.famille}` }));
}

/** Exemples PROPRES de haute qualité : palette canonique + règles de mélange. */
function exemplesPropresCouleurs(): { motif: string; reponse: string; theme: string }[] {
  const out: { motif: string; reponse: string; theme: string }[] = [];
  for (const c of PALETTE) {
    const q = questionCouleur("R", c.rgb, 0);
    out.push({ motif: q.prompt, reponse: q.reponse, theme: "couleurs-exemple-propre" });
    const p = questionCouleur("P", c.rgb, 0);
    out.push({ motif: p.prompt, reponse: p.reponse, theme: "couleurs-exemple-propre" });
  }
  const melanges: Array<[string, string]> = [
    ["rouge", "vert"], ["rouge", "bleu"], ["vert", "bleu"], ["jaune", "cyan"],
    ["rouge", "vert anis"], ["bleu", "lavande"], ["magenta", "cyan"], ["noir", "blanc"],
    ["orange", "turquoise"], ["or", "indigo"], ["rose", "olive"], ["bordeaux", "beige"],
  ];
  for (const [a, b] of melanges) {
    const ca = parNom(a);
    const cb = parNom(b);
    if (!ca || !cb) continue;
    const q = questionMelange(ca, cb, "lumiere");
    out.push({ motif: q.prompt, reponse: q.reponse, theme: "couleurs-exemple-propre" });
  }
  return out;
}

// ─── Programme ─────────────────────────────────────────────────────────────

function main(): void {
  mkdirSync(DIR_OUT, { recursive: true });
  const t0 = Date.now();
  log(`DÉBUT it.89 — v4 (décalage neuf graine ${GRAINE}), couleurs ${NB_COULEURS}, ondes ${NB_ONDES}, bande ${BANDE_CIBLE}`);

  const v4 = echantillonV4();
  log(`sources v4 : ${v4.paires.length} paires retenues sur ${v4.totalLignes} lignes mesurées (${(v4.octets / 1e6).toFixed(1)} Mo, ${Object.keys(v4.lignesParDomaine).length}/19 domaines)`);

  const couleurs = pairesCouleurs();
  const propres = exemplesPropresCouleurs();
  log(`couleurs : ${couleurs.length} paires générées (capacité vérifiable : ${capaciteTotale(1).toLocaleString("fr-FR")}) + ${propres.length} exemples propres`);

  // Phase 3 — apprentissage langagier (même chemin que la production)
  const cortex = new CortexLangagierGen3();
  const base: Array<{ motif: string; reponse: string; theme: string }> = CORPUS_GEN3.map((p) => ({
    motif: p.motif, reponse: p.reponse, theme: p.theme,
  }));
  cortex.apprendre(base as never);
  const avantBase = Date.now();
  cortex.apprendre(v4.paires as never);
  log(`v4 assimilé en ${((Date.now() - avantBase) / 1000).toFixed(1)} s`);
  const t2 = Date.now();
  cortex.apprendre([...propres, ...couleurs] as never);
  log(`couleurs assimilées en ${((Date.now() - t2) / 1000).toFixed(1)} s`);

  // mesure de réparation : questions couleur APPRISES → servies ; RÉSERVÉES (jamais apprises) → honnêteté
  const reservees = echantillonCouleurs(200, GRAINE + 1).filter((q) => q.famille !== "M");
  const echantillonAppris = echantillonCouleurs(200, GRAINE).filter((q) => q.famille !== "M");
  const servi = (liste: readonly { prompt: string; extraitsVerifiables: readonly string[] }[]): number =>
    liste.filter((q) => {
      const r = cortex.repondre(q.prompt);
      return r ? q.extraitsVerifiables.some((ex) => r.texte.includes(ex)) : false;
    }).length;
  const reparation = servi(echantillonAppris);
  const horsEchantillon = servi(reservees);
  log(`mesure langagière : ${reparation}/${echantillonAppris.length} questions apprises servies exactement · ${horsEchantillon}/${reservees.length} réservées (jamais apprises — la voie instanciée les couvre par calcul)`);

  // Phase 4 — ONDES SNN
  let snn: Record<string, unknown> | null = null;
  try {
    if (existsSync(SNAPSHOT_SOURCE)) {
      const brut = readFileSync(SNAPSHOT_SOURCE);
      const octetsSource = brut.byteLength;
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
      log(`ONDES — cerveau importé (${octetsSource} octets, ${nbColonnes} colonnes) ; bande ${bande} (label « ${label} »)`);

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
      const apres = mesurer();
      log(`mesure SNN réservée : bande ${bande} dominante ${avant.hits}/${avant.total} → ${apres.hits}/${apres.total} après ${gravees} ondes gravées`);

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
      snn = { source: SNAPSHOT_SOURCE, octetsSource, bandePorteuse: bande, label, ondesGravees: gravees, avant: avant.hits, apres: apres.hits, total: avant.total, snapshot: SNAPSHOT_SORTIE, octets: snapshot.length };
    } else {
      log(`snapshot source absent (${SNAPSHOT_SOURCE}) — phase ONDES sautée`);
    }
  } catch (err) {
    log(`phase ONDES en échec (non bloquant) : ${String(err)}`);
  }

  // Module corpus committé (exemples propres + échantillon v4 réel)
  const echantillonV4Module = v4.paires.filter((p) =>
    ["image_analysis", "video_v4", "audio_understanding", "voice_speech", "multimodal_v4"].includes(p.theme),
  ).slice(0, 30);
  const entete = `/**
 * CORPUS COULEURS + MULTIMODAL it.89 (généré par
 * scripts/entrainement-multimodal-it89.ts — ${new Date().toISOString()}).
 *
 * ${propres.length} exemples propres de haute qualité (palette canonique +
 * règles de mélange) + ${echantillonV4Module.length} paires RÉELLES des
 * domaines multimodaux v4 (dépôt HF Kings237/gen3ia-media-engine).
 */
import type { PaireLangage } from "./types";

export const CORPUS_COULEURS_IT89: readonly PaireLangage[] = [
`;
  const corps = [...propres, ...echantillonV4Module]
    .map((p) => `  ${JSON.stringify({ motif: p.motif, reponse: p.reponse, theme: p.theme })},`)
    .join("\n");
  writeFileSync(MODULE_CORPUS, `${entete}${corps}\n];\n`);
  log(`module corpus écrit : ${MODULE_CORPUS} (${propres.length + echantillonV4Module.length} paires)`);

  // Rapport JSON
  const rapport = {
    date: new Date().toISOString(),
    dureeMs: Date.now() - t0,
    sourcesV4: { domaines: Object.keys(v4.lignesParDomaine).length, paires: v4.paires.length, totalLignes: v4.totalLignes, octets: v4.octets },
    couleurs: { paires: couleurs.length, capacite: capaciteTotale(1), exemplesPropres: propres.length },
    mesureLangagiere: { apprisesServies: reparation, apprisesTotal: echantillonAppris.length, reserveesServies: horsEchantillon, reserveesTotal: reservees.length },
    snn,
    module: MODULE_CORPUS,
  };
  writeFileSync(join(DIR_OUT, "rapport-it89.json"), JSON.stringify(rapport, null, 2));
  log(`TERMINÉ en ${((Date.now() - t0) / 1000).toFixed(1)} s — rapport : ${join(DIR_OUT, "rapport-it89.json")}`);
}

main();
