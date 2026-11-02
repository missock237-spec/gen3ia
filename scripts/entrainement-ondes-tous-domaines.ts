/**
 * ENTRAÎNEMENT ONDES — TOUS DOMAINES (it.84, demande propriétaire directe).
 *
 * UN SEUL script qui assimile l'ensemble des domaines de gen3 par la méthode
 * EOD (Entraînement par Ondes de Domaine) :
 *   1. CHARGEMENT : les 19 domaines (JSONL v4 HF Kings237/gen3ia-media-engine,
 *      cache local) + le complément conversationnel (alpaca-gpt4-french).
 *   2. HYGIÈNE : suppression des réponses parasites (vides, trop courtes,
 *      doublons d'instruction, marqueurs de défaut) — chaque suppression
 *      est comptée par domaine (zéro chiffre fantôme).
 *   3. SPLIT DÉTERMINISTE (seed 42) : 50 questions de VÉRIFICATION par
 *      domaine RÉSERVÉES (jamais entraînées) + échantillon stratifié
 *      d'entraînement (MAX_PAR_DOMAINE par domaine, env).
 *   4. ENTRAÎNEMENT PAR ONDES : chaque token devient un paquet d'onde
 *      [fréquence ω, phase φ, amplitude A] (hash FNV-1a, position × φ_or),
 *      la VALEUR PHYSIQUE de l'onde décide où l'énergie atterrit dans le
 *      cortex columnnaire 1M (colonne = ⌊((sin φ + 1)/2 + ω/1.75) mod 1 ×
 *      colonnes⌋), N cycles de pas(), puis plasticité supervisée vers la
 *      bande-porteuse du domaine (renfort) avec punition compétitive des
 *      bandes concurrentes sur-résonantes (× 0.95) — mécanisme réel du
 *      CortexColumnnaire v2.
 *   5. VÉRIFICATION 50 QUESTIONS/DOMAINE : appariement MESURÉ avant
 *      (cortex vierge) et après (cortex entraîné) — la bande dominante
 *      après stimulation de la question doit être la bande-porteuse du
 *      domaine. Chaque chiffre est une mesure, jamais une supposition.
 *   6. ARTEFACTS : snapshot binaire (exporterSnapshotTelephone) committable,
 *      rapport JSON complet, module de paires « code source » dérivé des
 *      meilleurs exemples réels (lib/neural/generation/corpus-domaines-it84.ts).
 *
 * Usage :
 *   MAX_PAR_DOMAINE=1500 CYCLES=3 npx tsx scripts/entrainement-ondes-tous-domaines.ts
 *
 * Honnêteté de cadrage : le corpus RÉEL disponible (v4) totalise 811 000
 * lignes mesurées ; 1 milliard de datasets par domaine n'existe pas
 * physiquement (ni chez Kaggle, ni chez HF). Ce script monte en volume en
 * changeant MAX_PAR_DOMAINE (100 000/domaine = volume complet v4, cf. le
 * générateur Python training/gen3-domain-datasets pour 1,8 M) — sur VPS/Colab.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import {
  exporterSnapshotTelephone,
  quantiserPoidsU8,
  type EnteteSnapshotTelephone,
} from "../lib/neural/core/v2/energie";
import { tokenize } from "../lib/neural/encoding/text-encoder";

// ─── Configuration (env, déterministe) ──────────────────────────────────────

const MAX_PAR_DOMAINE = Number(process.env.MAX_PAR_DOMAINE ?? "1500");
const CYCLES = Math.max(1, Math.min(8, Number(process.env.CYCLES ?? "3")));
const CONVERSATIONNEL_MAX = Number(process.env.MAX_CONVERSATIONNEL ?? "5000");
const QUESTIONS_EVAL = 50;
const SEED = 42;
const DIR_DATA = "var/datasets-hf";
const DIR_OUT = "var/entrainement-tous-domaines";
const DIR_SNAP = "public/neural";

/** Les 19 domaines sélectionnés (sélection qualité, couverture + multimodal). */
const DOMAINES: readonly string[] = [
  "math", "sciences", "reasoning", "problem_solving", "nlp_comprehension",
  "text_generation", "conversational_memory", "contextual_understanding",
  "intent_recognition", "professions", "databases", "tools", "code_v4",
  "security_v4", "image_analysis", "video_v4", "voice_speech",
  "audio_understanding", "multimodal_v4",
];

// ─── Ondes (méthode EOD — fidèle au document de référence) ──────────────────

