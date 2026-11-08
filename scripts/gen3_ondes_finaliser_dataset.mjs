#!/usr/bin/env node
/**
 * FINALISATION DES DATASETS ONDES — validation + content_hash.
 *
 * Rôle : avant un entraînement EOD (it.57) ou un push Hub, garantir que chaque
 * ligne du dataset est valide (champs requis, ids uniques, longueurs) et que
 * son content_hash est recalculé de façon déterministe.
 *
 * Convention de hash : sha256 du canon JSON {id, domain, task_type, language,
 * instruction, input, output}, tronqué à 16 caractères hexadécimaux — même
 * format 16 hex que les datasets v4 existants. Si le générateur de référence
 * (training/gen3-domain-datasets/generateur.py) canonicalise différemment,
 * aligner canonContenu() sur lui AVANT de committer.
 *
 * Usage :
 *   node scripts/gen3_ondes_finaliser_dataset.mjs datasets/multimodal_ondes/train.jsonl
 *   node scripts/gen3_ondes_finaliser_dataset.mjs --check datasets/multimodal_ondes/train.jsonl
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const CHAMPS_REQUIS = [
  "id",
  "domain",
  "task_type",
  "language",
  "instruction",
  "input",
  "output",
];
const MAX_CARACTERES = 12_000;

/** Canon de hash — aligner sur generateur.py si celui-ci diffère. */
function canonContenu(row) {
  return JSON.stringify({
    id: row.id,
    domain: row.domain,
    task_type: row.task_type,
    language: row.language,
    instruction: row.instruction,
    input: row.input,
    output: row.output,
  });
}

function hashContenu(row) {
  return createHash("sha256").update(canonContenu(row), "utf8").digest("hex").slice(0, 16);
}

function main() {
  const arguments_ = process.argv.slice(2);
  const modeVerification = arguments_.includes("--check");
  const chemins = arguments_.filter((a) => a !== "--check");
  if (chemins.length === 0) {
    console.error("Usage : node scripts/gen3_ondes_finaliser_dataset.mjs [--check] fichier.jsonl [...]");
    process.exit(2);
  }

  let totalLignes = 0;
  let totalCorrige = 0;
  const erreurs = [];

  for (const chemin of chemins) {
    const brut = readFileSync(chemin, "utf8");
    const lignes = brut.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    const ids = new Set();
    const sorties = [];

    for (let i = 0; i < lignes.length; i += 1) {
      const numero = i + 1;
      let row;
      try {
        row = JSON.parse(lignes[i]);
      } catch (erreurParse) {
        erreurs.push(`${chemin}:${numero}: JSON invalide (${erreurParse.message})`);
        continue;
      }
      for (const champ of CHAMPS_REQUIS) {
        if (typeof row[champ] !== "string" || row[champ].length === 0) {
          erreurs.push(`${chemin}:${numero}: champ requis « ${champ} » manquant`);
        }
      }
      if (row.instruction && row.output && row.instruction.length + row.output.length > MAX_CARACTERES) {
        erreurs.push(`${chemin}:${numero}: exemple trop long (> ${MAX_CARACTERES} caractères)`);
      }
      if (row.id) {
        if (ids.has(row.id)) erreurs.push(`${chemin}:${numero}: id dupliqué ${row.id}`);
        ids.add(row.id);
      }
      const hash = hashContenu(row);
      if (row.content_hash !== hash) {
        if (!modeVerification) {
          row.content_hash = hash;
          totalCorrige += 1;
        } else {
          erreurs.push(`${chemin}:${numero}: content_hash obsolète (attendu ${hash})`);
        }
      }
      sorties.push(JSON.stringify(row));
      totalLignes += 1;
    }

    if (!modeVerification && erreurs.length === 0) {
      writeFileSync(chemin, sorties.join("\n") + "\n", "utf8");
    }
    console.log(`  ${chemin} — ${lignes.length} ligne(s)${modeVerification ? " [vérification]" : " [finalisé]"}`);
  }

  if (erreurs.length > 0) {
    console.error(`\n${erreurs.length} erreur(s) :`);
    for (const e of erreurs.slice(0, 20)) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`\nDataset ondes valide : ${totalLignes} ligne(s), ${totalCorrige} content_hash recalculé(s).`);
}

main();
