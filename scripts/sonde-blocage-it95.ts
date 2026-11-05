/**
 * SONDE MINIMALE — isole le point de blocage de la gravure it.95 :
 * import snapshot → 1 pas() → activationBandes → 1 plasticiteSupervisee,
 * chronométré étape par étape, sur la source passée en argument
 * (défaut : snapshot it.94). Aucune écriture.
 * Usage : npx tsx scripts/sonde-blocage-it95.ts [chemin-snapshot]
 */
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import {
  ECHELLE_QUANTISATION_U8,
  importerSnapshotTelephone,
} from "../lib/neural/core/v2/energie";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { PAIRES_MULTIMODAL_IT95 } from "../lib/neural/generation/multimodal-it95";

const SOURCE = process.argv[2] ?? "public/neural/cortex-raisonnement-it94.bin";
const t = (m: string, t0: number): void => console.log(`${m} — ${(performance.now() - t0).toFixed(0)} ms`);

const T0 = performance.now();
const brut = readFileSync(SOURCE);
const u8 = new Uint8Array(brut.buffer, brut.byteOffset, brut.byteLength);
const { entete, poidsU8 } = importerSnapshotTelephone(u8);
t("import snapshot", T0);
const cortexSnn = new CortexColumnnaire({
  colonnes: entete.colonnes, voisins: entete.voisins, bandes: entete.bandes,
  bandesLecture: entete.bandesLecture, seed: entete.seed,
  seuil: entete.seuil, decroissance: entete.decroissance, plasticiteFenetre: entete.plasticiteFenetre,
});
const poidsF32 = new Float32Array(poidsU8.length);
for (let i = 0; i < poidsU8.length; i++) poidsF32[i] = poidsU8[i] / ECHELLE_QUANTISATION_U8;
if (!cortexSnn.importerPoids(poidsF32)) throw new Error("import poids : longueur inattendue");
t("cortex reconstruit + poids importés", T0);

const tokens = tokenize(`${PAIRES_MULTIMODAL_IT95[0].motif} ${PAIRES_MULTIMODAL_IT95[0].reponse}`);
console.log(`tokens: ${tokens.length}`);
const nbColonnes = cortexSnn.config.colonnes;
const accumule = new Map<number, number>();
tokens.forEach((token, i) => {
  const h0 = 2166136261;
  let h = h0;
  for (let k = 0; k < token.length; k++) { h ^= token.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; }
  h = h >>> 0;
  const w = 0.25 + (h / 0xffffffff) * 1.5;
  const phi = ((h / 0xffffffff) * 2 * Math.PI + i * 1.6180339) % (2 * Math.PI);
  const a = Math.min(1, 0.25 + token.length / 24);
  const base = (Math.sin(phi) + 1) / 2 + w / 1.75;
  const colonne = Math.floor((base % 1) * nbColonnes);
  const intensite = 1.2 * a;
  const suivant = Math.min(3.0, (accumule.get(colonne) ?? 0) + intensite);
  accumule.set(colonne, suivant);
});
const injections = Array.from(accumule.entries());
t("colonnes calculées", T0);

cortexSnn.pas(injections, 1);
t("pas() #1", T0);
cortexSnn.pas(null, 2);
t("pas() #2 (sans injection)", T0);
const act = cortexSnn.activationBandes();
t("activationBandes()", T0);
console.log(`act[0..9] = ${Array.from(act.slice(0, 10)).map((v) => v.toFixed(2)).join(", ")}`);
const concurrentes: number[] = [];
for (let b = 0; b < cortexSnn.config.bandes; b++) if (b !== 9 && act[b] > act[9]) concurrentes.push(b);
console.log(`bandes concurrentes: ${concurrentes.length} → [${concurrentes.join(",")}]`);
const stimulees = injections.map(([c]) => c);
console.log(`colonnes stimulées: ${stimulees.length}`);
cortexSnn.plasticiteSupervisee(stimulees, 9, cortexSnn.config.lrBoost, concurrentes);
t("plasticiteSupervisee() #1", T0);
console.log("SONDE TERMINÉE — aucune étape bloquée");

// ─── PROLONGATION : état accumulé ───
import { performance as perf2 } from "node:perf_hooks";
const T1 = perf2.now();
for (let i = 3; i <= 30; i++) cortexSnn.pas(injections, i);
console.log(`30 pas() cumulés — ${(perf2.now() - T1).toFixed(0)} ms`);
const act2 = cortexSnn.activationBandes();
console.log(`après 30 pas : act[0..9] = ${Array.from(act2.slice(0, 10)).map((v) => v.toFixed(2)).join(", ")}`);
const T2 = perf2.now();
cortexSnn.plasticiteSupervisee(stimulees, 9, cortexSnn.config.lrBoost, []);
console.log(`plasticite concurrentes=[] après état accumulé — ${(perf2.now() - T2).toFixed(0)} ms`);
const act3 = cortexSnn.activationBandes();
const conc2: number[] = [];
for (let b = 0; b < cortexSnn.config.bandes; b++) if (b !== 9 && act3[b] > act3[9]) conc2.push(b);
const T3 = perf2.now();
cortexSnn.plasticiteSupervisee(stimulees, 9, cortexSnn.config.lrBoost, conc2);
console.log(`plasticite concurrentes=${conc2.length} après état accumulé — ${(perf2.now() - T3).toFixed(0)} ms`);
const T4 = perf2.now();
for (let i = 31; i <= 60; i++) cortexSnn.pas(i === 31 ? injections : null, i);
console.log(`30 pas() supplémentaires — ${(perf2.now() - T4).toFixed(0)} ms`);
