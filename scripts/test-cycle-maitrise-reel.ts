/**
 * VALIDATION BOUT-EN-BOUT RÉELLE du régime maîtrise — un cycle authentique
 * contre les hubs RÉELS (Hugging Face) avec entraînement RÉEL (cortex + SNN).
 * Aucune simulation : ce script reproduit exactement ce que fera la prod.
 *
 * Usage : npx tsx scripts/test-cycle-maitrise-reel.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AUTO_APPRENTISSAGE = "1";

import { executerCycleAuto } from "../lib/entrainement-auto/boucle";
import { etatParDefaut, ecrireEtatAuto, lireEtatAuto } from "../lib/entrainement-auto/etat";
import { deleteBrainState } from "../lib/neural/training/persistence";

async function main(): Promise<void> {
  const nbCycles = Number(process.argv[2]?.trim() ?? "1") || 1;
  const dossier = await mkdtemp(join(tmpdir(), "gen3ia-cycle-reel-"));
  const chemin = join(dossier, "etat.json");
  try {
    await ecrireEtatAuto(etatParDefaut(), chemin);

    for (let i = 1; i <= nbCycles; i += 1) {
      console.log(`\n=== CYCLE DE MAÎTRISE RÉEL ${i}/${nbCycles} (HF public) ===`);
      const rapport = await executerCycleAuto({ cheminEtat: chemin });
      if (!rapport) {
        console.log("Cycle refusé (déjà en cours ?)");
        return;
      }
      console.log(`statut      : ${rapport.statut}`);
      console.log(`message     : ${rapport.message}`);
      console.log(`ingérés     : ${rapport.datasetsIngestes.join(", ") || "aucun"}`);
      if (rapport.langage) console.log(`langage     : ${JSON.stringify(rapport.langage)}`);
      if (rapport.intention) console.log(`intention   : ${JSON.stringify(rapport.intention)}`);
      if (rapport.maitrise?.evaluation) console.log(`évaluation  : ${JSON.stringify(rapport.maitrise.evaluation)}`);
      for (const hub of rapport.hubs) {
        if (hub.erreurs.length > 0) {
          console.log(`hub ${hub.provider} :`);
          for (const e of hub.erreurs) console.log(`  ⚠ ${e}`);
        }
      }
    }

    const etat = await lireEtatAuto(chemin);
    console.log("\n--- ÉTAT PERSISTÉ ---");
    console.log(`v=${etat.v} regime=${etat.regime} cycles=${etat.cyclesExecutes} paires=${etat.pairesCumulees} echantillons=${etat.echantillonsCumules}`);
    const maitrises = Object.entries(etat.maitrise.domaines).filter(([, d]) => d.maitriseA);
    console.log(`domaines maîtrisés : ${maitrises.length}/${Object.keys(etat.maitrise.domaines).length}`);
    console.log(`atteinteA : ${etat.maitrise.atteinteA ?? "null (boucle continue)"}`);
  } finally {
    // Ne JAMAIS polluer le cerveau de développement : nettoyage strict.
    deleteBrainState();
    await rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}

void main();
