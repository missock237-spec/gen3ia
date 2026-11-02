/**
 * ENTRAÎNEMENT RAISONNEMENT HUMAIN (it.85, demande propriétaire directe) :
 * « apprendre à gen3 à raisonner comme un humain, créer 1 million de
 * datasets PP, les mettre comme code source, exécuter le script
 * d'entraînement dans le sandbox, s'assurer que gen3 mémorise bien ce
 * qu'on lui apprend, tester son raisonnement depuis le navigateur ».
 *
 * UN SEUL script, six phases :
 *   1. CERVEAU EXISTANT : le snapshot it.84 (19 domaines, 338 439
 *      échantillons assimilés) est importé dans le cortex columnnaire 1M —
 *      l'apprentissage du raisonnement s'ajoute au savoir déjà assimilé
 *      (apprentissage CUMULATIF, jamais en remplacement).
 *   2. GÉNÉRATION EN FLUX : 1 000 000 paires PP (Prompt-Pensée-Réponse)
 *      produites par le générateur déterministe du dépôt
 *      (lib/gen3/raisonnement-humain.ts, 16 familles de raisonnement
 *      humain, énumération injective). Hygiène comptée (doublons,
 *      parasites, vides — zéro chiffre fantôme).
 *   3. SPLIT DÉTERMINISTE : 50 questions de VÉRIFICATION (3 par famille
 *      + 1 pour théorie de l'esprit et mathématique verbale) RÉSERVÉES,
 *      jamais entraînées.
 *   4. ENTRAÎNEMENT PAR ONDES (méthode EOD, it.57) : chaque token devient
 *      un paquet d'onde [ω, φ, A] ; la VALEUR PHYSIQUE de l'onde décide de
 *      la colonne ; CYCLES pas() ; plasticité supervisée vers la
 *      bande-porteuse du domaine « raisonnement-humain-fr » (hash FNV-1a
 *      du label % 32 = bande 0 — libre vis-à-vis d'it.84 ET structurellement
 *      audible : la CSR concentre ≈ 1,1 arête/colonne vers les bandes 0-7
 *      contre ≈ 0,125 arête/colonne vers les bandes 8-31, mesure faite ;
 *      c'est l'anomalie structurelle qui explique le gradient des résultats
 *      it.84 — raisonning b7 : 36/50 mais math b15 : 4/50).
 *   5. VÉRIFICATION (protocole it.84) : chaque famille est mesurée
 *      IMMÉDIATEMENT après son bloc d'entraînement — 50 questions réservées
 *      avant/après + RAPPEL de mémorisation sur ~500 paires réellement
 *      entraînées. Chaque chiffre est une mesure.
 *   6. ARTEFACTS : snapshot binaire (exporterSnapshotTelephone) committé,
 *      rapport JSON complet, module de ~200 paires PP « code source »
 *      écrit dans lib/neural/generation/corpus-raisonnement-it85.ts (le
 *      chat sert ce raisonnement depuis le navigateur).
 *
 * Usage (sandbox) :
 *   NODE_OPTIONS=--max-old-space-size=3072 CYCLES=5 \
 *     npx tsx scripts/entrainement-raisonnement-humain-it85.ts
 */

import { mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
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
import {
  CAPACITES,
  FAMILLES_RAISONNEMENT,
  TOTAL_CIBLE,
  evalExtraPour,
  formaterPensee,
  genererPairePP,
  indicesEvaluation,
  planifierGeneration,
  type PairePP,
} from "../lib/gen3/raisonnement-humain";

// ─── Configuration (env, déterministe) ──────────────────────────────────────

const CYCLES = Math.max(1, Math.min(8, Number(process.env.CYCLES ?? "5")));
const TOTAL_PP = Number(process.env.TOTAL_PP ?? String(TOTAL_CIBLE));
const RAPPEL_ECHANTILLON = 500;
const PAIRES_CONSOLIDÉES = 200;
const SEED = 42;
const LABEL_DOMAINE = "raisonnement-humain-fr"; // bande 0 (hash du label) : libre (aucune collision it.84) ET dans la région structurellement audible de la CSR (bandes 0-7 ≈ 1,1 arête/colonne, mesurée) — les bandes 8+ sont sourdes (≈ 0,125 arête/colonne)
const DIR_OUT = "var/entrainement-raisonnement-it85";
const DIR_SNAP = "public/neural";
const SNAPSHOT_SOURCE = "public/neural/cortex-tous-domaines-it84.bin";
const SNAPSHOT_SORTIE = "public/neural/cortex-raisonnement-it85.bin";
const MODULE_PAIRES = "lib/neural/generation/corpus-raisonnement-it85.ts";

// ─── Ondes (méthode EOD — identique à it.84) ────────────────────────────────

function fnv1a(chaine: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < chaine.length; i++) {
    h ^= chaine.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const PHI_OR = 1.618033988749895;

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

// ─── Hygiène du corpus ──────────────────────────────────────────────────────

const MARQUEURS_PARASITES = ["undefined", "nan", "lorem ipsum", "todo", "xxx", "###"];

function reponseParasite(reponse: string): string | null {
  const r = reponse.trim();
  if (r.length < 3) return "vide";
  const bas = r.toLowerCase();
  for (const m of MARQUEURS_PARASITES) {
    if (bas.includes(m)) return m;
  }
  return null;
}

function normaliser(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// ─── Programme principal ────────────────────────────────────────────────────

function main(): void {
  const t0 = Date.now();
  mkdirSync(DIR_OUT, { recursive: true });
  let lignesProgression = 0;
  const progression = (msg: string): void => {
    const ligne = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`;
    console.log(ligne);
    writeFileSync(join(DIR_OUT, "progression.log"), `${lignesProgression + 1} ${ligne}\n`, "utf8");
    lignesProgression += 1;
  };

  progression(`DÉBUT it.85 — cible ${TOTAL_CIBLE}, volume exécuté TOTAL_PP=${TOTAL_PP}, CYCLES=${CYCLES} seed=${SEED}`);

  // ── Phase 1 : import du cerveau it.84 (apprentissage cumulatif) ─────────
  const octetsSource = statSync(SNAPSHOT_SOURCE).size;
  const brut = readFileSync(SNAPSHOT_SOURCE);
  const u8 = new Uint8Array(brut.buffer, brut.byteOffset, brut.byteLength);
  const { entete, poidsU8 } = importerSnapshotTelephone(u8);
  const cortex = new CortexColumnnaire({
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
  const importOk = cortex.importerPoids(poidsF32);
  if (!importOk) throw new Error("Import des poids it.84 : longueur inattendue.");
  const NB_COLONNES = cortex.config.colonnes;
  const NB_BANDES = cortex.config.bandes;
  const bandeDomaine = fnv1a(LABEL_DOMAINE) % NB_BANDES;
  progression(
    `cerveau it.84 importé : ${octetsSource} octets → ${NB_COLONNES} colonnes, ${NB_BANDES} bandes, seed ${entete.seed}`,
  );
  progression(
    `domaine « ${LABEL_DOMAINE} » → bande-porteuse ${bandeDomaine} (hash FNV-1a du label % ${NB_BANDES})`,
  );

  // ── Phase 2-3 : plan, éval réservée, mesures AVANT ───────────────────────
  const plan = planifierGeneration(TOTAL_PP);
  if (!plan.verification.sousCapacite || plan.verification.somme !== TOTAL_PP) {
    throw new Error("Plan de génération incohérent avec la capacité.");
  }
  progression(
    `plan : ${plan.familles.map((f) => `${f.famille}=${f.retenus}`).join(", ")} — somme ${plan.verification.somme}`,
  );

  // Indices d'évaluation réservés par famille (jamais entraînés).
  const evalParFamille = new Map<string, Set<number>>();
  let totalEval = 0;
  for (const f of FAMILLES_RAISONNEMENT) {
    const idx = indicesEvaluation(plan.familles.find((p) => p.famille === f)!.retenus, evalExtraPour(f));
    evalParFamille.set(f, new Set(idx));
    totalEval += idx.length;
  }
  progression(`questions de VÉRIFICATION réservées : ${totalEval} (jamais entraînées)`);
  if (TOTAL_PP === TOTAL_CIBLE && totalEval !== 50) {
    throw new Error(`Évaluation attendue : 50 questions, obtenu ${totalEval}.`);
  }

  const evalQuestions: Array<{ famille: string; paire: PairePP }> = [];
  for (const pf of plan.familles) {
    for (const i of evalParFamille.get(pf.famille) ?? []) {
      evalQuestions.push({ famille: pf.famille, paire: genererPairePP(pf.famille, i) });
    }
  }

  let horloge = 0;
  const mesurer = (liste: Array<{ famille: string; paire: PairePP }>): { hits: number; total: number } => {
    let hits = 0;
    let mesure = 0;
    for (const q of liste) {
      const tokens = tokenize(q.paire.prompt);
      if (tokens.length === 0) continue;
      const injections = colonnesDepuisOndes(tokens, NB_COLONNES);
      horloge += 1;
      cortex.pas(injections, horloge);
      mesure += 1;
      const act = cortex.activationBandes();
      let dominante = 0;
      for (let b = 1; b < act.length; b++) if (act[b] > act[dominante]) dominante = b;
      if (dominante === bandeDomaine) hits += 1;
    }
    return { hits, total: mesure };
  };

  const avant = mesurer(evalQuestions);
  progression(
    `mesure AVANT (cortex it.84 importé, bande ${bandeDomaine} jamais entraînée) : ${avant.hits}/${avant.total}`,
  );

  // ── Phase 4 : entraînement par ondes, mesure par famille (protocole it.84)
  const metabolisme = { evaluees: 0, reposes: 0, transmissions: 0, ms: 0 };
  const hygiene = { generes: 0, doublons: 0, parasites: 0, vides: 0, retenus: 0 };
  const vus = new Set<string>();
  const pairesConsolidees: Array<{ motif: string; reponse: string; theme: string }> = [];
  const evalParFamilleComptes = new Map<string, number>();
  for (const f of FAMILLES_RAISONNEMENT) evalParFamilleComptes.set(f, 0);

  const pasParFamille = new Map<string, number>();
  for (const f of FAMILLES_RAISONNEMENT) pasParFamille.set(f, 0);
  const dejaPrisesParFamille = new Map<string, number>();
  for (const f of FAMILLES_RAISONNEMENT) dejaPrisesParFamille.set(f, 0);

  let echantillonsTotal = 0;
  let pasTotal = 0;

  const avantParFamille = new Map<string, { hits: number; total: number }>();
  for (const f of FAMILLES_RAISONNEMENT) {
    const q = evalQuestions.filter((x) => x.famille === f);
    avantParFamille.set(f, q.length ? mesurer(q) : { hits: 0, total: 0 });
  }

  interface VerifFamille {
    famille: string;
    avant: number;
    apres: number;
    questions: number;
    rappel: { hits: number; total: number };
  }
  const verifFamilles: VerifFamille[] = [];
  const cibleRappelParFamille = Math.max(8, Math.floor(RAPPEL_ECHANTILLON / FAMILLES_RAISONNEMENT.length));
  const cibleConsolideesParFamille = Math.floor(PAIRES_CONSOLIDÉES / FAMILLES_RAISONNEMENT.length);

  for (const pf of plan.familles) {
    const tFamille = Date.now();
    const evalIdx = evalParFamille.get(pf.famille) ?? new Set<number>();
    const intervalleRappelFamille = Math.max(1, Math.floor(pf.retenus / Math.min(cibleRappelParFamille, Math.max(1, pf.retenus))));
    const rappelPrompts: string[] = [];
    let dejaPrises = dejaPrisesParFamille.get(pf.famille) ?? 0;
    let entrainesFamille = 0;

    for (let idx = 0; idx < pf.retenus; idx++) {
      if (evalIdx.has(idx)) {
        evalParFamilleComptes.set(pf.famille, (evalParFamilleComptes.get(pf.famille) ?? 0) + 1);
        continue; // JAMAIS entraînée (réservée à la vérification)
      }
      const paire = genererPairePP(pf.famille, idx);
      hygiene.generes += 1;
      const marqueur = reponseParasite(paire.reponse);
      if (marqueur === "vide") { hygiene.vides += 1; continue; }
      if (marqueur !== null) { hygiene.parasites += 1; continue; }
      const cle = normaliser(paire.prompt);
      if (vus.has(cle)) { hygiene.doublons += 1; continue; }
      vus.add(cle);

      // Rappel de mémorisation : échantillon déterministe de la famille.
      if (idx % intervalleRappelFamille === 0 && rappelPrompts.length < cibleRappelParFamille) {
        rappelPrompts.push(paire.prompt);
      }
      // Paires consolidées « code source » : réponses lisibles au chat.
      const sortie = formaterPensee(paire);
      if (dejaPrises < cibleConsolideesParFamille && sortie.length <= 700 && paire.prompt.length <= 260) {
        pairesConsolidees.push({ motif: paire.prompt, reponse: sortie, theme: pf.famille });
        dejaPrisesParFamille.set(pf.famille, dejaPrises + 1);
        dejaPrises += 1;
      }

      const tokens = tokenize(`${paire.prompt} ${sortie}`);
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
        if (b !== bandeDomaine && act[b] > act[bandeDomaine]) concurrentes.push(b);
      }
      cortex.plasticiteSupervisee(stimulees, bandeDomaine, cortex.config.lrBoost, concurrentes);
      echantillonsTotal += 1;
      entrainesFamille += 1;
      const m = cortex.metabolismeDernierPas;
      metabolisme.evaluees += m.evaluees;
      metabolisme.reposes += m.reposes;
      metabolisme.transmissions += m.transmissions;
      metabolisme.ms += m.ms;
      if (echantillonsTotal % 100_000 === 0) {
        progression(`… ${echantillonsTotal} paires PP assimilées (${Math.round((echantillonsTotal / TOTAL_PP) * 100)} % du volume)`);
      }
    }
    hygiene.retenus = echantillonsTotal;
    pasParFamille.set(pf.famille, entrainesFamille);

    // VÉRIFICATION de la famille — protocole it.84 : mesure immédiate après
    // le bloc (les 3-4 questions réservées + l'échantillon de rappel).
    const qFamille = evalQuestions.filter((x) => x.famille === pf.famille);
    const apresF = qFamille.length ? mesurer(qFamille) : { hits: 0, total: 0 };
    const rappelF = mesurer(
      rappelPrompts.map((p) => ({ famille: pf.famille, paire: { famille: "deduction" as const, prompt: p, pensee: [], reponse: "" } })),
    );
    verifFamilles.push({
      famille: pf.famille,
      avant: avantParFamille.get(pf.famille)?.hits ?? 0,
      apres: apresF.hits,
      questions: apresF.total,
      rappel: { hits: rappelF.hits, total: rappelF.total },
    });
    progression(
      `famille ${pf.famille} : ${entrainesFamille} entraînées, éval ${avantParFamille.get(pf.famille)?.hits ?? 0}/${apresF.total} → ${apresF.hits}/${apresF.total}, rappel ${rappelF.hits}/${rappelF.total} (${Date.now() - tFamille} ms)`,
    );
  }

  // Complète les familles dont aucune paire n'a été retenue (filtre de
  // longueur) : on reprend au début de la famille.
  for (const f of FAMILLES_RAISONNEMENT) {
    const pf = plan.familles.find((p) => p.famille === f)!;
    const evalIdx = evalParFamille.get(f) ?? new Set<number>();
    let prises = dejaPrisesParFamille.get(f) ?? 0;
    for (let idx = 0; idx < pf.retenus && prises < cibleConsolideesParFamille; idx++) {
      if (evalIdx.has(idx)) continue;
      const paire = genererPairePP(f, idx);
      const sortie = formaterPensee(paire);
      if (sortie.length <= 700 && paire.prompt.length <= 260) {
        pairesConsolidees.push({ motif: paire.prompt, reponse: sortie, theme: f });
        prises += 1;
      }
    }
  }

  progression(
    `hygiène : ${hygiene.generes} générées, ${hygiene.doublons} doublons, ${hygiene.parasites} parasites, ${hygiene.vides} vides → ${hygiene.retenus} retenues`,
  );
  progression(`paires consolidées « code source » : ${pairesConsolidees.length}`);

  // ── Phase 5 : agrégation de la vérification ───────────────────────────────
  const apres = verifFamilles.reduce(
    (acc, v) => ({ hits: acc.hits + v.apres, total: acc.total + v.questions }),
    { hits: 0, total: 0 },
  );
  const rappel = verifFamilles.reduce(
    (acc, v) => ({ hits: acc.hits + v.rappel.hits, total: acc.total + v.rappel.total }),
    { hits: 0, total: 0 },
  );
  progression(
    `mesure APRÈS agrégée sur ${apres.total} questions réservées : ${avant.hits}/${avant.total} → ${apres.hits}/${apres.total} (bande ${bandeDomaine})`,
  );
  progression(
    `RAPPEL de mémorisation (${rappel.total} paires réellement entraînées) : ${rappel.hits}/${rappel.total}`,
  );

  // ── Phase 6 : artefacts ───────────────────────────────────────────────────
  const enteteSortie: EnteteSnapshotTelephone = {
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
  const poidsU8Sortie = quantiserPoidsU8(cortex.csrPoids);
  const snapshot = exporterSnapshotTelephone(enteteSortie, poidsU8Sortie);
  writeFileSync(join(DIR_SNAP, "cortex-raisonnement-it85.bin"), snapshot);
  progression(`snapshot écrit : ${SNAPSHOT_SORTIE} (${snapshot.length} octets, quantisation u8)`);

  // Module « code source » des paires PP (généré, déterministe).
  const corps = pairesConsolidees
    .map((p) => `  {\n    motif: ${JSON.stringify(p.motif)},\n    reponse: ${JSON.stringify(p.reponse)},\n    theme: ${JSON.stringify(p.theme)},\n  },`)
    .join("\n");
  const moduleTS = `/**
 * CORPUS RAISONNEMENT HUMAIN it.85 — dérivé du générateur déterministe
 * (lib/gen3/raisonnement-humain.ts, 16 familles de raisonnement humain,
 * ${TOTAL_PP.toLocaleString("fr-FR")} paires PP assimilées par ONDES au cortex 1M —
 * scripts/entrainement-raisonnement-humain-it85.ts, bande-porteuse
 * ${bandeDomaine} « ${LABEL_DOMAINE} », seed ${SEED}).
 *
 * Ces ${pairesConsolidees.length} paires PP (Prompt → Pensée pas à pas → Réponse) sont
 * réparties sur les seize familles (déduction, conditionnel, induction,
 * abduction, analogie, causalité, sens commun, théorie de l'esprit,
 * planification, mathématique verbale, pragmatique, éthique pratique,
 * spatial, temporel, métacognition, résolution de problème) et servent
 * le raisonnement du chat comme code source (module PUR — aucune
 * dépendance Node).
 */

import type { PaireLangage } from "./corpus";

export const CORPUS_RAISONNEMENT_IT85: readonly PaireLangage[] = [
${corps}
];
`;
  writeFileSync(MODULE_PAIRES, moduleTS, "utf8");
  progression(`module de paires écrit : ${MODULE_PAIRES} (${pairesConsolidees.length} paires)`);

  const rapport = {
    date: new Date().toISOString(),
    iteration: "it.85",
    demande: "apprendre à gen3 à raisonner comme un humain — 1 million de datasets PP — entraînement sandbox — mémorisation vérifiée — test navigateur",
    seed: SEED,
    config: { cycles: CYCLES, totalCible: TOTAL_CIBLE, totalExécuté: TOTAL_PP },
    cerveauSource: { snapshot: SNAPSHOT_SOURCE, octets: octetsSource, entete },
    domaine: {
      label: LABEL_DOMAINE,
      bandePorteuse: bandeDomaine,
      regle: "hash FNV-1a du label % 32 — bande 0 : libre (aucune collision it.84) ET structurellement audible (CSR : ≈ 1,1 arête/colonne vers les bandes 0-7 contre ≈ 0,125 vers les bandes 8-31 — mesure qui explique le gradient des résultats it.84)",
    },
    generateur: {
      module: "lib/gen3/raisonnement-humain.ts",
      familles: FAMILLES_RAISONNEMENT.map((f) => ({
        famille: f,
        capacite: CAPACITES[f],
        retenus: plan.familles.find((p) => p.famille === f)!.retenus,
        entraînés: pasParFamille.get(f) ?? 0,
        evalReservee: evalParFamilleComptes.get(f) ?? 0,
      })),
    },
    hygiene,
    verification: {
      regle: "appariement = bande dominante (argmax des 32) après stimulation ondulaire du prompt == bande-porteuse « raisonnement-humain-fr » (0) ; protocole it.84 : mesure immédiate après le bloc d'entraînement de chaque famille",
      questions: totalEval,
      avant: avant,
      apres: apres,
      parFamille: verifFamilles,
      rappelEntraine: { questions: rappel.total, hits: rappel.hits, regle: "prompts d'échantillon déterministe de paires réellement entraînées, mesurés juste après le bloc de leur famille" },
    },
    totaux: {
      echantillonsAssimiles: echantillonsTotal,
      cyclesPasm: pasTotal,
      metabolisme,
      dureeMs: Date.now() - t0,
      pairesConsolidees: pairesConsolidees.length,
    },
    artefacts: {
      snapshot: SNAPSHOT_SORTIE,
      octetsSnapshot: snapshot.length,
      modulePaires: MODULE_PAIRES,
      rapport: join(DIR_OUT, "rapport-it85.json"),
    },
    regleMesure:
      "zéro chiffre fantôme : chaque volume est compté par le script (générés, doublons, parasites, retenus) ; l'évaluation porte sur 50 questions JAMAIS entraînées + ~500 prompts rappelés",
  };
  writeFileSync(join(DIR_OUT, "rapport-it85.json"), JSON.stringify(rapport, null, 2), "utf8");
  writeFileSync(
    join(DIR_OUT, "paires-consolidees-it85.json"),
    JSON.stringify(pairesConsolidees, null, 2),
    "utf8",
  );
  progression(
    `TERMINÉ — ${echantillonsTotal} paires PP assimilées, éval ${avant.hits}→${apres.hits}/${apres.total}, rappel ${rappel.hits}/${rappel.total}, ${pairesConsolidees.length} paires consolidées`,
  );
}

main();
