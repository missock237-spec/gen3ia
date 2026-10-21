import type { NextRequest } from "next/server";

import { requireUser, type AuthenticatedUser } from "./authenticated-request";
import { HttpError } from "./http-errors";

/**
 * AGENT SYSTÈME RÉSERVÉ (demande utilisateur n°5).
 *
 * Le système d'agents IA (création, édition, exécution manuelle, suppression,
 * listing, planifications) n'est PLUS accessible aux utilisateurs standard :
 * seule l'IA de Gen3ia peut l'activer, À LA DEMANDE d'un utilisateur exprimée
 * dans le chat (l'IA décide → active le système → des sous-agents assistent
 * l'agent navigateur). La surface utilisateur est fermée par cette garde ;
 * la surface interne vit dans lib/agents/system-activation.ts +
 * app/api/agents/system/activate (authentification par secret serveur).
 *
 * L'accès ADMIN (custom claim Firebase `admin: true`, même sémantique que
 * lib/security/admin-access.ts → requireAdmin) est CONSERVÉ : l'exploitation
 * doit pouvoir diagnostiquer le système agent sans passer par le chemin
 * interne. Les utilisateurs standard reçoivent un 403 JSON explicite qui
 * explique le nouveau mode d'accès (demander au chat).
 *
 * Routes protégées (toutes sous app/api/agents/**) :
 *   GET/POST /api/agents ; GET/PATCH/DELETE /api/agents/[id] ;
 *   POST /api/agents/[id]/run ; GET /api/agents/[id]/analytics ;
 *   POST /api/agents/run ; POST /api/agents/generate ; POST /api/agents/plan ;
 *   GET/POST /api/agents/schedules ; GET/PATCH/DELETE /api/agents/schedules/[id] ;
 *   POST /api/agents/schedules/[id]/run ; GET /api/agents/schedules/[id]/runs ;
 *   POST /api/agents/schedules/[id]/watch.
 * Routes laissées ouvertes (suivi de mission, non-gestion, scopées
 * propriétaire) : GET /api/agents/runs/[runId] et son flux SSE — elles
 * permettent à l'utilisateur de SUIVRE une mission que le système IA a lancé
 * pour lui (statusUrl/streamUrl) sans piloter le système agent.
 */

/** Message 403 explicite (exigence : « réservé au système IA » clair). */
export const AGENT_SYSTEM_RESERVED_MESSAGE =
  "Le système d'agents IA est réservé au système IA de Gen3ia. Demandez-le dans le chat : l'IA activera les agents pour vous.";

/**
 * Authentifie la requête PUIS exige le privilège agent-système :
 *  - utilisateur standard (même connecté) → HttpError 403 avec le message
 *    « réservé au système IA » (code FORBIDDEN — les routes qui catchent via
 *    errorStatus/errorBody le traduisent proprement en 403 JSON) ;
 *  - admin (`claims.admin === true`) → autorisé (accès d'exploitation conservé) ;
 *  - requête anonyme → 401 (comportement historique de requireUser).
 */
export async function requireAgentSystemAccess(request: NextRequest): Promise<AuthenticatedUser> {
  const user = await requireUser(request);
  if (user.claims?.admin !== true) {
    // 403 explicite : le client distingue « surface réservée au système IA »
    // d'une panne serveur (jamais de 500 générique ni de 401 trompeur).
    throw new HttpError(403, AGENT_SYSTEM_RESERVED_MESSAGE, "FORBIDDEN");
  }
  return user;
}

/**
 * Corps 403 standardisé pour les routes qui ne passent pas par le try/catch
 * errorBody (ex. analytics via protectRoute) : même forme que errorBody —
 * `{ error, code }` — le champ `error` reste une chaîne lisible par l'UI.
 */
export function agentSystemReservedBody(): { error: string; code: "FORBIDDEN" } {
  return { error: AGENT_SYSTEM_RESERVED_MESSAGE, code: "FORBIDDEN" };
}
