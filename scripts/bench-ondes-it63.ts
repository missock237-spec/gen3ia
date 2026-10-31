/**
 * BENCHMARK it.63 — coût réel d'une session EOD à grande échelle.
 * Mesure le débit (échantillons/s) sur un lot représentatif afin de
 * dimensionner la campagne « 1M+ données par domaine » (19 domaines).
 * Aucune métrique inventée : le débit est mesuré, l'extrapolation est
 * explicite.
 */
import { CortexColumnnaire, CORTEX_CONFIG_DEFAUTS } from "../lib/neural/core/v2/cortex-columnnaire";
import { ChampCorticalGen3 } from "../lib/neural/core/v2/champ-cortical";
import { entrainerDomainesParOndes, type ExempleOnde } from "../lib/neural/training/entrainement-ondes";

/** Phrase représentative (~25 tokens) du gabarit de campagne. */
function phrase(i: number, domaine: string): string {
  const sujets = ["gen3", "l'opérateur", "le système", "l'agent autonome", "le module de domaine"];
  const verbes = ["analyse", "exécute", "consolide", "vérifie", "orchestre", "évalue"];
  const complements = [
    "les données du domaine avec précision",
    "la tâche demandée selon la charte de vocation",
    "le flux d'ondes corticales en résonance",
    "le rapport honnête de la session",
    "les outils réels servis par l'API",
  ];
  const s = sujets[i % sujets.length];
  const v = verbes[(i >> 3) % verbes.length];
  const c = complements[(i >> 6) % complements.length];
  return `${domaine} ${String(i)} : ${s} ${v} ${c}, mesure ${i * 7} du protocole EOD.`;
}

function main() {
  const NB_ECH = 6000; // 2 domaines × 3000 échantillons
  const exemples: ExempleOnde[] = [];
  for (let i = 0; i < NB_ECH / 2; i++) {
    exemples.push({ texte: phrase(i, "recherche web"), domaine: "recherche-web" });
    exemples.push({ texte: phrase(i, "cybersécurité"), domaine: "cybersecurite" });
  }
  const cortex = new CortexColumnnaire(CORTEX_CONFIG_DEFAUTS);
  const champ = new ChampCorticalGen3();
  const t0 = Date.now();
  const rapport = entrainerDomainesParOndes(cortex, champ, exemples, {
    cyclesParEchantillon: 3,
    lrBoost: 0.15,
    maxParDomaine: 3000,
  });
  const ms = Date.now() - t0;
  const parEch = ms / rapport.totalEchantillons;
  console.log(`Échantillons traités : ${rapport.totalEchantillons}`);
  console.log(`Durée mesurée : ${ms} ms → ${parEch.toFixed(3)} ms/échantillon (${(1000 / parEch).toFixed(0)} éch./s)`);
  for (const r of rapport.domaines) {
    console.log(`  ${r.domaine.padEnd(20)} éch=${r.echantillons} réson=${r.resonanceMoyenne.toFixed(4)} renforts=${r.renforts} annul=${r.annulations}`);
  }
  const meta = rapport.metabolisme;
  console.log(`Métabolisme : évaluées=${meta.evaluees.toLocaleString("fr-FR")} reposées=${meta.reposes.toLocaleString("fr-FR")} transmissions=${meta.transmissions.toLocaleString("fr-FR")} ms=${meta.ms.toFixed(1)}`);
  // Extrapolation campagne complète : 19 domaines × 1 000 000.
  const cible = 19_000_000;
  const heures = (cible * parEch) / 3_600_000;
  console.log(`Extrapolation 19M échantillons : ${heures.toFixed(2)} h (${(heures * 60).toFixed(0)} min)`);
}

main();
