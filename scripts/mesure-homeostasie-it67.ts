/**
 * MESURE (it.67) — reproduction de l'anomalie it.65 §3.4 (cascade CSR
 * saturante) et preuve du correctif (déduplication + homéostasie).
 * Petit cortex, poids saturés à 1.0, re-stimulation répétée du même motif.
 */
import { CortexColumnnaire } from "../gen3ia/lib/neural/core/v2/cortex-columnnaire";

function scenario(normalisation: boolean, cycles: number): {
  maxSpikes: number;
  maxAttente: number;
  sommeFinale: number;
  normalisations: number;
  cyclesAvalanche: number;
} {
  const cortex = new CortexColumnnaire({
    colonnes: 4096,
    voisins: 12,
    bandesLecture: 8,
    seuil: 1.0,
    decroissance: 0.1,
    plasticiteFenetre: 2.0,
    lrBoost: 0.15,
    seed: 42,
    bandes: 32,
    normalisationHomeostatique: normalisation,
    budgetPoidsSortants: 6.0,
  });
  // Poids INITIAUX (0.1-0.5) — la saturation se construit par plasticité
  // (re-consolidation répétée du même motif, comme it.65 §3.4).
  let maxSpikes = 0;
  let maxAttente = 0;
  let normalisations = 0;
  let cyclesAvalanche = 0;
  for (let t = 1; t <= cycles; t++) {
    const spikes = cortex.pas([[5, 1.5], [6, 1.5], [7, 1.5]], t);
    maxSpikes = Math.max(maxSpikes, spikes.length);
    maxAttente = Math.max(maxAttente, cortex.tailleListeAttente);
    normalisations += cortex.metabolismeDernierPas.normalisations;
    if (spikes.length > 4096 * 0.25) cyclesAvalanche += 1;
  }
  let sommeFinale = 0;
  for (let k = 0; k < 12; k++) sommeFinale += cortex.csrPoids[5 * 12 + k];
  return { maxSpikes, maxAttente, sommeFinale, normalisations, cyclesAvalanche };
}

const CYCLES = 300;
const off = scenario(false, CYCLES);
const on = scenario(true, CYCLES);
console.log(`SANS homéostasie (${CYCLES} cycles, anomalie it.65) :`, off);
console.log(`AVEC homéostasie (${CYCLES} cycles, correctif it.67) :`, on);
console.log("plafond attente (colonnes) : 4096");
