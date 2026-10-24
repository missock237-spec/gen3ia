import "server-only";

import { authenticateDeveloper, type DeveloperIdentity } from "@/lib/extensions/developer-keys";
import { enforceRateLimit } from "@/lib/security/rate-limit";

/**
 * PORTE DE L'API PUBLIQUE v1 — gen3ia.
 *
 * MODÈLE ÉCONOMIQUE (décision utilisateur, 2026-10-24) : l'API fonctionne
 * au PORTEFEUILLE (wallet) — PAS d'abonnement. Chaque appel authentifié par
 * une clé développeur `g3a_` est débité au RÉEL (tokens mesurés, tarifs
 * 1,00 €/1M entrant + 1,50 €/1M sortant, XAF à parité fixe) via le cycle
 * réservation → exécution → règlement de lib/billing/api-usage.ts. Le mode
 * libre (GEN3IA_BILLING_ENABLED≠true) reste le défaut fail-safe : aucune
 * déduction ne s'affiche ni ne bloque tant que la facturation n'est pas
 * armée explicitement.
 *
 * Cette porte est le SEUL chemin d'entrée des routes /api/v1/* :
 *  1. AUTHENTIFICATION — authenticateDeveloper (clé `g3a_` + projet lié,
 *     rôle développeur revérifié à chaque appel) ;
 *  2. LIMITATION DE DÉBIT — enforceRateLimit (2 couches : locale + Redis
 *     distribuée), par clé API, par route.
 */

/** Limite de débit par défaut d'un endpoint v1 (par clé, par fenêtre). */
export const LIMITE_V1_DEFAUT = { limit: 60, windowMs: 60_000 } as const;

export interface PorteV1 {
  identite: DeveloperIdentity;
  /** En-têtes de politesse de limitation (X-RateLimit-*, Retry-After). */
  enTetesLimite: Record<string, string>;
}

/**
 * Franchit la porte v1 : authentifie la clé développeur puis applique la
 * limite de débit. Lève une ErrorAccesV1 avec statut explicite en cas de
 * refus (429) — l'authentification laisse remonter ses erreurs propres.
 */
export async function franchirPorteV1(
  request: Request,
  route: string,
  limite: { limit: number; windowMs: number } = LIMITE_V1_DEFAUT,
): Promise<PorteV1> {
  const identite = await authenticateDeveloper(request);

  const empreinteCle = request.headers.get("authorization")?.slice(7, 27).trim() || "sans-empreinte";
  const verdict = await enforceRateLimit(`v1:${route}:${identite.userId}:${empreinteCle}`, {
    limit: limite.limit,
    windowMs: limite.windowMs,
  });
  if (!verdict.allowed) {
    const retryS = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    throw new ErrorAccesV1(
      `Limite de débit atteinte (${limite.limit} appels / ${Math.round(limite.windowMs / 1000)} s). Réessayez dans ${retryS} s.`,
      429,
      { "retry-after": String(retryS) },
    );
  }

  return {
    identite,
    enTetesLimite: {
      "x-ratelimit-limit": String(limite.limit),
      "x-ratelimit-remaining": String(verdict.remaining),
    },
  };
}

/** Erreur d'accès v1 avec statut HTTP explicite et en-têtes optionnels. */
export class ErrorAccesV1 extends Error {
  readonly statut: number;
  readonly enTetes: Record<string, string>;

  constructor(message: string, statut: number, enTetes: Record<string, string> = {}) {
    super(message);
    this.name = "ErrorAccesV1";
    this.statut = statut;
    this.enTetes = enTetes;
  }
}
