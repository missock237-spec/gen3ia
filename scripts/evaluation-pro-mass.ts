/**
 * ÉVALUATION PROFESSIONNELLE MASSIVE — questions de test EXTERNES réelles.
 * Job 478451 (relance CD).
 *
 * Généralisation (jamais vues) :
 *  - GSM8K **test** officiel OpenAI (1319 Q — split externe, jamais ingéré)
 *  - SciQ validation+test (2000 Q réelles — jamais ingérées)
 *  - Couleurs : 10 000 Q fraîches déterministes (table pro Kaggle)
 * Mémorisation d'assets réels (paires réelles apprises) :
 *  - multimodal_reel_* (audio FLEURS / vidéo UCF101 / photos)
 *
 * Le cortex apprend EXACTEMENT comme evaluation-1m.ts (mêmes quotas PRO2) puis
 * répond à chaque question. Métriques : hit (recouvrement ≥ 3 tokens, règle
 * identique à la baseline) + exactitude finale pour math (nombre extrait).
 *
 * Exécution : npx tsx scripts/evaluation-pro-mass.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { tokenize } from "../lib/neural/encoding/text-encoder";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";

interface Question {
  dataset: string;
  question: string;
  reponseAttenue: string;
  reponseFinale?: string;
}

function charger(nom: string): Question[] {
  const chemin = join(process.cwd(), "var", "eval-pro", nom);
  if (!existsSync(chemin)) return [];
  return readFileSync(chemin, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Question);
}

/** Apprentissage IDENTIQUE à evaluation-1m.ts (quotas PRO2) — même distribution. */
function apprendreCortex(): { cortex: CortexLangagierGen3; pairesApprises: number } {
  const cortex = new CortexLangagierGen3();
  cortex.apprendre(CORPUS_GEN3);
  const SOURCES = [
    ["couleurs_v5", 4000], ["math_professionnel", 4000],
    ["sciences_professionnel", 3600], ["raisonnement_professionnel", 2100],
    ["vision_professionnel", 800], ["texte_professionnel", 400],
    ["parole_professionnelle", 400],
  ] as const;
  let pairesTotales = 0;
  for (const [dossier, quota] of SOURCES) {
    const chemin = join(process.cwd(), "datasets", dossier, "train.jsonl");
    if (!existsSync(chemin)) continue;
    const lignes = readFileSync(chemin, "utf8").split("\n");
    const paires: Array<{ motif: string; reponse: string }> = [];
    for (const ligne of lignes) {
      if (paires.length >= quota) break;
      if (!ligne.trim()) continue;
      try {
        const o = JSON.parse(ligne) as { instruction: string; output: string };
        if (!o.instruction || !o.output) continue;
        const motif = o.instruction.split(/[.!?]/)[0].trim().slice(0, 160);
        if (motif.length < 12) continue;
        paires.push({ motif, reponse: o.output.slice(0, 700) });
      } catch { /* ignore */ }
    }
    const stats = cortex.apprendre(paires.map((p) => ({ ...p, theme: `pro2:${dossier}` })) as never);
    pairesTotales += (stats as { pairesAjoutees: number }).pairesAjoutees;
  }
  return { cortex, pairesApprises: pairesTotales };
}

/** Extraction du nombre final d'une réponse du cortex (pour math). */
function extraireNombreFinal(texte: string): string | null {
  const nombres = [...texte.matchAll(/-?\d[\d,\s]*(?:\.\d+)?/g)].map((m) =>
    m[0].replace(/[\s,]/g, ""),
  );
  return nombres.length ? nombres[nombres.length - 1] : null;
}

function hit(reponse: string | null, attendu: string): boolean {
  if (!reponse) return false;
  const tokensAttendus = new Set(tokenize(attendu).filter((t) => t.length >= 4));
  const tokensReponse = new Set(tokenize(reponse));
  let communs = 0;
  for (const t of tokensAttendus) if (tokensReponse.has(t)) communs++;
  return communs >= 3;
}

const ensemble = {
  math: charger("math-gsm8k-test.jsonl"),
  sciences: charger("sciences-sciq-unseen.jsonl"),
  couleurs: charger("couleurs-mass.jsonl"),
  paroleGeneralisation: charger("parole-fleurs-test.jsonl"),
  paroleMemorisation: charger("parole-fleurs-memorise.jsonl"),
  multimodal: charger("multimodal-reel.jsonl"),
};

console.log("[1/2] Apprentissage du cortex (quotas PRO2 identiques à evaluation-1m)...");
const { cortex, pairesApprises } = apprendreCortex();
console.log(`     paires apprises: ${pairesApprises}`);

console.log("[2/2] Réponse aux questions de test externes...");
const debut = Date.now();
const rapportParEnsemble: Record<string, unknown> = {};

for (const [nom, questions] of Object.entries(ensemble)) {
  let hits = 0;
  let exactMath = 0;
  let nbMathAvecFinale = 0;
  const parDataset: Record<string, { total: number; hits: number }> = {};
  for (const q of questions) {
    parDataset[q.dataset] ??= { total: 0, hits: 0 };
    parDataset[q.dataset].total++;
    const reponse = cortex.repondre(q.question, {});
    const reponseTxt = reponse?.texte ?? "";
    if (hit(reponseTxt, q.reponseAttenue)) {
      hits++;
      parDataset[q.dataset].hits++;
    }
    if (nom === "math" && q.reponseFinale) {
      nbMathAvecFinale++;
      const extrait = extraireNombreFinal(reponseTxt);
      const attendu = q.reponseFinale.replace(/[\s,]/g, "");
      if (extrait && extrait === attendu) exactMath++;
    }
  }
  const total = questions.length;
  rapportParEnsemble[nom] = {
    questionsReelles: total,
    hitRecouvrement: Number((hits / Math.max(1, total)).toFixed(4)),
    ...(nom === "math"
      ? { exactitudeReponseFinale: Number((exactMath / Math.max(1, nbMathAvecFinale)).toFixed(4)), questionsAvecFinale: nbMathAvecFinale }
      : {}),
    parDataset: Object.fromEntries(
      Object.entries(parDataset).map(([d, v]) => [d, Number((v.hits / v.total).toFixed(3))]),
    ),
  };
  console.log(`  ${nom}: ${total} questions, hit=${rapportParEnsemble[nom] instanceof Object ? (rapportParEnsemble[nom] as { hitRecouvrement: number }).hitRecouvrement : "?"}`);
}

const rapport = {
  date: new Date().toISOString(),
  job: "478451",
  pairesApprises,
  dureeMs: Date.now() - debut,
  note: "Questions EXTERNES : GSM8K test (split officiel jamais ingéré), SciQ validation+test (jamais ingérées), couleurs fraîches (graine), multimodal réel (mémorisation d'assets)",
  resultats: rapportParEnsemble,
};
mkdirSync(join(process.cwd(), "var", "rapports"), { recursive: true });
writeFileSync(join(process.cwd(), "var", "rapports", "evaluation-pro-mass.json"), JSON.stringify(rapport, null, 1), "utf8");
console.log("Rapport: var/rapports/evaluation-pro-mass.json");
