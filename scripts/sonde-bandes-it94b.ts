/**
 * SONDE it.94b — confirme/refute l'hypothèse « préfixe d'éval décale les
 * colonnes » : stimule (1) un motif de train brut, (2) le même fond préfixé
 * (éval), et affiche le top-3 des bandes activées à chaque fois.
 */
import { readFileSync } from "node:fs";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ECHELLE_QUANTISATION_U8, importerSnapshotTelephone } from "../lib/neural/core/v2/energie";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { genererRaisonnementIt94 } from "../lib/gen3/raisonnement-it94";

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function colonnesDepuisOndes(tokens: string[], nbColonnes: number): Array<[number, number]> {
  const accumule = new Map<number, number>();
  tokens.forEach((token, i) => {
    if (token.length === 0) return;
    const h = fnv1a(token);
    const w = 0.25 + (h / 0xffffffff) * 1.5;
    const phi = ((h / 0xffffffff) * 2 * Math.PI + i * 1.6180339) % (2 * Math.PI);
    const a = Math.min(1, 0.25 + token.length / 24);
    const base = (Math.sin(phi) + 1) / 2 + w / 1.75;
    const colonne = Math.floor((base % 1) * nbColonnes);
    accumule.set(colonne, Math.min(3.0, (accumule.get(colonne) ?? 0) + 1.2 * a));
  });
  return Array.from(accumule.entries());
}

function main(): void {
  const brut = readFileSync("public/neural/cortex-raisonnement-it94.bin");
  const u8 = new Uint8Array(brut.buffer, brut.byteOffset, brut.byteLength);
  const { entete, poidsU8 } = importerSnapshotTelephone(u8);
  const c = new CortexColumnnaire({
    colonnes: entete.colonnes, voisins: entete.voisins, bandes: entete.bandes,
    bandesLecture: entete.bandesLecture, seed: entete.seed,
    seuil: entete.seuil, decroissance: entete.decroissance, plasticiteFenetre: entete.plasticiteFenetre,
  });
  const f32 = new Float32Array(poidsU8.length);
  for (let i = 0; i < poidsU8.length; i++) f32[i] = poidsU8[i] / ECHELLE_QUANTISATION_U8;
  if (!c.importerPoids(f32)) throw new Error("import");
  const nb = c.config.colonnes;

  const train = genererRaisonnementIt94(300, 42).filter((p) => p.famille === "deduction");
  const evalP = genererRaisonnementIt94(10, 20261105, true).filter((p) => p.theme === "raisonnement-deduction");

  const sonde = (question: string, etiquette: string): void => {
    const tokens = tokenize(question);
    if (tokens.length === 0) return;
    c.pas(colonnesDepuisOndes(tokens, nb), 1);
    const act = c.activationBandes();
    const tri = act.map((v, b) => [b, v] as const).sort((x, y) => y[1] - x[1]).slice(0, 3);
    console.log(`${etiquette} : tokens=${tokens.length} → top3 = ${tri.map(([b, v]) => `b${b}:${v.toFixed(3)}`).join(" | ")}`);
  };

  sonde(train[0].motif, "TRAIN brut      ");
  sonde(train[1].motif, "TRAIN brut      ");
  sonde(evalP[0].motif, "EVAL préfixé    ");
  sonde(evalP[0].motif.replace(/^[^:]+: /, ""), "EVAL sans préfixe");
  sonde(evalP[1].motif, "EVAL préfixé    ");
  sonde(evalP[1].motif.replace(/^[^:]+: /, ""), "EVAL sans préfixe");
}

main();
