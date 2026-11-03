/** PREUVE DE SERVICE it.96 — les nouvelles paires kext96_ sont servies par le
 * même chemin que la production (CortexLangagierGen3 + corpus appris).
 * Usage : npx tsx scripts/preuve-kext96.ts */
import { CORPUS_GEN3 } from "../lib/neural/generation/corpus";
import { PAIRES_MULTIMODAL_IT90 } from "../lib/neural/generation/multimodal-it90";
import { CortexLangagierGen3 } from "../lib/neural/generation/language";

const cortex = new CortexLangagierGen3();
const stats = cortex.apprendre(CORPUS_GEN3);
const comptes = { multimodales: PAIRES_MULTIMODAL_IT90.length, corpus: stats.totalPaires };
console.log(`corpus appris : ${comptes.corpus} paires (${comptes.multimodales} multimodales)`);

const questions = [
  "Que contient l'image kext96_image_004 ?",
  "Que contient l'image kext96_image_008 ?",
  "Que contient l'enregistrement audio kext96_audio_003 ?",
];

let ok = 0;
for (const q of questions) {
  const reponse = cortex.repondre(q);
  const text = typeof reponse === "string" ? reponse : (reponse as { texte?: string })?.texte ?? JSON.stringify(reponse);
  console.log(`\nQ: ${q}\nR: ${text.slice(0, 260)}`);
  if (text.includes("kext96") && (text.includes("COCO-2017") || text.includes("FLEURS"))) ok += 1;
}
console.log(`\nSCORE preuve locale kext96 : ${ok}/${questions.length}`);
if (ok < questions.length) process.exit(1);
