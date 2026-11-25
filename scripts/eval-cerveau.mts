/**
 * CLI DU LABORATOIRE D'ÉVALUATION (LOT 7) — npm run brain:eval
 * Exécute le banc indépendant des six capacités et imprime le rapport.
 */
import { evaluerCerveau } from "../lib/neural/evaluation/laboratoire-capacites";

const rapport = await evaluerCerveau("var/neural/evaluation", "var/neural/evaluation/memoire-bench");

console.log("=== LABORATOIRE D'ÉVALUATION DU CERVEAU GEN3IA ===");
console.log(`Date : ${rapport.dateIso} · durée totale : ${rapport.dureeTotaleMs} ms`);
for (const c of rapport.capacites) {
  console.log(`\n■ ${c.capacite} — score ${c.score} (${c.dureeMs} ms)`);
  for (const e of c.epreuves) console.log(`   ${e.reussie ? "✓" : "✗"} ${e.nom} — ${e.mesure}`);
}
console.log(`\nSCORE GLOBAL : ${rapport.scoreGlobal}`);
if (rapport.optimisations.length > 0) {
  console.log("\nOPTIMISATIONS DÉRIVÉES DES MESURES :");
  for (const o of rapport.optimisations) console.log(`  · [${o.cible}] ${o.constat} → ${o.suggestion}`);
}
console.log("\nRapport persisté : var/neural/evaluation/dernier-rapport.json");
