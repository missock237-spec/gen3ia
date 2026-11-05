/**
 * SONDE it.94c — reproduit EXACTEMENT la mesure du script (horloge croissante,
 * fonds sans préfixe) et affiche pour chaque question le top-3 des bandes.
 * But : comprendre pourquoi la dominance mesurée reste faible (4/98).
 */
import { readFileSync } from "node:fs";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ECHELLE_QUANTISATION_U8, importerSnapshotTelephone } from "../lib/neural/core/v2/energie";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import {
  FAMILLES_IT94,
  genererRaisonnementIt94,
} from "../lib/gen3/raisonnement-it94";

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

  let horloge = 0;
  FAMILLES_IT94.forEach((famille, idx) => {
    const bandeAttendue = 2 + idx;
    const fonds = genererRaisonnementIt94(10, 20261105, true)
      .filter((p) => p.famille === famille)
      .map((p) => p.fond);
    let hits = 0;
    const details: string[] = [];
    for (const q of fonds) {
      const tokens = tokenize(q);
      if (tokens.length === 0) continue;
      horloge += 1;
      c.pas(colonnesDepuisOndes(tokens, nb), horloge);
      const act = c.activationBandes();
      const tri = act.map((v, b) => [b, v] as const).sort((x, y) => y[1] - x[1]).slice(0, 3);
      const dom = tri[0][0];
      if (dom === bandeAttendue) hits += 1;
      details.push(`dom=b${dom}(${tri[0][1].toFixed(2)}) [${tri.map(([b, v]) => `b${b}:${v.toFixed(2)}`).join(" ")}]`);
    }
    console.log(`${famille} (bande ${bandeAttendue}) : ${hits}/${fonds.length}`);
    details.forEach((d, i) => console.log(`   ${i}: ${d}`));
  });
}

main();
