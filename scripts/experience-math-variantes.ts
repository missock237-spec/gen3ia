/**
 * EXPÉRIENCE CONTRÔLÉE — régression math (15 % → 2.3 %) après enrichissement PRO2.
 * Mesure honnête de 3 variantes d'ingestion sur les MÊMES 300 questions
 * tenues à l'écart (dernières lignes de math_professionnel/train.jsonl).
 *
 *  A  : ingestion PRO2 telle quelle (2000 normalisées d'abord)
 *  B  : ingestion RAW d'abord (comportement baseline — paires brutes GSM8K)
 *  C  : ingestion normalisée, mais sortie = chaîne propre + chaîne originale
 *       (annotée) — maximise l'information réelle et le recouvrement lexical
 *
 * Exécution : npx tsx scripts/experience-math-variantes.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { tokenize } from "../lib/neural/encoding/text-encoder";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";

interface Paire { instruction: string; output: string; }

const lignes = readFileSync(join(process.cwd(), "datasets/math_professionnel/train.jsonl"), "utf8")
  .split("\n").filter(Boolean);
// Parsing résilient (même règle que evaluation-1m.ts) : quelques enregistrements
// multi-physiques préexistants sont sautés silencieusement.
const toutes: Array<Paire & { id?: string }> = [];
let _ignores = 0;
for (const l of lignes) {
  try {
    toutes.push(JSON.parse(l) as Paire & { id?: string });
  } catch {
    _ignores++;
  }
}
const queue = toutes.slice(-600);
const heldOut = queue.slice(0, 300); // même fenêtre que evaluation-1m (REGLES=300)

function pairesDepuis(liste: Paire[], quota: number): Array<{ motif: string; reponse: string }> {
  const paires: Array<{ motif: string; reponse: string }> = [];
  for (const o of liste) {
    if (paires.length >= quota) break;
    const motif = o.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
    if (motif.length < 12) continue;
    paires.push({ motif, reponse: o.output.slice(0, 700) });
  }
  return paires;
}

/** Chaîne originale annotée : les paires PRO2 normalisées portent l'id
 *  « gen3ia-pro2-math- » ; la chaîne originale n'y est plus — on la retrouve
 *  depuis le fichier RAW GSM8K par correspondance de question exacte. */
const RAW_GSM8K: Map<string, string> = (() => {
  try {
    const brut = readFileSync("/tmp/gsm8k_raw_train.jsonl", "utf8");
    const m = new Map<string, string>();
    for (const l of brut.split("\n").filter(Boolean)) {
      const o = JSON.parse(l) as { question: string; answer: string };
      m.set(o.question.trim(), o.answer);
    }
    return m;
  } catch {
    return new Map();
  }
})();

function varianteA(): Array<{ motif: string; reponse: string }> {
  return pairesDepuis(toutes, 4000);
}

function varianteB(): Array<{ motif: string; reponse: string }> {
  // RAW d'abord : les paires non-PRO2 (l'ancien ordre) puis PRO2
  const anciennes = toutes.filter((p) => !p.id?.startsWith("gen3ia-pro2-math"));
  return pairesDepuis(anciennes, 4000);
}

function varianteC(): Array<{ motif: string; reponse: string }> {
  const liste = toutes.slice(0, 4000).map((p) => {
    if (p.id?.startsWith("gen3ia-pro2-math")) {
      const brut = RAW_GSM8K.get(p.instruction.trim());
      if (brut) return { instruction: p.instruction, output: `${p.output}\nOriginal: ${brut.slice(0, 400)}` };
    }
    return p;
  });
  return pairesDepuis(liste, 4000);
}

function hit(reponse: string | null, attendu: string): boolean {
  if (!reponse) return false;
  const a = new Set(tokenize(attendu).filter((t) => t.length >= 4));
  const r = new Set(tokenize(reponse));
  let c = 0;
  for (const t of a) if (r.has(t)) c++;
  return c >= 3;
}

function mesurer(nom: string, paires: Array<{ motif: string; reponse: string }>): number {
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3);
  cortex.apprendre(paires.map((p) => ({ ...p, theme: `exp:${nom}` })) as never);
  let hits = 0;
  for (const q of heldOut) {
    const motif = q.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
    const rep = cortex.repondre(motif, {});
    if (hit(rep?.texte ?? "", q.output)) hits++;
  }
  const taux = Number((hits / heldOut.length).toFixed(4));
  console.log(`  Variante ${nom}: hit = ${taux} (${hits}/${heldOut.length})`);
  return taux;
}

console.log(`Questions tenues à l'écart: ${heldOut.length}`);
const resultats = {
  A_actuelle: mesurer("A", varianteA()),
  B_raw_dabord: mesurer("B", varianteB()),
  C_normale_plus_originale: mesurer("C", varianteC()),
};
mkdirSync(join(process.cwd(), "var", "rapports"), { recursive: true });
writeFileSync(join(process.cwd(), "var", "rapports", "experience-math-variantes.json"),
  JSON.stringify({ date: new Date().toISOString(), resultats, heldOut: heldOut.length }, null, 1), "utf8");
console.log("Rapport: var/rapports/experience-math-variantes.json");
