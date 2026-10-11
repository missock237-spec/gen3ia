import { analysteFinanceTemplate } from "./analyste-finance";
import { marketingContenuTemplate } from "./marketing-contenu";
import { prospectionVenteTemplate } from "./prospection-vente";
import { screeningRhTemplate } from "./screening-rh";
import { supportClientTemplate } from "./support-client";
import { veilleJuridiqueTemplate } from "./veille-juridique";
import type { AgentTemplate } from "./types";

/**
 * TEMPLATES D'AGENTS SECTORIELS — registre (Task 132).
 *
 * MODULE PUR (données seulement, aucune dépendance serveur) : importable
 * par l'UI (grille « Templates sectoriels » de la marketplace) et par le
 * serveur. L'instancialisation vit dans ./instantiate.ts (serveur).
 *
 * NOTE RUNTIME : les allowlists `outilsAutorises` sont portées dans
 * agent.tools à l'instanciation (déclaratif, visible dans le Studio). La
 * politique d'exécution effective suit le contrat plateforme
 * (resolveAllowedTools — Task 107 : l'agent accède au catalogue complet du
 * registre selon son niveau de sécurité).
 */

/** Les six templates sectoriels, prêts à l'emploi. */
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  supportClientTemplate,
  marketingContenuTemplate,
  prospectionVenteTemplate,
  screeningRhTemplate,
  veilleJuridiqueTemplate,
  analysteFinanceTemplate,
];

/** Recherche un template par son identifiant slug (undefined si inconnu). */
export function getTemplate(id: string): AgentTemplate | undefined {
  const clean = id?.trim();
  if (!clean) return undefined;
  return AGENT_TEMPLATES.find((template) => template.id === clean);
}

export type { AgentTemplate };
