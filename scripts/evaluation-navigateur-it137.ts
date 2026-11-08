/**
 * ÉVALUATION NAVIGATEUR it.101 (Job 478451 : « Vérifie ses capacités de
 * mémorisation et de compréhension... Évalue sa précision »).
 *
 * Reproduit EXACTEMENT le chemin du chat navigateur (nova-chat →
 * CortexLangagierGen3.apprendre(CORPUS_GEN3) → repondre(motif)) et mesure :
 *   - la précision exacte GLOBALE sur toutes les paires du corpus ;
 *   - la précision PAR GROUPE de connaissances (base, domaines it.84,
 *     raisonnement it.85/94, interrogation it.86, couleurs it.89,
 *     multimodal it.90 → it.101) ;
 *   - la GÉNÉRALISATION sur des reformulations (variantes de motifs non
 *     apprises telles quelles — échantillon raisonné).
 *
 * Usage : NODE_OPTIONS=--max-old-space-size=3072 npx tsx scripts/evaluation-navigateur-it137.ts
 */
import { writeFileSync } from "node:fs";

import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import { CortexReflexifGen3 } from "../lib/neural/generation/memoire-reflexion";
import { ASSETS_MULTIMODAL_IT137, PAIRES_MULTIMODAL_IT137 } from "../lib/neural/generation/multimodal-it137";

const log = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

function groupeDe(motif: string, index: number, total: number): string {
  // Les paires multimodales sont identifiables par leur motif « ... kmNN_... »
  const mm = motif.match(/km(\d+)_/);
  if (mm) return `multimodal-it${mm[1]}`;
  // Répartition ordonnée du reste : les blocs du corpus sont empilés dans
  // l'ordre (base → it84 → it85 → it86 → it89 → multimodaux). On marque les
  // groupes par bornes mesurées sur les thèmes connus.
  if (/salutation|identite|remerciement|etat|honnetete/.test(motif) || index < 60) return "base-it84";
  if (total - index <= 60) return "recents";
  return "corps-domaines";
}