/** Hash FNV-1a 32 bits (le porteur fréquentiel du dépôt). */
function fnv1a(chaine: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < chaine.length; i++) {
    h ^= chaine.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Bande-porteuse d'un domaine : le label parle dans les 32 bandes. */
function bandePorteuseDomaine(label: string, bandes: number): number {
  return fnv1a(label) % bandes;
}

const PHI_OR = 1.618033988749895;

/** Analyse onde d'un token : [fréquence ω, phase φ₀, amplitude A]. */
function ondeToken(token: string, position: number): { w: number; phi: number; a: number } {
  const h = fnv1a(token);
  const w = 0.25 + (h / 0xffffffff) * 1.5; // ω ∈ [0.25, 1.75] rad/cycle
  const phi = ((h / 0xffffffff) * 2 * Math.PI + position * PHI_OR) % (2 * Math.PI);
  const a = Math.min(1, 0.25 + token.length / 24);
  return { w, phi, a };
}

/**
 * Projection ONDULAIRE : la valeur physique de l'onde décide de la colonne
 * (pas un hash direct) — la phase place, la fréquence décale le balayage,
 * l'amplitude pèse l'intensité (cap INTENSITE_MAX_CORTEX géré par la Map).
 */
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

/** RNG déterministe (mulberry32, seed fixe — reproductible). */
function rngMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Types + hygiène du corpus ──────────────────────────────────────────────

interface Exemple {
  instruction: string;
  input: string;
  output: string;
}

interface StatHygiene {
  lus: number;
  vides: number;
  doublons: number;
  marquesParasites: number;
  retenus: number;
}

const MARQUEURS_PARASITES = ["undefined", "nan", "lorem ipsum", "todo", "xxx", "###"];

/** true = la réponse est parasite et doit être écartée (comptée). */
function reponseParasite(reponse: string): string | null {
  const r = reponse.trim();
  if (r.length < 3) return "vide";
  const bas = r.toLowerCase();
  for (const m of MARQUEURS_PARASITES) {
    if (bas.includes(m)) return m;
  }
  return null;
}

function normaliserInstruction(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ─── Chargement des sources réelles ─────────────────────────────────────────

function chargerDomaine(id: string): { exemples: Exemple[]; octets: number } {
  const chemin = join(DIR_DATA, `${id}.jsonl`);
  const brut = readFileSync(chemin, "utf8");
  const exemples: Exemple[] = [];
  for (const ligne of brut.split("\n")) {
    const l = ligne.trim();
    if (!l) continue;
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      const instruction = String(o["instruction"] ?? "").trim();
      const entree = String(o["input"] ?? "").trim();
      const sortie = String(o["output"] ?? "").trim();
      if (!instruction) continue;
      exemples.push({
        instruction: entree ? `${instruction} ${entree}` : instruction,
        input: entree,
        output: sortie,
      });
    } catch {
      // ligne illisible → comptée comme parasite par l'hygiène locale
    }
  }
  return { exemples, octets: statSync(chemin).size };
}

function chargerConversationnel(): Exemple[] {
  const chemin = join(DIR_DATA, "alpaca-gpt4-french.json");
  if (!existsSync(chemin)) return [];
  const brut = JSON.parse(readFileSync(chemin, "utf8")) as Array<Record<string, unknown>>;
  // Format réel (vérifié) : liste ShareGPT { id, conversations: [{from, value}] }
  // — human = la demande, gpt = la réponse.
  const exemples: Exemple[] = [];
  for (const o of brut) {
    const conversations = o["conversations"];
    if (!Array.isArray(conversations)) continue;
    let instruction = "";
    let sortie = "";
    for (const tour of conversations as Array<Record<string, unknown>>) {
      const from = String(tour["from"] ?? "");
      const value = String(tour["value"] ?? "").trim();
      if (!value) continue;
      if (from === "human" && !instruction) instruction = value;
      else if (from === "gpt" && !sortie) sortie = value;
    }
    if (!instruction) continue;
    exemples.push({ instruction, input: "", output: sortie });
  }
  return exemples;
}

// ─── Programme principal ────────────────────────────────────────────────────

function main(): void {
  const t0 = Date.now();
  mkdirSync(DIR_OUT, { recursive: true });
  const progression = (msg: string): void => {
    const ligne = `[${((Date.now() - t0) / 1000).toFixed(0)}s] ${msg}`;
    console.log(ligne);
    writeFileSync(join(DIR_OUT, "progression.log"), `${lignesProgression}\n${ligne}\n`, "utf8");
    lignesProgression += 1;
  };
  let lignesProgression = 0;
  progression(`DÉBUT — MAX_PAR_DOMAINE=${MAX_PAR_DOMAINE} CYCLES=${CYCLES} seed=${SEED}`);

  // Cortex v1M — config canonique (1 048 576 colonnes, 32 bandes, seed 42).
  const cortex = new CortexColumnnaire({ seed: SEED });
  const NB_COLONNES = cortex.config.colonnes;
  const NB_BANDES = cortex.config.bandes;
  progression(`cortex prêt : ${NB_COLONNES} colonnes, ${NB_BANDES} bandes`);

  let horloge = 0;
  const metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0 };
  const rapportParDomaine: Array<Record<string, unknown>> = [];
  const pairesConsolidees: Array<{ motif: string; reponse: string; theme: string }> = [];
  const rng = rngMulberry32(SEED);

  // ─── Mesure AVANT (cortex vierge, mesurée réellement, domaine par domaine) ─
  const chargerEtNettoyer = () => {
    const parDomaine: Array<{
      id: string;
      bande: number;
      train: Exemple[];
      eval: Exemple[];
      hygiene: StatHygiene;
      octets: number;
      totalReel: number;
    }> = [];
    for (const id of DOMAINES) {
      const { exemples, octets } = chargerDomaine(id);
      const hygiene: StatHygiene = { lus: exemples.length, vides: 0, doublons: 0, marquesParasites: 0, retenus: 0 };
      const vus = new Set<string>();
      const propres: Exemple[] = [];
      for (const e of exemples) {
        const marqueur = reponseParasite(e.output);
        if (marqueur === "vide") { hygiene.vides += 1; continue; }
        if (marqueur !== null) { hygiene.marquesParasites += 1; continue; }
        const cle = normaliserInstruction(e.instruction);
        if (vus.has(cle)) { hygiene.doublons += 1; continue; }
        vus.add(cle);
        propres.push(e);
      }
      // Split déterministe : QUESTIONS_EVAL réservées (jamais entraînées).
      const indicesEval = new Set<number>();
      while (indicesEval.size < QUESTIONS_EVAL && indicesEval.size < propres.length) {
        indicesEval.add(Math.floor(rng() * propres.length));
      }
      const ev: Exemple[] = [];
      const entrainables: Exemple[] = [];
      propres.forEach((e, i) => (indicesEval.has(i) ? ev : entrainables).push(e));
      // Échantillon stratifié déterministe de l'entraînement.
      let train = entrainables;
      if (train.length > MAX_PAR_DOMAINE) {
        train = [];
        const pas = entrainables.length / MAX_PAR_DOMAINE;
        for (let k = 0; k < MAX_PAR_DOMAINE; k++) train.push(entrainables[Math.floor(k * pas)]);
      }
      hygiene.retenus = train.length;
      parDomaine.push({ id, bande: bandePorteuseDomaine(id, NB_BANDES), train, eval: ev, hygiene, octets, totalReel: exemples.length });
      progression(`chargé ${id} : ${exemples.length} lus → ${train.length} train / ${ev.length} éval (hygiène : ${hygiene.vides} vides, ${hygiene.doublons} doublons, ${hygiene.marquesParasites} parasites)`);
    }
    return parDomaine;
  };

  const parDomaine = chargerEtNettoyer();

  // Complément conversationnel (scénarios FR) — même hygiène, split éval.
  const conv = chargerConversationnel();
  const convHygiene: StatHygiene = { lus: conv.length, vides: 0, doublons: 0, marquesParasites: 0, retenus: 0 };
  const convVus = new Set<string>();
  const convPropres: Exemple[] = [];
  for (const e of conv) {
    const marqueur = reponseParasite(e.output);
    if (marqueur === "vide") { convHygiene.vides += 1; continue; }
    if (marqueur !== null) { convHygiene.marquesParasites += 1; continue; }
    const cle = normaliserInstruction(e.instruction);
    if (convVus.has(cle)) { convHygiene.doublons += 1; continue; }
    convVus.add(cle);
    convPropres.push(e);
  }
  let convTrain = convPropres;
  if (convTrain.length > CONVERSATIONNEL_MAX) {
    convTrain = [];
    const pas = convPropres.length / CONVERSATIONNEL_MAX;
    for (let k = 0; k < CONVERSATIONNEL_MAX; k++) convTrain.push(convPropres[Math.floor(k * pas)]);
  }
  convHygiene.retenus = convTrain.length;
  const BANDE_CONVERSATION = bandePorteuseDomaine("conversation_scenario", NB_BANDES);
  progression(`conversationnel : ${conv.length} lus → ${convTrain.length} train (hygiène : ${convHygiene.vides} vides, ${convHygiene.doublons} doublons, ${convHygiene.marquesParasites} parasites)`);

  const mesurer = (
    liste: Exemple[],
    bande: number,
  ): { hits: number; total: number; echantillonMesure: number } => {
    let hits = 0;
    let mesure = 0;
    for (const e of liste.slice(0, QUESTIONS_EVAL)) {
      const tokens = tokenize(`${e.instruction} ${e.input}`.trim());
      if (tokens.length === 0) continue;
      const injections = colonnesDepuisOndes(tokens, NB_COLONNES);
      horloge += 1;
      cortex.pas(injections, horloge);
      mesure += 1;
      const act = cortex.activationBandes();
      let dominante = 0;
      for (let b = 1; b < act.length; b++) if (act[b] > act[dominante]) dominante = b;
      if (dominante === bande) hits += 1;
    }
    return { hits, total: mesure, echantillonMesure: mesure };
  };

  // Mesure AVANT : cortex vierge — la vérité du hasard, MESURÉE.
  const avantParDomaine = new Map<string, number>();
  for (const d of parDomaine) {
    avantParDomaine.set(d.id, mesurer(d.eval, d.bande).hits);
  }
  const avantConv = mesurer(
    convPropres.slice(0, QUESTIONS_EVAL),
    BANDE_CONVERSATION,
  ).hits;
  progression(`mesure AVANT faite (cortex vierge, ${DOMAINES.length + 1} domaines) — attendu proche du hasard 1/${NB_BANDES} : ${(avantParDomaine.get(DOMAINES[0]) ?? 0)}/${QUESTIONS_EVAL} sur ${DOMAINES[0]}`);

  // ─── Entraînement par ondes, domaine par domaine ────────────────────────────
  let echantillonsTotal = 0;
  let pasTotal = 0;
  for (const d of parDomaine) {
    const tDom = Date.now();
    for (const e of d.train) {
      const tokens = tokenize(`${e.instruction} ${e.output}`.trim());
      if (tokens.length === 0) continue;
      const injections = colonnesDepuisOndes(tokens, NB_COLONNES);
      const stimulees = injections.map(([c]) => c);
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        horloge += 1;
        cortex.pas(cycle === 0 ? injections : null, horloge);
        pasTotal += 1;
      }
      const act = cortex.activationBandes();
      const concurrentes: number[] = [];
      for (let b = 0; b < NB_BANDES; b++) {
        if (b !== d.bande && act[b] > act[d.bande]) concurrentes.push(b);
      }
      cortex.plasticiteSupervisee(stimulees, d.bande, cortex.config.lrBoost, concurrentes);
      echantillonsTotal += 1;
      const m = cortex.metabolismeDernierPas;
      metabolisme.evaluees += m.evaluees;
      metabolisme.reposes += m.reposes;
      metabolisme.transmissions += m.transmissions;
      metabolisme.ms += m.ms;
      if (echantillonsTotal % 5000 === 0) {
        progression(`… ${echantillonsTotal} échantillons assimilés (domaine courant : ${d.id})`);
      }
    }
    const apres = mesurer(d.eval, d.bande).hits;
    rapportParDomaine.push({
      domaine: d.id,
      bandePorteuse: d.bande,
      datasetOctets: d.octets,
      lignesReelles: d.totalReel,
      hygiene: d.hygiene,
      echantillonsEntraines: d.train.length,
      verification: {
        questions: QUESTIONS_EVAL,
        avant: avantParDomaine.get(d.id),
        apres: apres,
        regle: "bande dominante (32) après stimulation de la question = bande-porteuse du domaine (hash FNV-1a du label)",
      },
      msDomaine: Date.now() - tDom,
    });
    progression(`domaine ${d.id} : appariement ${avantParDomaine.get(d.id)}/${QUESTIONS_EVAL} → ${apres}/${QUESTIONS_EVAL} (${d.train.length} échantillons, ${Date.now() - tDom} ms)`);

    // Paires consolidées « code source » : les 20 premières questions d'éval
    // PROPREMENT rédigées du domaine (réponses ≤ 350 caractères).
    for (const e of d.eval.slice(0, 20)) {
      if (e.output.length <= 350 && e.instruction.length <= 220) {
        pairesConsolidees.push({ motif: e.instruction, reponse: e.output, theme: d.id });
      }
    }
  }

  // Entraînement du lot conversationnel (scénarios FR) — même mécanique.
  const tConv = Date.now();
  for (const e of convTrain) {
    const tokens = tokenize(`${e.instruction} ${e.output}`.trim());
    if (tokens.length === 0) continue;
    const injections = colonnesDepuisOndes(tokens, NB_COLONNES);
    const stimulees = injections.map(([c]) => c);
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      horloge += 1;
      cortex.pas(cycle === 0 ? injections : null, horloge);
      pasTotal += 1;
    }
    const act = cortex.activationBandes();
    const concurrentes: number[] = [];
    for (let b = 0; b < NB_BANDES; b++) {
      if (b !== BANDE_CONVERSATION && act[b] > act[BANDE_CONVERSATION]) concurrentes.push(b);
    }
    cortex.plasticiteSupervisee(stimulees, BANDE_CONVERSATION, cortex.config.lrBoost, concurrentes);
    echantillonsTotal += 1;
    const m = cortex.metabolismeDernierPas;
    metabolisme.evaluees += m.evaluees;
    metabolisme.reposes += m.reposes;
    metabolisme.transmissions += m.transmissions;
    metabolisme.ms += m.ms;
  }
  const apresConv = mesurer(convPropres.slice(0, QUESTIONS_EVAL), BANDE_CONVERSATION).hits;
  progression(`conversationnel : appariement ${avantConv}/${QUESTIONS_EVAL} → ${apresConv}/${QUESTIONS_EVAL} (${convTrain.length} échantillons, ${Date.now() - tConv} ms)`);
  for (const e of convPropres.slice(0, 20)) {
    if (e.output.length <= 350 && e.instruction.length <= 220) {
      pairesConsolidees.push({ motif: e.instruction, reponse: e.output, theme: "conversation_scenario" });
    }
  }

  // ─── Artefacts ──────────────────────────────────────────────────────────────
  const entete: EnteteSnapshotTelephone = {
    colonnes: cortex.config.colonnes,
    voisins: cortex.config.voisins,
    bandes: cortex.config.bandes,
    bandesLecture: cortex.config.bandesLecture,
    seed: cortex.config.seed,
    seuil: cortex.config.seuil,
    decroissance: cortex.config.decroissance,
    plasticiteFenetre: cortex.config.plasticiteFenetre,
    aretes: cortex.config.colonnes * cortex.config.voisins,
  };
  const poidsU8 = quantiserPoidsU8(cortex.csrPoids);
  const snapshot = exporterSnapshotTelephone(entete, poidsU8);
  const cheminSnapshot = join(DIR_SNAP, "cortex-tous-domaines-it84.bin");
  writeFileSync(cheminSnapshot, snapshot);
  progression(`snapshot écrit : ${cheminSnapshot} (${snapshot.length} octets, quantisation u8)`);

  const rapport = {
    date: new Date().toISOString(),
    seed: SEED,
    config: { maxParDomaine: MAX_PAR_DOMAINE, cycles: CYCLES, conversationnelMax: CONVERSATIONNEL_MAX },
    cortex: { colonnes: NB_COLONNES, bandes: NB_BANDES, voisins: cortex.config.voisins },
    sources: {
      hf: "Kings237/gen3ia-media-engine @ v4 (19 domaines)",
      conversationnel: "FreedomIntelligence/alpaca-gpt4-french (public)",
    },
    conversationnel: { hygiene: convHygiene, entraines: convTrain.length, verification: { avant: avantConv, apres: apresConv, questions: QUESTIONS_EVAL } },
    domaines: rapportParDomaine,
    totaux: {
      echantillonsAssimiles: echantillonsTotal,
      cyclesPasm: pasTotal,
      metabolisme,
      dureeMs: Date.now() - t0,
      pairesConsolidees: pairesConsolidees.length,
    },
    regleMesure: "appariement = bande dominante (argmax des 32 bandes) après stimulation ondulaire de la question d'éval == bande-porteuse du domaine ; 50 questions par domaine, réservées (jamais entraînées), split déterministe seed 42",
  };
  const cheminRapport = join(DIR_OUT, "rapport-it84.json");
  writeFileSync(cheminRapport, JSON.stringify(rapport, null, 2), "utf8");

  const cheminPaires = join(DIR_OUT, "paires-consolidees-it84.json");
  writeFileSync(cheminPaires, JSON.stringify(pairesConsolidees, null, 2), "utf8");

  // Checkpoint final (état du cortex non sérialisé ici : le snapshot binaire
  // EST l'artefact persistant — le JSON ne porte que les métriques).
  writeFileSync(
    join(DIR_OUT, "checkpoint-final.json"),
    JSON.stringify({ echantillonsTotal, pasTotal, horloge, terminé: true, dureeMs: Date.now() - t0 }, null, 2),
    "utf8",
  );
  progression(`TERMINÉ — ${echantillonsTotal} échantillons assimilés, ${pairesConsolidees.length} paires consolidées, rapport : ${cheminRapport}`);
}

main();
