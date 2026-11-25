/**
 * EXPÉRIENCE v2 — régression math en CONTEXTE COMPLET (tous datasets, IDF global).
 * Configurations mesurées sur les MÊMES questions tenues à l'écart :
 *   BASELINE : fichiers git HEAD + quotas anciens      (attendu ≈ 15 %)
 *   PRO2_A   : fichiers actuels + quotas PRO2          (mesuré 2.3 %)
 *   PRO2_C   : math augmentée « Original: » + quotas   (hypothèse d'amélioration)
 * Exécution : npx tsx scripts/experience-math-variantes2.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { tokenize } from "../lib/neural/encoding/text-encoder";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";

function lignesResilientes(chemin: string): Array<{ instruction: string; output: string; id?: string }> {
  if (!existsSync(chemin)) return [];
  const out: Array<{ instruction: string; output: string; id?: string }> = [];
  for (const l of readFileSync(chemin, "utf8").split("\n").filter(Boolean)) {
    try {
      out.push(JSON.parse(l));
    } catch { /* multi-physique préexistant */ }
  }
  return out;
}

/** Fichiers BASELINE via git show (les originaux, avant enrichissement PRO2). */
function lignesBaseline(dossier: string): Array<{ instruction: string; output: string; id?: string }> {
  const tmp = join("/tmp", "baseline-datasets", `${dossier}.jsonl`);
  try {
    if (!existsSync(tmp)) {
      mkdirSync("/tmp/baseline-datasets", { recursive: true });
      execSync(`git show HEAD:datasets/${dossier}/train.jsonl > "${tmp}" 2>/dev/null`, { cwd: process.cwd(), shell: "/bin/bash" });
    }
    return lignesResilientes(tmp);
  } catch {
    return [];
  }
}

const QUOTAS_BASELINE: Record<string, number> = {
  couleurs_v5: 2000, math_professionnel: 2000, sciences_professionnel: 1400,
  raisonnement_professionnel: 1600, vision_professionnel: 600, texte_professionnel: 400,
  parole_professionnelle: 150,
};
const QUOTAS_PRO2: Record<string, number> = {
  couleurs_v5: 4000, math_professionnel: 4000, sciences_professionnel: 3600,
  raisonnement_professionnel: 2100, vision_professionnel: 800, texte_professionnel: 400,
  parole_professionnelle: 400,
};
const DOMAINES = Object.keys(QUOTAS_PRO2);

function ingérer(fichier: (d: string) => Array<{ instruction: string; output: string }>, quotas: Record<string, number>, theme: string): { cortex: CortexLangagierGen3; total: number } {
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3);
  let total = 0;
  for (const dossier of DOMAINES) {
    const lignes = fichier(dossier);
    const paires: Array<{ motif: string; reponse: string }> = [];
    for (const o of lignes) {
      if (paires.length >= quotas[dossier]) break;
      const motif = o.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
      if (motif.length < 12) continue;
      paires.push({ motif, reponse: o.output.slice(0, 700) });
    }
    const stats = cortex.apprendre(paires.map((p) => ({ ...p, theme: `${theme}:${dossier}` })) as never);
    total += (stats as { pairesAjoutees: number }).pairesAjoutees;
  }
  return { cortex, total };
}

function hit(reponse: string | null, attendu: string): boolean {
  if (!reponse) return false;
  const a = new Set(tokenize(attendu).filter((t) => t.length >= 4));
  const r = new Set(tokenize(reponse));
  let c = 0;
  for (const t of a) if (r.has(t)) c++;
  return c >= 3;
}

/** Questions tenues à l'écart par dataset — DERNIÈRES lignes physiques du fichier ACTUEL. */
function questionsHorsApprentissage(dossier: string, n: number): Array<{ motif: string; attendu: string }> {
  const chemin = join(process.cwd(), "datasets", dossier, "train.jsonl");
  const physiques = readFileSync(chemin, "utf8").split("\n").filter(Boolean);
  const fenetre = physiques.slice(-n * 2);
  const out: Array<{ motif: string; attendu: string }> = [];
  for (const l of fenetre) {
    if (out.length >= n) break;
    try {
      const o = JSON.parse(l) as { instruction: string; output: string };
      const motif = o.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
      if (motif.length >= 12) out.push({ motif, attendu: o.output });
    } catch { /* ignore */ }
  }
  return out;
}

const HELD: Record<string, Array<{ motif: string; attendu: string }>> = {
  math_professionnel: questionsHorsApprentissage("math_professionnel", 300),
  sciences_professionnel: questionsHorsApprentissage("sciences_professionnel", 300),
  couleurs_v5: questionsHorsApprentissage("couleurs_v5", 300),
  parole_professionnelle: questionsHorsApprentissage("parole_professionnelle", 100),
  vision_professionnel: questionsHorsApprentissage("vision_professionnel", 100),
};

const BASELINE_FILE = (d: string) => lignesBaseline(d);
const ACTUEL_FILE = (d: string) => lignesResilientes(join(process.cwd(), "datasets", d, "train.jsonl"));

function mesurer(nom: string, fichier: (d: string) => Array<{ instruction: string; output: string }>, quotas: Record<string, number>): Record<string, number> {
  const { cortex, total } = ingérer(fichier, quotas, nom.toLowerCase());
  const detail: Record<string, number> = {};
  let tous = 0, questions = 0;
  for (const [dossier, qs] of Object.entries(HELD)) {
    let hits = 0;
    for (const q of qs) {
      if (hit(cortex.repondre(q.motif, {})?.texte ?? "", q.attendu)) hits++;
    }
    detail[dossier] = Number((hits / Math.max(1, qs.length)).toFixed(4));
    tous += hits;
    questions += qs.length;
  }
  detail._global = Number((tous / Math.max(1, questions)).toFixed(4));
  console.log(`  ${nom}: paires=${total}, hits=${JSON.stringify(detail)}`);
  return detail;
}

const resultats = {
  BASELINE_git_head_quotas_anciens: mesurer("BASELINE", BASELINE_FILE, QUOTAS_BASELINE),
  PRO2_A_actuel: mesurer("PRO2_A", ACTUEL_FILE, QUOTAS_PRO2),
};
mkdirSync(join(process.cwd(), "var", "rapports"), { recursive: true });
writeFileSync(join(process.cwd(), "var", "rapports", "experience-math-variantes2.json"),
  JSON.stringify({ date: new Date().toISOString(), resultats }, null, 1), "utf8");
console.log("Rapport: var/rapports/experience-math-variantes2.json");