function main(): void {
  const t0 = Date.now();
  log(`DÉBUT évaluation navigateur — corpus ${CORPUS_GEN3.length} paires`);

  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3 as never);
  const tAppris = Date.now();
  log(`cortex appris en ${((tAppris - t0) / 1000).toFixed(1)} s`);

  // ─── 1. PRÉCISION DE MÉMORISATION (chemin exact du chat) ────────────────
  const parGroupe = new Map<string, { exact: number; servie: number; total: number }>();
  let exactTotal = 0;
  let servieTotal = 0;
  for (let i = 0; i < CORPUS_GEN3.length; i++) {
    const p = CORPUS_GEN3[i]!;
    const r = cortex.repondre(p.motif);
    const g = groupeDe(p.motif, i, CORPUS_GEN3.length);
    const agg = parGroupe.get(g) ?? { exact: 0, servie: 0, total: 0 };
    agg.total += 1;
    if (r) {
      if (r.texte.length > 20) {
        servieTotal += 1;
        agg.servie += 1;
      }
      if (r.texte.includes(p.reponse.slice(0, 60))) {
        exactTotal += 1;
        agg.exact += 1;
      }
    }
    parGroupe.set(g, agg);
  }
  log("PRÉCISION MÉMORISATION (motif exact → réponse attendue) :");
  for (const [g, a] of Array.from(parGroupe.entries()).sort()) {
    log(`  ${g.padEnd(22)} exact ${a.exact}/${a.total} (${((a.exact / a.total) * 100).toFixed(1)} %) · servie ${a.servie}/${a.total}`);
  }
  log(`  ${"GLOBAL".padEnd(22)} exact ${exactTotal}/${CORPUS_GEN3.length} (${((exactTotal / CORPUS_GEN3.length) * 100).toFixed(1)} %) · servie ${servieTotal}/${CORPUS_GEN3.length}`);

  // ─── 2 bis. MÉMOIRE DE RÉFLEXION (A/B — cortex FRAIS chacun) ─────────────
  // Le chemin réflexif commence TOUJOURS par la voie directe : il ne peut
  // pas servir moins que la base. Le gain se MESURE ici, sur le corpus
  // entier, avec un cortex frais pour éviter toute contamination d'usage.
  const cortexReflexe = new CortexLangagierGen3();
  cortexReflexe.apprendre(CORPUS_GEN3 as never);
  const reflexif = new CortexReflexifGen3(cortexReflexe);
  let reflexExact = 0;
  let reflexServie = 0;
  // Les voies sont comptées ICI (mémoire globale de la session) — le ring
  // buffer de la mémoire de réflexion reste borné à 256 entrées par design.
  // it.113 : voie « memorisee » = replay des enseignements chat/API (nécessite
  // une mémoire de domaines câblée — absente ici, donc toujours 0 dans ce rapport).
  const voiesComptees = { directe: 0, normalisee: 0, racourcie: 0, memorisee: 0, echec: 0 };
  for (const p of CORPUS_GEN3) {
    const d = reflexif.reflechir(p.motif);
    voiesComptees[d.voieElue] += 1;
    if (d.voieElue !== "echec") reflexServie += 1;
    if (d.elue.includes(p.reponse.slice(0, 60))) reflexExact += 1;
  }
  const gainPrecision = voiesComptees.normalisee + voiesComptees.racourcie;
  log(
    `MÉMOIRE DE RÉFLEXION : exact ${reflexExact}/${CORPUS_GEN3.length} (${((reflexExact / CORPUS_GEN3.length) * 100).toFixed(1)} %) · servie ${reflexServie}/${CORPUS_GEN3.length} — gain de précision (rattrapées par normalisée/raccourcie) : ${gainPrecision} · voie rapide : ${voiesComptees.directe}/${CORPUS_GEN3.length} · échec : ${voiesComptees.echec}`,
  );

  // ─── 3. GÉNÉRALISATION (reformulations non apprises telles quelles) ─────
  // Échantillon raisonné : pour des paires multimodales récentes, on pose la
  // question avec une formulation ALTERNE (casse/espace/ordre) — le cortex
  // doit retrouver la conversation la plus proche ou répondre honnêtement.
  const variantes = PAIRES_MULTIMODAL_IT137.slice(0, 6).map((p) => ({
    motif: p.motif.replace("Que contient ", "qu'est-ce que contient "),
    original: p.motif,
  }));
  let retrouvees = 0;
  for (const v of variantes) {
    const r = cortex.repondre(v.motif);
    if (r && r.texte.length > 20) retrouvees += 1;
  }
  log(`GÉNÉRALISATION (reformulations) : ${retrouvees}/${variantes.length} reformulations obtiennent une réponse servie`);

  // ─── 3. ASSETS RÉELS it.137 (multimodal, zéro fantôme) ──────────────────
  log(`ASSETS it.137 : ${ASSETS_MULTIMODAL_IT137.length} déclarés (images ${ASSETS_MULTIMODAL_IT137.filter((a) => a.modality === "image").length}, audios ${ASSETS_MULTIMODAL_IT137.filter((a) => a.modality === "audio").length})`);

  // ─── 4. FENÊTRE it.137 — précision dédiée (28 paires) ───────────────────
  let fenExact = 0;
  let fenServie = 0;
  for (const p of PAIRES_MULTIMODAL_IT137) {
    const r = cortex.repondre(p.motif);
    if (r) {
      if (r.texte.length > 20) fenServie += 1;
      if (r.texte.includes(p.reponse.slice(0, 60))) fenExact += 1;
    }
  }
  log(`FENÊTRE it.137 : ${fenExact}/${PAIRES_MULTIMODAL_IT137.length} exact · ${fenServie}/${PAIRES_MULTIMODAL_IT137.length} servie`);

  const rapport = {
    date: new Date().toISOString(),
    dureeMs: Date.now() - t0,
    corpus: CORPUS_GEN3.length,
    memoire: {
      globalExact: exactTotal,
      globalTotal: CORPUS_GEN3.length,
      tauxExact: Number(((exactTotal / CORPUS_GEN3.length) * 100).toFixed(2)),
      parGroupe: Object.fromEntries(Array.from(parGroupe.entries()).sort()),
    },
    generalisation: { reformulations: variantes.length, repondues: retrouvees },
    reflexion: {
      exact: reflexExact,
      servie: reflexServie,
      total: CORPUS_GEN3.length,
      tauxExact: Number(((reflexExact / CORPUS_GEN3.length) * 100).toFixed(2)),
      gainPrecision,
      voies: voiesComptees,
    },
    assetsIt131: ASSETS_MULTIMODAL_IT137.length,
    fenetreIt131: { exact: fenExact, servie: fenServie, total: PAIRES_MULTIMODAL_IT137.length },
  };
  writeFileSync("var/evaluation-navigateur-it137.json", JSON.stringify(rapport, null, 2));
  writeFileSync("var-copie/evaluation-navigateur-it137.json", JSON.stringify(rapport, null, 2));
  log(`TERMINÉ en ${((Date.now() - t0) / 1000).toFixed(1)} s — rapport : var/evaluation-navigateur-it137.json`);
}

main();
