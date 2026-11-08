/**
 * GÉNÉRATEUR DE SHARDS ONDES MULTIMODALES — matérialise une tranche de
 * l'espace adressable de 5 665 359 360 échantillons uniques (lib/neural/
 * generation/memoire-ondes-multimodales.ts) au schéma v4, avec
 * content_hash déterministe.
 *
 * Usage :
 *   tsx scripts/generer-ondes-multimodaux.ts --debut 0 --quantite 10000 \
 *       --sortie datasets/multimodal_ondes/infini-000000.jsonl
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  TAILLE_ESPACE_ONDES_MULTIMODAL,
  lotOndesMultimodale,
} from "../lib/neural/generation/memoire-ondes-multimodales";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, "") ?? "", process.argv[i + 1] ?? "");
}

const debut = Number.parseInt(args.get("debut") ?? "0", 10);
const quantite = Number.parseInt(args.get("quantite") ?? "1000", 10);
const sortie = args.get("sortie") ?? "datasets/multimodal_ondes/infini-000000.jsonl";

if (!Number.isInteger(debut) || debut < 0 || !Number.isInteger(quantite) || quantite <= 0) {
  console.error("Usage : tsx scripts/generer-ondes-multimodaux.ts --debut N --quantite N --sortie fichier.jsonl");
  process.exit(2);
}
if (debut + quantite > TAILLE_ESPACE_ONDES_MULTIMODAL) {
  console.error(`Hors espace : [${debut}, ${debut + quantite}) > ${TAILLE_ESPACE_ONDES_MULTIMODAL}.`);
  process.exit(2);
}

const TASK_TYPES: Record<string, string> = {
  analyse_multimodale: "onde_artifact_analysis",
  generation_image: "prompt_to_photoreal_brief",
  voix_parole: "tts_voice_brief",
  video_realiste: "video_storyboard",
};

const canon = (row: Record<string, unknown>): string =>
  JSON.stringify({
    id: row["id"],
    domain: row["domain"],
    task_type: row["task_type"],
    language: row["language"],
    instruction: row["instruction"],
    input: row["input"],
    output: row["output"],
  });

const lignes: string[] = [];
const lot = lotOndesMultimodale(debut, quantite);
for (let i = 0; i < lot.length; i++) {
  const u = lot[i];
  const index = debut + i;
  const row = {
    id: `onde-inf-${String(index).padStart(10, "0")}`,
    domain: u.domaine,
    task_type: TASK_TYPES[u.domaine] ?? "onde_artifact_analysis",
    language: u.langue,
    instruction: u.instruction,
    input: u.texte,
    output: u.sortie,
    metadata: {
      difficulty: "automatique",
      timestamp: "2026-11-08T00:00:00Z",
      quality_score: 0.9,
      safety_label: "safe",
      license: "proprietary-gen3ia",
      source: "memoire-ondes-multimodales",
      index: index,
    },
  };
  const hash = createHash("sha256").update(canon(row), "utf8").digest("hex").slice(0, 16);
  lignes.push(JSON.stringify({ ...row, content_hash: hash }));
}

writeFileSync(sortie, lignes.join("\n") + "\n", "utf8");
console.log(
  `Shard écrit : ${sortie} — ${quantite} échantillon(s) [${debut}, ${debut + quantite}) sur ${TAILLE_ESPACE_ONDES_MULTIMODAL.toLocaleString("fr-FR")}.`,
);
