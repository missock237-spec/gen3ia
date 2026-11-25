/**
 * AGENT DE DÉVELOPPEMENT DES COMPÉTENCES (Lot 06 — module-agent du core,
 * mission « finalisation opérationnelle »).
 *
 * Tous les N cycles : identification → génération d'exercices → exécution
 * ISOLÉE (ExecuteurSandbox existant — processus enfant, timeout, heap,
 * répertoire détruit) → validation tout-vert OBLIGATOIRE → registre.
 * Seules les compétences VALIDÉES sont enregistrées comme opérationnelles ;
 * les échecs sont tracés avec leur analyse d'erreurs (jamais silencieux).
 */

import type { ModuleAgent } from "../core/types";
import { developperCompetences, executerSandboxProduction, RegistreCompetences } from "../skills/moteur-competences";
import type { MemoireConnaissances } from "../knowledge/memoire-connaissances";

/** Options de l'agent (injectable pour les tests). */
export interface OptionsAgentCompetences {
  memoire: MemoireConnaissances;
  registre?: RegistreCompetences;
  dossierCore: string;
  /** Tous les N cycles (défaut 6 — sandbox = processus enfants, charge). */
  tousLesCycles?: number;
  /** Max de compétences développées par tick (bornes). */
  maxParAppel?: number;
  /** Exécuteur injectable (défaut : sandbox réelle). */
  executeur?: (script: string, donnees?: unknown) => Promise<{ ok: boolean; message: string; dureeMs: number }>;
}

/** Le module-agent "competences". */
export function agentCompetences(options: OptionsAgentCompetences): ModuleAgent {
  const tousLesCycles = Math.max(1, options.tousLesCycles ?? 6);
  const registre = options.registre ?? new RegistreCompetences(options.dossierCore);
  const executeur = options.executeur ?? executerSandboxProduction();
  return {
    id: "competences",
    nom: "Agent de développement des compétences",
    role: "08. SKILL DEVELOPMENT — exercices isolés, validation tout-vert",
    async tick(ctx) {
      const tache = ctx.taches.creer({ module: "competences", cycle: ctx.cycle, type: "competences" });
      if (tache) ctx.taches.demarrer(tache.id);

      if (ctx.cycle % tousLesCycles !== 0) {
        if (tache) ctx.taches.terminer(tache.id, "hors fenêtre (déflexe)");
        return {
          statut: "rien_a_faire",
          message: `Développement de compétences hors fenêtre (tous les ${tousLesCycles} cycles) — registre : ${registre.validees().length} validée(s)/${registre.toutes().length}.`,
          taches: tache ? [tache.id] : [],
        };
      }

      const r = await developperCompetences({
        registre,
        memoire: options.memoire,
        executeur,
        maxParAppel: options.maxParAppel ?? 2,
      });
      const message =
        r.messages.length === 0
          ? `Aucune nouvelle compétence candidate (mémoire : ${options.memoire.taille()} connaissance(s)) — registre : ${registre.validees().length} validée(s).`
          : r.messages.join(" · ");
      if (tache) ctx.taches.terminer(tache.id, `validees=${r.validees} identifiees=${r.identifiees} echecs=${r.echecs}`);
      ctx.emettreEvenement({
        de: "competences",
        sujet: "developpement",
        charge: { identifiees: r.identifiees, validees: r.validees, echecs: r.echecs },
      });
      return {
        statut: r.echecs > 0 ? "echec" : "succes",
        message: message.slice(0, 400),
        taches: tache ? [tache.id] : [],
        details: { identifiees: r.identifiees, validees: r.validees, echecs: r.echecs },
      };
    },
  };
}
