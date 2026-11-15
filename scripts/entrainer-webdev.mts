/**
 * ENTRAÎNEMENT WEB-DEV GEN3IA — exécution réelle à l'échelle du corpus.
 *
 * Lance entrainerDeveloppementWeb sur le dataset du pack gen3-webdev-pack
 * (2,5 M lignes bilingues : création de SaaS, sites web, projets de
 * développement) avec les réglages équilibrés :
 *   - 2 000 échantillons SNN web-dev + ~2 550 négatifs (17 autres domaines,
 *     150/domaine) — RÉGIME ÉQUILIBRÉ où la plasticité supervisée apprend
 *     (cf. trainer-domaines.test.ts) — discrimination mesurée sur un jeu
 *     tenu à l'écart ;
 *   - 60 000 paires conversationnelles pour le cortex langagier, rétention
 *     mesurée sur 150 paires apprises.
 *
 * Usage (depuis la racine du dépôt) :
 *   NODE_OPTIONS='--conditions react-server' npx tsx scripts/entrainer-webdev.mts
 *   (ou : npm run train:webdev)
 *
 * Le rapport honnête est écrit dans var/neural/webdev/rapport.json.
 */
import { entrainerDeveloppementWeb, lireRapportWebdev } from "@/lib/neural/training/entrainement-webdev";

const rapport = await entrainerDeveloppementWeb({
  plafondSnn: 2_000,
  plafondCortex: 60_000,
  epoques: 3,
});

console.log("=== RAPPORT ENTRAÎNEMENT WEB-DEV ===");
console.log(JSON.stringify(rapport, null, 2));

const lu = await lireRapportWebdev();
console.log(`\nRapport persisté : ${lu ? "var/neural/webdev/rapport.json (" + lu.statut + ")" : "ABSENT"}`);
