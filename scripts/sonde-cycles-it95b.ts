/**
 * SONDE it.95b — mécanique de résonance : combien de cycles pas() avant
 * que la bande 9 ne s'allume sur un motif gravé ? Affiche seuil/voisins,
 * l'activation par cycle (1..8) et le delta avant/après gravure pour UN
 * motif it.95. Aucune écriture.
 * Usage : npx tsx scripts/sonde-cycles-it95b.ts [snapshot]
 */
import { readFileSync } from "node:fs";

import { CortexColumnnaire } from "../lib/neural/core/v2/cortex-columnnaire";
import { ECHELLE_QUANTISATION_U8, importerSnapshotTelephone } from "../lib/neural/core/v2/energie";
import { tokenize } from "../lib/neural/encoding/text-encoder";
import { PAIRES_MULTIMODAL_IT95 } from "../lib/neural/generation/multimodal-it95";

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

function charger(chemin: string): CortexColumnnaire {
  const brut = readFileSync(chemin);
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
  console.log(`[${chemin}] seuil=${entete.seuil} voisins=${entete.voisins} decroissance=${entete.decroissance}`);
  return c;
}

const p = PAIRES_MULTIMODAL_IT95[0];
console.log(`motif : « ${p.motif} »`);
for (const chemin of process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["public/neural/cortex-raisonnement-it94.bin", "public/neural/cortex-multimodal-it95.bin"]) {
  const c = charger(chemin);
  const tokens = tokenize(`${p.motif} ${p.reponse}`);
  const inj = colonnesDepuisOndes(tokens, c.config.colonnes);
  console.log(`  tokens=${tokens.length} colonnes_injectees=${inj.length} valeurs_max=${Math.max(...inj.map(([, v]) => v)).toFixed(2)}`);
  for (let cycle = 1; cycle <= 8; cycle++) {
    c.pas(cycle === 1 ? inj : null, cycle);
    const act = c.activationBandes();
    const tri = act.map((v, b) => [b, v] as const).sort((x, y) => y[1] - x[1]).slice(0, 4);
    console.log(`  cycle ${cycle} : top4 = ${tri.map(([b, v]) => `b${b}:${v.toFixed(3)}`).join(" ")} | b9=${act[9].toFixed(3)}`);
  }
  c.reinitialiserEnergies();
}
