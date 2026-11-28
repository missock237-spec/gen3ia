/**
 * GÉNÉRATEUR DE RAPPORTS POST-TRAVAIL — mission « réaliser des rapports
 * après le travail effectué ».
 *
 * Après chaque tâche autonome, Gen3 rédige un rapport markdown HONNÊTE et
 * déterministe : objectif, démarche (étapes avec primitives et résultats),
 * résultats vérifiés, incidents + récupérations, métriques, limites. Le
 * rapport est commis dans la mémoire d'ondes du compte (les travaux vécus
 * enrichissent la compréhension future) et journalisé côté plateforme.
 */

import type { ExecutionTache } from "./execution-autonome";
import { extraireConcepts, NoeudOndesUnifie } from "./noeud-ondes-unifie";

export interface RapportTache {
  titre: string;
  markdown: string;
  metriques: ExecutionTache["metriques"];
  reussie: boolean;
  concepts: string[];
}

/** Titre honnête : succès ou échec explicite — jamais de victoire inventée. */
function titre(execution: ExecutionTache): string {
  return execution.reussie ? `Rapport de tâche — ${execution.objectif.slice(0, 60)} (succès)` : `Rapport de tâche — ${execution.objectif.slice(0, 60)} (échec honnête)`;
}

/** Démarche : chaque étape, sa primitive, son résultat, ses tentatives. */
function demarche(execution: ExecutionTache): string {
  return execution.etapes
    .map((etape) => {
      const statut = etape.ok ? "✓" : "×";
      const tentatives = etape.tentative > 1 ? ` (${etape.tentative} tentatives)` : "";
      const resultat = etape.resultat ? ` → \`${etape.resultat}\`` : ` → ${etape.detail}`;
      return `- ${statut} Étape ${etape.index + 1} [\`${etape.primitiveId ?? "sans-primitive"}\`] : ${etape.enonce}${tentatives}${resultat}`;
    })
    .join("\n");
}

/** Incidents et récupérations : tout ce qui a mal tourné et comment. */
function incidents(execution: ExecutionTache): string {
  if (execution.incidents.length === 0) return "- Aucun incident : exécution propre du premier coup.";
  return execution.incidents
    .map((incident) => {
      const statut = incident.recuperee ? "✓ récupéré" : "× non récupéré";
      return `- ${statut} Étape ${incident.etape + 1} : ${incident.description} — récupération : ${incident.recuperation}`;
    })
    .join("\n");
}

/**
 * Rédige le rapport post-travail (markdown déterministe) et commit les
 * ondes du rapport dans la mémoire du compte (fusion mémoire+travail).
 */
export function redigerRapportTache(execution: ExecutionTache, noeud?: NoeudOndesUnifie): RapportTache {
  const lignes: string[] = [];
  lignes.push(`# ${titre(execution)}`);
  lignes.push("");
  lignes.push(`## Objectif`);
  lignes.push(execution.objectif);
  lignes.push("");
  lignes.push(`## Démarche exécutée`);
  lignes.push(demarche(execution));
  lignes.push("");
  lignes.push(`## Résultat`);
  lignes.push(
    execution.reussie && execution.resultatFinal
      ? `Résultat vérifié : **${execution.resultatFinal}**`
      : `Aucun résultat vérifiable — repli honnête : ${execution.repliHonnete ?? "non précisé"}`,
  );
  lignes.push("");
  lignes.push(`## Incidents & récupérations`);
  lignes.push(incidents(execution));
  lignes.push("");
  lignes.push(`## Métriques`);
  lignes.push(
    `- étapes : ${execution.metriques.etapesTotales} · tentatives : ${execution.metriques.tentatives} · incidents : ${execution.metriques.incidents} (récupérés : ${execution.metriques.incidentsRecuperes})`,
  );
  lignes.push("");
  lignes.push(`## Limites`);
  lignes.push(
    execution.reussie
      ? "- Résultat obtenu par les primitives locales composées ; vérification déterministe à chaque étape."
      : "- Les primitives locales ne couvrent pas encore cet énoncé — l'analogie du compte est proposée comme piste, pas comme résultat.",
  );

  const markdown = lignes.join("\n");
  const concepts = extraireConcepts(execution.objectif);
  if (noeud) {
    noeud.memoriser({
      modalite: "texte",
      concepts,
      texte: `RAPPORT ${execution.reussie ? "succès" : "échec"} : ${execution.objectif.slice(0, 200)} → ${execution.resultatFinal ?? (execution.repliHonnete ?? "").slice(0, 120)}`,
    });
  }
  return {
    titre: titre(execution),
    markdown,
    metriques: execution.metriques,
    reussie: execution.reussie,
    concepts,
  };
}
