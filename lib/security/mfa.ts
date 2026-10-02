import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { readSessionCookie } from "@/lib/server/session-cookie";
import { forbidden } from "@/lib/security/http-errors";
import { requireUser } from "@/lib/security/authenticated-request";

/**
 * MFA — sécurité entreprise (Task 63, priorité #6).
 *
 * PRÉREQUIS PRODUIT : l'inscription MFA (TOTP) exige Firebase Authentication
 * avec Identity Platform (activation console + facturation GCP — voir
 * docs/enterprise-security.md). TOUTEFOIS, la couche serveur ci-dessous est
 * fonctionnelle DÈS MAINTENANT : elle détecte le second facteur dans les
 * jetons vérifiés, porte la politique « MFA requis » par compte et l'applique
 * sur les surfaces sensibles. Sans Identity Platform, aucun utilisateur ne
 * peut s'inscrire, donc le flag reste OFF et le comportement est inchangé.
 *
 * DÉTECTION : un ID token Firebase émis APRÈS un second facteur porte
 * `firebase.sign_in_second_factor` (ex. "totp") + `second_factor_identifiers`.
 * Le cookie de session (lib/server/session-cookie.ts) recopie ce flag au
 * POST /api/auth/session — les sessions cookie héritent de la preuve MFA.
 *
 * POLITIQUE : `users/{uid}.mfaRequired` (défaut false). Un compte marqué
 * DOIT présenter un second facteur pour les surfaces sensibles — assertion
 * centralisée `assertStrongAuth` (même convention que requireAdmin). Le
 * marquage est réservé à l'admin (route dédiée + audit).
 */

export interface MfaStatus {
  /** Un second facteur a été VÉRIFIÉ pour établir cette session. */
  secondFactorUsed: boolean;
  /** Type du second facteur utilisé (ex. "totp") — null si aucun. */
  secondFactorType: string | null;
}

interface FirebaseTokenFragment {
  uid: string;
  firebase?: {
    sign_in_provider?: string;
    sign_in_second_factor?: string;
    second_factor_identifiers?: unknown;
  };
}

/** Extrait le statut MFA d'un token/claims vérifié (Bearer OU cookie). */
export function mfaStatusFromToken(token: FirebaseTokenFragment | {
  uid: string;
  claims?: Record<string, unknown>;
}): MfaStatus {
  const firebase = (token as FirebaseTokenFragment).firebase
    ?? ((token as { claims?: Record<string, unknown> }).claims?.firebase as
      | FirebaseTokenFragment["firebase"]
      | undefined);
  const secondFactorType = firebase?.sign_in_second_factor ?? null;
  return {
    secondFactorUsed: typeof secondFactorType === "string" && secondFactorType.length > 0,
    secondFactorType,
  };
}

/** Extrait le statut MFA d'un payload de cookie de session signé. */
export function mfaStatusFromSessionCookie(cookieHeader: string | null | undefined): MfaStatus {
  const session = readSessionCookie(cookieHeader);
  return {
    secondFactorUsed: session?.mfa === true,
    secondFactorType: null,
  };
}

/** Ce compte exige-t-il un second facteur ? (politique par compte) */
export async function isMfaRequiredForUser(uid: string): Promise<boolean> {
  try {
    const snap = await adminDb.collection("users").doc(uid).get();
    return snap.exists && (snap.data() ?? {}).mfaRequired === true;
  } catch {
    // Panne Firestore : ne JAMAIS verrouiller un utilisateur par accident —
    // la politique dégrade en « non requis » (fail-open documenté).
    return false;
  }
}

/**
 * Marque (ou démarque) le compte comme MFA requis. Réservé à l'admin.
 * Retourne l'état précédent pour l'audit.
 */
export async function setMfaRequirement(
  uid: string,
  required: boolean,
): Promise<{ previous: boolean }> {
  const ref = adminDb.collection("users").doc(uid);
  const previous = await isMfaRequiredForUser(uid);
  await ref.set(
    {
      mfaRequired: required,
      mfaRequiredUpdatedAt: new Date(),
    },
    { merge: true },
  );
  return { previous };
}

/**
 * Assertion d'authentification FORTE pour les surfaces sensibles :
 *  - authentifie la requête (Bearer Firebase ou cookie de session) ;
 *  - si le compte est marqué « MFA requis », exige la preuve d'un second
 *    facteur vérifié — sinon 403 avec un code exploitable côté client.
 *
 * À appeler APRÈS requireUser/requireAdmin sur les routes sensibles
 * (rechargements wallet, changements de sécurité, actions admin critiques).
 */
export async function assertStrongAuth(request: Request): Promise<{ uid: string }> {
  const user = await requireUser(request as never);

  // 1) Statut selon la source d'authentification réellement utilisée.
  const authHeader = request.headers.get("authorization");
  let status: MfaStatus;
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    status = mfaStatusFromToken(user);
  } else {
    status = mfaStatusFromSessionCookie(request.headers.get("cookie"));
  }

  // 2) Politique par compte.
  const required = await isMfaRequiredForUser(user.uid);
  if (required && !status.secondFactorUsed) {
    throw forbidden("Second facteur requis pour cette action (MFA). Enregistrez un facteur TOTP dans vos paramètres de sécurité, puis reconnectez-vous.");
  }

  return { uid: user.uid };
}
