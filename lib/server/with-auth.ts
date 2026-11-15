import "server-only";

import type { DecodedIdToken } from "firebase-admin/auth";
import type { NextRequest } from "next/server";

import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { requireAdmin } from "@/lib/security/admin-access";
import { HttpError } from "@/lib/security/http-errors";
import type { AuthenticatedUser } from "@/lib/security/authenticated-request";

/**
 * PRIMITIVE DE GARDE DE ROUTE — withAuth / withAdmin (P0).
 *
 * Complément de la garde obligatoire du middleware (lib/security/api-gate.ts) :
 * ce wrapper re-vérifie l'identité À L'INTÉRIEUR de la route, pour que la
 * route ne dépende JAMAIS du middleware seul (défense en profondeur, demande
 * « une garde avec vérification cryptographique sur chaque route »).
 *
 * Usage canonique d'une nouvelle route :
 *
 *   export const POST = withAuth(async (request, contexte, utilisateur) => {
 *     // utilisateur.uid est VÉRIFIÉ (RS256 Firebase ou cookie HMAC).
 *     // Ne JAMAIS lire un userId du corps de requête : tirer l'identité
 *     // d'ici uniquement.
 *     return Response.json({ ok: true });
 *   });
 *
 *   export const POST = withAdmin(async (request, contexte, admin) => { … });
 *
 * Toute route existante utilisant déjà requireUser / protectRoute /
 * requireAdmin / requireDeveloperAccess etc. possède déjà une garde de route
 * équivalente — la migration vers withAuth est optionnelle et progressive.
 */

/** Réponse 401 uniforme (même contrat que HttpError + errorBody). */
function reponse401(): Response {
  return Response.json(
    {
      success: false,
      error: "Authentification requise : jeton manquant ou session expirée.",
      code: "AUTH_REQUIRED",
    },
    { status: 401 },
  );
}

function reponseHttpErreur(error: HttpError): Response {
  return Response.json(
    { success: false, error: error.message, code: error.code },
    { status: error.status },
  );
}

/**
 * Garde d'authentification utilisateur : vérifie l'identité (Bearer RS256
 * Firebase OU cookie de session HMAC) AVANT d'exécuter le handler, et
 * fournit l'identité vérifiée en troisième argument.
 *
 * Le contexte de route Next (deuxième argument, { params }) traverse tel
 * quel — la signature du handler reste celle d'une route standard.
 */
export function withAuth<Contexte = unknown>(
  handler: (
    request: Request,
    contexte: Contexte,
    utilisateur: DecodedIdToken,
  ) => Promise<Response>,
): (request: Request, contexte: Contexte) => Promise<Response> {
  return async (request: Request, contexte: Contexte): Promise<Response> => {
    let utilisateur: DecodedIdToken;
    try {
      utilisateur = await verifyFirebaseRequest(request);
    } catch {
      return reponse401();
    }
    return handler(request, contexte, utilisateur);
  };
}

/**
 * Garde administrateur : identité vérifiée + custom claim admin (ou rôle
 * plateforme). Les erreurs HttpError de requireAdmin (401/403) deviennent
 * des réponses JSON propres ; toute autre erreur continue de remonter
 * (500 naturel du runtime, logs conservés).
 */
export function withAdmin<Contexte = unknown>(
  handler: (
    request: NextRequest,
    contexte: Contexte,
    admin: AuthenticatedUser,
  ) => Promise<Response>,
): (request: NextRequest, contexte: Contexte) => Promise<Response> {
  return async (request: NextRequest, contexte: Contexte): Promise<Response> => {
    try {
      const admin = await requireAdmin(request);
      return await handler(request, contexte, admin);
    } catch (error) {
      if (error instanceof HttpError) return reponseHttpErreur(error);
      throw error;
    }
  };
}
