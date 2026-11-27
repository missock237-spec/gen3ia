/**
 * CLI — Laboratoire de capacités Gen3 (vague post-audit v2.1).
 *
 * Exécute l'évaluation indépendante A/B (jeu d'épreuves rédigé à la main,
 * jamais vu par l'entraînement) contre un cortex réel et ÉCRIT le rapport
 * JSON dans assets/evaluation/ — auditable, versionné, reproductible
 * (audit stratégique §6 : « conserver les résultats bruts, les versions
 * exactes du cerveau évalué, les jeux de tests, les paramètres »).
 *
 * Usage : npx tsx scripts/eval-labo.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { executerLabo } from "@/lib/neural/evaluation/labo-capacites";

function main(): void {
  const rapport = executerLabo();
  const dossier = join(process.cwd(), "assets", "evaluation");
  mkdirSync(dossier, { recursive: true });
  const chemin = join(dossier, "rapport-labo-v2.1.json");
  writeFileSync(chemin, JSON.stringify(rapport, null, 2) + "\n", "utf8");

  console.log("=== LABORATOIRE DE CAPACITÉS GEN3 — mesure A/B ===");
  console.log(`Épreuves : ${rapport.jeu.epreuves} (paires d'apprentissage : ${rapport.jeu.pairesApprentissage})`);
  console.log(`Avant (flou inactif)  : ${(rapport.avant.tauxGlobal * 100).toFixed(1)} %`);
  console.log(`Après (flou actif)    : ${(rapport.apres.tauxGlobal * 100).toFixed(1)} %`);
  console.log(`Épreuves changées     : ${rapport.deltaEpreuves.map((d) => d.id).join(", ") || "aucune"}`);
  for (const famille of rapport.apres.parFamille) {
    const avant = rapport.avant.parFamille.find((f) => f.famille === famille.famille)!;
    console.log(
      `  ${famille.famille.padEnd(22)} avant ${(avant.taux * 100).toFixed(0)} % → après ${(famille.taux * 100).toFixed(0)} %`,
    );
  }
  console.log(`Rapport écrit : ${chemin}`);
}

main();
