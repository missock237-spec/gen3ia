import { NextRequest } from "next/server";

import {
  verifyFirebaseToken,
} from "@/lib/firebase/auth-server";

import {
  readSessionCookie,
} from "@/lib/server/session-cookie";

import {
  validateRequest,
} from "./request-security";

import {
  HttpError,
  unauthorized,
} from "./http-errors";

import {
  enforceRateLimit,
} from "./rate-limit";

/**
 * Quota GLOBAL par utilisateur (exigence 10-10 : 100 requêtes/minute/
 * utilisateur) appliqué AU CHEMIN D'AUTHENTIFICATION CENTRAL : toute route
 * API qui passe par requireUser hérite de la limite, sans modification
 * locale. Deux couches (locale instantanée + compteur Redis partagé entre
 * instances serverless) ; panne Redis → repli local (jamais de blocage pour
 * une panne d'infra). Fenêtre glissante fixe 60 s, clé `api-quota:{uid}`.
 * Les routes qui posent leurs propres limites métier (chat 10/min,
 * création d'orgs…) restent PLUS strictes que ce socle.
 */
export const GLOBAL_USER_RATE_LIMIT = { limit: 100, windowMs: 60_000 } as const;

async function enforceGlobalUserQuota(uid: string): Promise<void> {
  try {
    const decision = await enforceRateLimit(`api-quota:${uid}`, GLOBAL_USER_RATE_LIMIT);
    if (!decision.allowed) {
      const secondes = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      throw new HttpError(
        429,
        `Trop de requêtes : vous avez atteint ${GLOBAL_USER_RATE_LIMIT.limit} requêtes par minute. Réessayez dans ${secondes} s.`,
        "RATE_LIMITED",
      );
    }
  } catch (error) {
    // La limite ATTEINTE lève un HttpError 429 : il se propage tel quel.
    if (error instanceof HttpError) throw error;
    // Une panne du limiteur lui-même ne doit JAMAIS bloquer le trafic
    // légitime : échec ouvert (repli local déjà appliqué par enforceRateLimit).
  }
}

export interface AuthenticatedUser {
  uid: string;

  email?: string;

  name?: string;

  claims?: Record<
    string,
    unknown
  >;
}

/**
 * Authentifie une requete API par l'un des deux moyens, dans cet ordre :
 *
 * 1. Bearer token Firebase ID (chemin historique, signature RS256 verifiee
 *    contre les certificats Google).
 * 2. Cookie de session signe `gen3ia_session` (HMAC-SHA256 serveur), pose
 *    par POST /api/auth/session. Ce fallback est indispensable : sur certains
 *    navigateurs mobiles / webviews, l'etat Firebase client (IndexedDB)
 *    disparait et le SDK ne peut plus produire d'ID token alors que
 *    l'utilisateur est authentifie. Sans lui, toutes les fonctionnalites
 *    deviendraient inaccessibles apres la connexion.
 *
 * Le cookie ne transporte pas de custom claims (role admin etc.) : les
 * privileges eleves restent reserve au chemin Bearer Firebase.
 */
export async function requireUser(
  request: NextRequest,
): Promise<AuthenticatedUser> {
  validateRequest(request);

  const authorization =
    request.headers.get(
      "authorization"
    );

  if (
    authorization &&
    authorization
      .toLowerCase()
      .startsWith("bearer ")
  ) {
    try {
      const token =
        await verifyFirebaseToken(
          authorization
        );

      if (token) {
        await enforceGlobalUserQuota(token.uid);
        return {
          uid:
            token.uid,

          email:
            token.email,

          name:
            token.name,

          claims:
            token as unknown as Record<
              string,
              unknown
            >,
        };
      }
    } catch (error) {
      // Le quota global ATTEINT (HttpError 429) doit se propager TEL QUEL :
      // l'utilisateur identifié a dépassé 100 req/min — retomber sur la
      // session ou un 401 masquerait la vraie cause.
      if (error instanceof HttpError) throw error;
      // Token invalide ou expire : on tente le cookie de session avant
      // d'echouer, pour survivre a la perte d'etat Firebase client.
    }
  }

  const session =
    readSessionCookie(
      request.headers.get("cookie")
    );

  if (session) {
    await enforceGlobalUserQuota(session.uid);
    return {
      uid: session.uid,

      email: session.email ?? undefined,

      name: session.name ?? undefined,

      claims: {
        provider: session.provider,
        source: "session-cookie",
      },
    };
  }

  throw unauthorized();
}
