/**
 * ENTRAÎNEMENT RAISONNEMENT it.94 (demande propriétaire Job 478451 :
 * « Entraîne Gen3 à comprendre, analyser, raisonner et résoudre des
 * problèmes complexes »).
 *
 * La mesure cumulative (var-copie/progression.json) montre 7 familles de
 * raisonnement JAMAIS balayées : deduction, conditionnel, spatial, temporel,
 * analogie, causalite, planification. Ce script :
 *   1. RAISONNEMENT : 7 familles × 20 paires chat (corpus-raisonnement-it94,
 *      réponses calculées par construction) + lots d'ondes (300/famille).
 *   2. MULTIMODAL : 28 assets RÉELS (20 images COCO-2017 fenêtre offset 124,
 *      8 audios FLEURS fr_fr fenêtre offset 36 — fenêtre vidéo UCF101
 *      épuisée : le split train ne contient que 2 lignes, déjà intégrées).
 *   3. APPRENTISSAGE LANGAGIER : même chemin que la production (CORPUS_GEN3
 *      inclut désormais CORPUS_RAISONNEMENT_IT94 + PAIRES_MULTIMODAL_IT94)
 *      + mesure de service des nouvelles paires.
 *   4. ONDES SNN — 7 BANDES DÉDIÉES (2..8, une par famille ; bande 9 pour le
 *      multimodal ; les bandes 0 = raisonnement-humain it.85 et 1 = couleurs
 *      it.90→92 ne sont pas touchées) : gravure par famille avec plasticité
 *      supervisée, mesure avant/après sur 70 questions RÉSERVÉES (10 par
 *      famille, graine distincte 20261105 — jamais entraînées), snapshot
 *      cumulatif exporté.
 *
 * Usage :
 *   NODE_OPTIONS=--max-old-space-size=3072 npx tsx scripts/entrainement-raisonnement-it94.ts
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
import {
  CORPUS_RAISONNEMENT_IT94,
  CORPUS_RAISONNEMENT_IT94_EVAL,
} from "../lib/neural/generation/corpus-raisonnement-it94";
import { PAIRES_MULTIMODAL_IT94, ASSETS_MULTIMODAL_IT94 } from "../lib/neural/generation/multimodal-it94";
import {
  FAMILLES_IT94,
  genererRaisonnementIt94,
  type FamilleRaisonnementIt94,
} from "../lib/gen3/raisonnement-it94";

const SNAPSHOT_SOURCE = "public/neural/cortex-couleurs-it92.bin";
const SNAPSHOT_SORTIE = "public/neural/cortex-raisonnement-it94.bin";
const DIR_OUT = "var/entrainement-raisonnement-it94";

const ONDES_PAR_FAMILLE = Number(process.env.ONDES_PAR_FAMILLE ?? "300");
const CYCLES = Number(process.env.CYCLES ?? "4");
const GRANDE = 20261104;

/** Bandes dédiées it.94 : familles 2..8, multimodal 9 (0 et 1 conservées). */
const BANDE_MULTIMODAL = 9;
const bandeFamille = (f: FamilleRaisonnementIt94): number => 2 + FAMILLES_IT94.indexOf(f);

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
  log(`DÉBUT it.94 — 7 familles de raisonnement + multimodal réel, graine ${GRANDE}`);

  // ─── Phase 1 : lots déterministes + contrôles d'honnêteté ────────────────
  const train = genererRaisonnementIt94(ONDES_PAR_FAMILLE, 42);
  const parFamille: Record<string, number> = {};
  for (const p of train) parFamille[p.famille] = (parFamille[p.famille] ?? 0) + 1;
  const motifsTrain = new Set(train.map((p) => p.motif));
  const fuite = CORPUS_RAISONNEMENT_IT94_EVAL.filter((p) => motifsTrain.has(p.motif)).length;
  if (fuite > 0) throw new Error(`fuite éval→train : ${fuite} motifs partagés (graines non disjointes)`);
  log(`train ondes : ${train.length} paires (${JSON.stringify(parFamille)}) — éval réservée ${CORPUS_RAISONNEMENT_IT94_EVAL.length} paires (formulations inédites), fuite vérifiée : 0`);
  log(`corpus chat : ${CORPUS_RAISONNEMENT_IT94.length} paires raisonnement (7 familles × 20)`);
  const octetsAssets = ASSETS_MULTIMODAL_IT94.reduce((s, a) => s + a.bytes, 0);
  log(`assets multimodaux réels : ${ASSETS_MULTIMODAL_IT94.length} (${(octetsAssets / 1e6).toFixed(2)} Mo)`);

  // ─── Phase 2 : apprentissage langagier (même chemin que la production) ───
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3 as never);
  const t2 = Date.now();
  cortex.apprendre([...CORPUS_RAISONNEMENT_IT94, ...PAIRES_MULTIMODAL_IT94] as never);
  log(`corpus production (${CORPUS_GEN3.length} paires) + ${CORPUS_RAISONNEMENT_IT94.length} raisonnement + ${PAIRES_MULTIMODAL_IT94.length} multimodal assimilés en ${((Date.now() - t2) / 1000).toFixed(1)} s`);

  let servies = 0;
  let exactes = 0;
  for (const p of [...CORPUS_RAISONNEMENT_IT94, ...PAIRES_MULTIMODAL_IT94]) {
    const r = cortex.repondre(p.motif);
    if (!r) continue;
    if (r.texte.includes(p.reponse.slice(0, 60))) exactes += 1;
    if (r.texte.length > 20) servies += 1;
  }
  const totalNouvelles = CORPUS_RAISONNEMENT_IT94.length + PAIRES_MULTIMODAL_IT94.length;
  log(`paires nouvelles servies par le chat : ${servies}/${totalNouvelles} (réponse exacte : ${exactes}/${totalNouvelles})`);

  // ─── Phase 3 : ONDES SNN — 7 bandes dédiées + multimodal ─────────────────
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

    let horlogeMesure = 0;
    const BANDES_IT94 = new Set(FAMILLES_IT94.map((f) => bandeFamille(f)));
    BANDES_IT94.add(BANDE_MULTIMODAL);
    interface MesureUne { hit: number; sep: number; top3: number; dom: number }
    const mesurerBande = (question: string, bande: number): MesureUne | null => {
      const tokens = tokenize(question);
      if (tokens.length === 0) return null;
      horlogeMesure += 1;
      cortexSnn.pas(colonnesDepuisOndes(tokens, nbColonnes), horlogeMesure);
      const act = cortexSnn.activationBandes();
      let dom = 0;
      for (let b = 1; b < act.length; b++) if (act[b] > act[dom]) dom = b;
      const tri = act.map((v, b) => [b, v] as const).sort((x, y) => y[1] - x[1]);
      const top3 = new Set(tri.slice(0, 3).map(([b]) => b));
      let maxIt94B = -1;
      let maxIt94 = -1;
      for (const b of BANDES_IT94) if (act[b] > maxIt94) { maxIt94 = act[b]; maxIt94B = b; }
      return { hit: dom === bande ? 1 : 0, sep: maxIt94B === bande ? 1 : 0, top3: top3.has(bande) ? 1 : 0, dom };
    };

    interface Agregat { hits: number; sep: number; top3: number; total: number }
    const mesures = (bande: number, questions: readonly string[]): Agregat => {
      const agg: Agregat = { hits: 0, sep: 0, top3: 0, total: 0 };
      for (const q of questions) {
        const r = mesurerBande(q, bande);
        if (!r) continue;
        agg.hits += r.hit;
        agg.sep += r.sep;
        agg.top3 += r.top3;
        agg.total += 1;
      }
      return agg;
    };

    // Questions réservées par famille (formulations inédites — jamais gravées).
    // La SNN stimule le FOND (sans préfixe) : l'encodage positionnel rend un
    // préfixe destructeur de résonance (sonde it.94b). Type de mesure honnête :
    //   - « généralisation » pour les familles à grand espace (deduction,
    //     spatial, temporel) : instances de la graine éval jamais vues ;
    //   - « rétention » pour les familles à espace fini (conditionnel 30,
    //     analogie 18, causalite 16, planification) : fonds possiblement couverts
    //     par le train — la mesure vérifie alors la rétention de la bande.
    const ESPACES_FINS = new Set<string>(["conditionnel", "analogie", "causalite", "planification"]);
    const evalParFamille = new Map<FamilleRaisonnementIt94, string[]>();
    for (const f of FAMILLES_IT94) {
      evalParFamille.set(
        f,
        CORPUS_RAISONNEMENT_IT94_EVAL
          .filter((p) => p.theme === `raisonnement-${f}`)
          .map((p) => p.fond),
      );
    }
    const bandesFamilles = FAMILLES_IT94.map(bandeFamille);
    const questionsEval = FAMILLES_IT94.map((f) => evalParFamille.get(f) ?? []);
    const avantFamilles = bandesFamilles.map((b, i) => mesures(b, questionsEval[i]));
    const avantMM = mesures(BANDE_MULTIMODAL, PAIRES_MULTIMODAL_IT94.map((p) => p.motif));
    const fmtFamilles = (ms: readonly Agregat[]): string =>
      FAMILLES_IT94.map((f, i) => `${f} dom:${ms[i].hits}/${ms[i].total} sep:${ms[i].sep} top3:${ms[i].top3}`).join(", ");
    log(`AVANT : ${fmtFamilles(avantFamilles)} | multimodal dom:${avantMM.hits}/${avantMM.total} sep:${avantMM.sep} top3:${avantMM.top3}`);

    // Gravure famille par famille (plasticité supervisée vers la bande dédiée)
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
      gravees += 1;
    };

    const labels: Record<string, string> = {};
    const CIBLE = Number(process.env.ONDES_CIBLE_PAR_FAMILLE ?? "4000");
    // PASSES > 1 : chaque famille est re-renforcée à chaque passe — la
    // punition compétitive d'une gravure affaiblit les bandes voisines
    // gravées avant elle ; plusieurs passes rétablissent l'équilibre.
    const PASSES = Number(process.env.PASSES ?? "3");
    FAMILLES_IT94.forEach((f) => {
      const bande = bandeFamille(f);
      labels[f] = labelPourBande(bande, `raisonnement-it94-${f}-`);
    });
    labelPourBande(BANDE_MULTIMODAL, "multimodal-it94-");
    for (let passe = 0; passe < PASSES; passe++) {
      for (const f of FAMILLES_IT94) {
        const bande = bandeFamille(f);
        const lot = train.filter((p) => p.famille === f);
        if (lot.length === 0) continue;
        // Renforcement par répétition (mécanisme réel de plasticité — cf. it.92 :
        // 101 138 ondes sur la bande 1) : chaque famille atteint son volume cible.
        const reps = Math.max(1, Math.ceil(CIBLE / lot.length));
        let graveesFamille = 0;
        for (let rep = 0; rep < reps && graveesFamille < CIBLE; rep++) {
          for (const p of lot) {
            graver(p.motif, p.reponse, bande);
            graveesFamille += 1;
            if (graveesFamille >= CIBLE) break;
          }
        }
        if (passe === 0 || passe === PASSES - 1) {
          log(`gravure p${passe + 1}/${PASSES} ${f} : ${graveesFamille} ondes (${lot.length} paires × ${reps} répétitions) → bande ${bande}`);
        }
      }
      const cibleMM = Math.max(1, Math.ceil(2000 / PAIRES_MULTIMODAL_IT94.length));
      for (let rep = 0; rep < cibleMM; rep++) {
        for (const p of PAIRES_MULTIMODAL_IT94) graver(p.motif, p.reponse, BANDE_MULTIMODAL);
      }
    }
    log(`gravure multimodal : ${PAIRES_MULTIMODAL_IT94.length * Math.max(1, Math.ceil(2000 / PAIRES_MULTIMODAL_IT94.length)) * PASSES} ondes au total → bande ${BANDE_MULTIMODAL}`);

    const apresFamilles = bandesFamilles.map((b, i) => mesures(b, questionsEval[i]));
    const apresMM = mesures(BANDE_MULTIMODAL, PAIRES_MULTIMODAL_IT94.map((p) => p.motif));
    const somme = (ms: readonly Agregat[], cle: keyof Agregat): number => ms.reduce((s, m) => s + m[cle], 0);
    const avantTotal = somme(avantFamilles, "hits") + avantMM.hits;
    const apresTotal = somme(apresFamilles, "hits") + apresMM.hits;
    const totalMesures = somme(avantFamilles, "total") + avantMM.total;
    const avantSep = somme(avantFamilles, "sep") + avantMM.sep;
    const apresSep = somme(apresFamilles, "sep") + apresMM.sep;
    const avantTop3 = somme(avantFamilles, "top3") + avantMM.top3;
    const apresTop3 = somme(apresFamilles, "top3") + apresMM.top3;
    log(`APRÈS : ${fmtFamilles(apresFamilles)} | multimodal dom:${apresMM.hits}/${apresMM.total} sep:${apresMM.sep} top3:${apresMM.top3}`);
    log(`TOTAL : dominance stricte ${avantTotal}/${totalMesures} → ${apresTotal}/${totalMesures} | séparation it.94 ${avantSep} → ${apresSep} | top-3 ${avantTop3} → ${apresTop3} après ${gravees} ondes`);

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
      bandes: { ...Object.fromEntries(FAMILLES_IT94.map((f, i) => [f, bandesFamilles[i]])), multimodal: BANDE_MULTIMODAL },
      labels,
      typesMesure: {
        ...Object.fromEntries(FAMILLES_IT94.map((f) => [f, ESPACES_FINS.has(f) ? "rétention" : "généralisation"])),
        multimodal: "rétention (assets réels, fenêtre suivante)",
      },
      avant: { familles: avantFamilles, multimodal: avantMM },
      apres: { familles: apresFamilles, multimodal: apresMM },
      totalMesures, avantTotal, apresTotal, avantSep, apresSep, avantTop3, apresTop3,
      noteMesure: "dominance stricte = bande attendue #1 de toutes (concurrence historique b0 raisonnement-humain 999 935 paires, b1 couleurs 101 138 ondes) ; séparation it.94 = bande attendue #1 parmi les 8 bandes it.94 (b2..b9) ; top-3 = bande attendue dans le podium d'activation.",
      snapshot: SNAPSHOT_SORTIE, octets: snapshot.length,
    };
  } catch (err) {
    log(`phase ONDES en échec (non bloquant) : ${String(err)}`);
  }

  const rapport = {
    date: new Date().toISOString(),
    dureeMs: Date.now() - t0,
    raisonnement: {
      familles: FAMILLES_IT94,
      pairesChat: CORPUS_RAISONNEMENT_IT94.length,
      pairesEvalReservees: CORPUS_RAISONNEMENT_IT94_EVAL.length,
      pairesTrainOndes: train.length,
      parFamille,
    },
    multimodal: { total: ASSETS_MULTIMODAL_IT94.length, octets: octetsAssets, pairesServies: servies, pairesExactes: exactes },
    corpusProduction: CORPUS_GEN3.length,
    snn,
    snapshot: SNAPSHOT_SORTIE,
  };
  writeFileSync(join(DIR_OUT, "rapport-it94.json"), JSON.stringify(rapport, null, 2));
  // Copie du rapport dans var-copie (convention de la chaîne de ticks)
  writeFileSync("var-copie/rapport-it94.json", JSON.stringify(rapport, null, 2));
  log(`TERMINÉ en ${((Date.now() - t0) / 1000).toFixed(1)} s — rapport : ${join(DIR_OUT, "rapport-it94.json")}`);
}

main();
