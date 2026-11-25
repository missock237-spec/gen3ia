/** CLI — exécute l'expérience sémantique réelle et persiste le rapport (mission TERMINAL COMPLETION). */
import { executerExperienceSemantique } from "../lib/neural/training/experience-semantique";
import { mkdirSync, writeFileSync } from "node:fs";
const r = await executerExperienceSemantique({ seed: 42, epoques: 8, versionner: true });
mkdirSync("var/neural/versions/rapports", { recursive: true });
writeFileSync("var/neural/versions/rapports/experience-semantique-seed42.json", JSON.stringify(r, null, 1), "utf8");
console.log(JSON.stringify({ seed: r.seed, dataset: r.dataset.total, train: r.dataset.train, val: r.dataset.validation, test: r.dataset.test, labels: r.dataset.labels, hash: r.hashSplits, baselineTest: r.baselineTest, accuracies: r.accuracies, generalisation: r.generalisation, epoques: r.epoques, dureeMs: r.dureeMs, ramMo: r.ram, version: r.version?.version ?? null, infoVersion: r.version?.info ?? null }, null, 1));
