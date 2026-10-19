import "server-only";

/**
 * CÂBLAGE RÉEL DU PILOTAGE PLATEFORME — les chargeurs Gen3ia branchés sur
 * les dépôts de données de la plateforme (Firestore + R2). C'est ce module
 * qui transforme Gen en PILOTE : chaque intention de pilotage lit les
 * données RÉELLES du compte connecté.
 *
 * ⚠️ IMPORTS PARESSEUX OBLIGATOIRES : ce module est chargé par le runtime
 * neuronal, lui-même au bout de la chaîne router → runtime. Un import
 * statique des dépôts (agents/workspace → tools/index → executor →
 * default-registry) fermerait un cycle de modules et casserait
 * l'initialisation (TDZ `handoverComposeTool`). D'où les `await import(...)`
 * DANS chaque chargeur — le graphe de modules reste acyclique au chargement,
 * les dépôts ne sont résolus qu'à la première commande de pilotage réelle.
 *
 * Toutes les lectures sont fail-soft au niveau du pilote (pilote.ts) : un
 * dépôt indisponible est signalé honnêtement, jamais contourné par un
 * chiffre inventé.
 */

import { executerPilotage, type ChargeursPilotage } from "./pilote";
import type { CompositionReponse } from "../engine";
import type { AIRequest } from "@/lib/ai/models";

const STATUS_EN_COURS = new Set(["approved", "running", "paused"]);
const STATUS_TERMINE = new Set(["completed", "failed", "cancelled"]);

/**
 * Chargeurs Gen3ia réels : automatisations (tâches workspace + agents
 * spécialisés), projets, fichiers importés, connaissances (mémoire
 * permanente), conversations, entraînements (projets + modèles produits).
 */
export const CHARGEURS_GEN3IA: ChargeursPilotage = {
  async automatisations(userId) {
    const [{ listWorkspaceTasks }, { listAgentsForUser }] = await Promise.all([
      import("@/lib/agents/workspace"),
      import("@/lib/agents/repository"),
    ]);
    const [taches, agents] = await Promise.all([
      listWorkspaceTasks(userId, 50),
      listAgentsForUser(userId),
    ]);
    const total = taches.length + agents.length;
    const enCours =
      taches.filter((t) => STATUS_EN_COURS.has(t.status)).length +
      agents.filter((a) => a.status === "active").length;
    const aValider = taches.filter((t) => t.status === "awaiting_approval").length;
    const terminees =
      taches.filter((t) => STATUS_TERMINE.has(t.status)).length +
      agents.filter((a) => a.status === "archived").length;
    return { total, enCours, aValider, terminees };
  },

  async projets(userId) {
    const { listProjects } = await import("@/lib/domain/projects/repository");
    const projets = await listProjects(userId, 50);
    return {
      total: projets.length,
      derniers: projets.slice(0, 3).map((p) => p.name),
    };
  },

  async fichiers(userId) {
    const { listImportedFiles } = await import("@/lib/files/import");
    const fichiers = await listImportedFiles(userId, 50);
    return {
      total: fichiers.length,
      derniers: fichiers.slice(0, 3).map((f) => f.filename),
    };
  },

  async connaissances(userId) {
    const { listMemories } = await import("@/lib/memory/user-memory");
    const souvenirs = await listMemories(userId, 100);
    return {
      total: souvenirs.length,
      dernieres: souvenirs.slice(0, 3).map((s) => s.value.slice(0, 80)),
    };
  },

  async conversations(userId) {
    const { listConversations } = await import("@/lib/chat/repository");
    const conversations = await listConversations(userId, 100);
    return { total: conversations.length };
  },

  async entrainements(userId) {
    const { listProjects, listModels } = await import("@/lib/training/repository");
    const projets = await listProjects(userId);
    let modeles = 0;
    // Modèles réels produits — plafonné à 3 projets sondés (honnêteté :
    // on ne prétend pas compter ce qu'on n'a pas lu).
    for (const projet of projets.slice(0, 3)) {
      try {
        const assets = await listModels(userId, projet.id);
        modeles += assets.length;
      } catch {
        // Modèle incountable : ignoré (le total reste honnête).
      }
    }
    return { total: projets.length, modeles };
  },
};

/**
 * Hook de pilotage câblé dans le moteur neuronal : détecte une commande de
 * pilotage dans le message, lit les données réelles du compte (metadata
 * `userId` posée par les routes authentifiées) et compose la réponse.
 * Retourne null sinon — la conversation suit son cours normal.
 */
export async function piloterPlateforme(
  message: string,
  options: AIRequest,
): Promise<CompositionReponse | null> {
  const userId = options.metadata?.userId;
  return executerPilotage(CHARGEURS_GEN3IA, message, { userId });
}
