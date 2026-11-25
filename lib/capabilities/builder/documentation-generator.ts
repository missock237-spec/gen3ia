/**
 * DOCUMENTATION GENERATOR (UCE-020) — documentation automatique honnête :
 * uniquement des FAITS déjà mesurés/persistés (carte, compatibilité,
 * benchmark, évaluation). Aucune promesse inventée, aucun « fonctionne
 * parfaitement » non mesuré.
 */

import "server-only";

import type { Capability, CapabilityEvaluation, CapabilityBenchmark } from "../core/capability-contract";
import type { RapportCompatibilite } from "../evaluation/compatibility-engine";

export interface EntreesDocumentation {
  capacite: Capability;
  compatibilite?: RapportCompatibilite;
  evaluation?: CapabilityEvaluation;
  benchmark?: CapabilityBenchmark;
}

/** Génère la fiche Markdown de la capacité (faits mesurés uniquement). */
export function genererDocumentation(entrees: EntreesDocumentation): string {
  const { capacite } = entrees;
  const lignes: string[] = [];

  lignes.push(`# Capacité : ${capacite.card.nom}`);
  lignes.push("");
  lignes.push(capacite.card.description);
  lignes.push("");
  lignes.push(`| Champ | Valeur |`);
  lignes.push(`|---|---|`);
  lignes.push(`| Identifiant | \`${capacite.id}\` |`);
  lignes.push(`| Type / origine | ${capacite.kind} / ${capacite.origin} |`);
  lignes.push(`| Statut UCE | **${capacite.status}** |`);
  lignes.push(`| Source | ${capacite.card.source}${capacite.card.url ? ` ([lien](${capacite.card.url}))` : ""} |`);
  lignes.push(`| Licence | ${capacite.card.licence ?? "non renseignée"} |`);
  lignes.push(`| Version | ${capacite.version ?? "non renseignée"} |`);
  lignes.push(`| Coût | ${capacite.card.cout ? (capacite.card.cout.gratuit ? "gratuit" : "payant") : "non évalué"} |`);
  lignes.push(`| Dernière vérification | ${capacite.card.verifieLe} |`);
  lignes.push("");

  if (capacite.card.fonctionnalites.length > 0) {
    lignes.push("## Fonctionnalités (déclarées par la source)");
    for (const f of capacite.card.fonctionnalites) lignes.push(`- ${f}`);
    lignes.push("");
  }

  if (capacite.card.risques.length > 0) {
    lignes.push("## Risques identifiés");
    for (const r of capacite.card.risques) lignes.push(`- ${r}`);
    lignes.push("");
  }

  if (entrees.compatibilite) {
    lignes.push(`## Compatibilité (mesurée le ${entrees.compatibilite.verifieLe})`);
    lignes.push(`- Verdict : **${entrees.compatibilite.verdict}**`);
    for (const c of entrees.compatibilite.controles) {
      lignes.push(`- ${c.ok ? "✓" : "✗"} ${c.nom} : ${c.detail}${c.bloquant ? " (bloquant)" : ""}`);
    }
    lignes.push("");
  }

  if (entrees.benchmark) {
    lignes.push(`## Benchmark réel (mesuré le ${entrees.benchmark.mesureLe})`);
    lignes.push(`- Scénario : ${entrees.benchmark.scenario}`);
    lignes.push(`- Runs : ${entrees.benchmark.stats.runs} — succès : ${entrees.benchmark.stats.succes} (${Math.round(entrees.benchmark.stats.tauxSucces * 100)}%)`);
    lignes.push(`- Latence : moy. ${entrees.benchmark.stats.latenceMoyenneMs} ms, p95 ${entrees.benchmark.stats.latenceP95Ms} ms, min ${entrees.benchmark.stats.latenceMinMs} ms, max ${entrees.benchmark.stats.latenceMaxMs} ms`);
    if (entrees.benchmark.stats.memoirePicMo !== undefined) lignes.push(`- Mémoire pic mesurée : ${entrees.benchmark.stats.memoirePicMo} Mo`);
    lignes.push(`- Environnement : ${entrees.benchmark.environment.mode}`);
    lignes.push("");
  }

  if (entrees.evaluation) {
    lignes.push(`## Évaluation autonome (${entrees.evaluation.evalueLe})`);
    lignes.push(`- Score agrégé : **${entrees.evaluation.score}/100** — verdict : **${entrees.evaluation.verdict}**`);
    lignes.push(`- Mesure réelle : ${entrees.evaluation.mesureReelle ? "oui" : "NON (règle anti-documentation : score de fonctionnement forcé à 0)"}`);
    for (const r of entrees.evaluation.raisons) lignes.push(`- ${r}`);
    lignes.push("");
  }

  lignes.push("## Avertissement UCE");
  lignes.push("");
  lignes.push(
    capacite.status === "validee"
      ? "Capacité validée : les preuves de vérification ci-dessus ont été rejouées de manière indépendante."
      : "Cette capacité N'EST PAS encore validée : son statut reflète l'état réel du cycle UCE (découverte ≠ autorisation ≠ intégration ≠ validation).",
  );

  return lignes.join("\n");
}

/** Génère le guide d'administration d'une capacité (procédures réelles). */
export function genererGuideAdministration(capacite: Capability, commandes: string[]): string {
  const lignes: string[] = [];
  lignes.push(`# Guide d'administration — ${capacite.card.nom}`);
  lignes.push("");
  lignes.push("## Commandes disponibles");
  for (const c of commandes) lignes.push(`- ${c}`);
  lignes.push("");
  lignes.push("## Procédure de rollback");
  lignes.push("");
  lignes.push("1. Identifier la version active (`cap_versions` statut=active).");
  lignes.push("2. Exécuter `rollbackVersVersion(capaciteId, versionCible)` (versioning/rollback-manager).");
  lignes.push("3. Vérifier l'enregistrement `cap_rollbacks` (résultat succès/échec réel).");
  lignes.push("4. Re-tester depuis le chat principal (exécution via le gateway UCE).");
  lignes.push("");
  lignes.push("## Sécurité");
  lignes.push("");
  lignes.push("- Toute intégration exige un statut « autorisee » posé par un humain (admin).");
  lignes.push("- Les journaux d'exécution sont masqués (secrets-protection) et bornés.");
  return lignes.join("\n");
}
