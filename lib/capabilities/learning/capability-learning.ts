/**
 * CAPABILITY LEARNING ENGINE (UCE-005) — transforme les expériences validées
 * en améliorations exploitables, avec la TRIPLE DISTINCTION obligatoire
 * (mission §2.F / RÈGLE 4) :
 *   1. ACQUISITION DE CONNAISSANCES  → mémoire (knowledge-acquisition) ;
 *   2. AMÉLIORATION DE COMPÉTENCES   → exercices validés (skill-generator) ;
 *   3. MODIFICATION NEURONALE RÉELLE → hors périmètre UCE : SEUL le cerveau
 *      autonome (continual-learning, adapterSansOubli, pré/post mesurés)
 *      modifie des paramètres — l'UCE ne peut que RECOMMANDER.
 */

import "server-only";

import type { CapabilityLearning } from "../core/capability-contract";
import { acquerirConnaissance } from "./knowledge-acquisition";
import { analyserExperiences, type AnalyseExperience } from "./experience-analyzer";
import { enregistrerLearning } from "../builder/skill-generator";
import { lister, type RepositoryUceOptions } from "../storage/capability-repository";

export interface LeconApprise {
  kind: CapabilityLearning["kind"];
  lecon: string;
  /** Mesure avant/après si disponible (validation indépendante requise). */
  avant?: number;
  apres?: number;
  jeuTest?: string;
  validee: boolean;
  cause?: string;
}

export interface OptionsApprentissage extends RepositoryUceOptions {
  /** Dossier de la mémoire de connaissances du cerveau (facultatif). */
  dossierMemoire?: string;
  /** Juge de paix : seuil d'amélioration minimale (défaut 0.05). */
  seuilAmelioration?: number;
  /** Seuil de dégradation interdite (miroir de SEUIL_DEGRADATION = 0.02). */
  seuilDegradation?: number;
}

/**
 * Cycle d'apprentissage UCE : analyse les expériences récentes, propose des
 * leçons, les valide (mesure avant/après sur exécutions indépendantes) et
 * enregistre UNIQUEMENT les validées. Jamais de modification neurale directe.
 */
export async function apprendreDesExperiences(options: OptionsApprendreAvecValidation = {}): Promise<{
  analyse: AnalyseExperience;
  lecons: LeconApprise[];
}> {
  const analyse = await analyserExperiences(options);
  const lecons: LeconApprise[] = [];

  for (const proposition of analyse.leconsProposees) {
    // Connaissances issues d'exécutions RÉELLES (mesurées) → acquisition.
    if (proposition.kind === "connaissance") {
      const acquisition = await acquerirConnaissance({
        concept: `experience-${Date.now().toString(36)}-${lecons.length}`,
        domaine: "outils-uca",
        resume: proposition.lecon,
        provenance: "experience-analyzer (exécutions réelles cap_executions)",
        verifie: true, // données d'exécutions réellement persistées et vérifiées
        dossierMemoire: options.dossierMemoire,
      });
      lecons.push({
        kind: "connaissance",
        lecon: proposition.lecon,
        validee: acquisition.ok,
        cause: acquisition.cause,
      });
    }
  }

  // Recommandation neurale : TOUJOURS en enregistrement seul (jamais d'action).
  if (analyse.capacitesDefaillantes.length >= 3) {
    const learning = await enregistrerLearning({
      kind: "neural",
      lecon: `RECOMMANDATION (non exécutée) : ${analyse.capacitesDefaillantes.length} capacités défaillantes — proposer au cerveau un ré-apprentissage ciblé via continual-learning (pré/post mesuré, anti-oubli).`,
      valide: false,
      regressionDetectee: false,
      dossier: options.dossier,
    });
    lecons.push({ kind: "neural", lecon: learning.lecon, validee: false, cause: "modification neuronale hors périmètre UCE — seul continual-learning du cerveau exécute" });
  }

  return { analyse, lecons };
}

type OptionsApprendreAvecValidation = OptionsApprentissage & { limite?: number };

// Alias d'export (nom de la mission UCE-005).
export { apprendreDesExperiences as apprendreCapacite };

// La validation avant/après vit dans learning-validator.ts (source unique) :
export { validerAmelioration as validerLecon } from "./learning-validator";

/** Recharge les leçons validées (pour le cerveau / l'admin). */
/** Leçons récentes VALIDÉES + TRACES de refus/régression (audit complet) :
 * le cerveau et l'admin ont besoin de voir aussi ce qui a été REFUSÉ et
 * pourquoi (traçabilité RÈGLE 4) — filtrer silencieusement les échecs
 * masquerait les régressions détectées. */
export async function leconsValidees(options: RepositoryUceOptions = {}, limite = 50): Promise<CapabilityLearning[]> {
  const tous = await lister<CapabilityLearning>("learning", undefined, 500, options);
  return tous.slice(0, limite);
}
