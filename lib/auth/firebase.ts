import type { DecodedIdToken } from "firebase-admin/auth";

import {
  verifyFirebaseAuth,
} from "@/lib/firebase/auth-server";

/**
 * Verifies the Firebase ID token (or session-cookie fallback) carried by an
 * incoming Request.
 *
 * Route handlers receive a standard `Request`; this helper delegates to the
 * dual-mode verifier : Bearer Firebase ID token, ou cookie de session signe
 * `gen3ia_session` quand l'etat Firebase client a ete perdu (webviews
 * mobiles). Sans le fallback cookie, l'utilisateur authentifie se verrait
 * refuser toutes les fonctionnalites de la plateforme.
 *
 * Nommee `verifyFirebaseRequest` (plutot que `verifyFirebaseToken`) pour la
 * distinguer sans ambiguite de `verifyFirebaseToken` exportee par
 * `@/lib/firebase/auth-server`, qui prend directement une valeur d'en-tete
 * `Authorization` (string) et ne supporte pas le fallback cookie.
 */
export async function verifyFirebaseRequest(
  request: Request,
): Promise<DecodedIdToken> {
  return verifyFirebaseAuth(request);
}
