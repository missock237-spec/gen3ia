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
  unauthorized,
} from "./http-errors";

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
    } catch {
      // Token invalide ou expire : on tente le cookie de session avant
      // d'echouer, pour survivre a la perte d'etat Firebase client.
    }
  }

  const session =
    readSessionCookie(
      request.headers.get("cookie")
    );

  if (session) {
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
