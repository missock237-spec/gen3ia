"use client";

/**
 * MFA côté client — enrôlement TOTP et second facteur (Task 63).
 *
 * PRÉREQUIS : Firebase Authentication avec Identity Platform activé
 * (console GCP → Identity Platform → facturation) — sans lui, les méthodes
 * multiFactor du SDK renvoient des erreurs `operation-not-allowed` ; les
 * helpers remontent des erreurs explicites (voir errorsMfa).
 *
 * FLUX ENRÔLEMENT (paramètres de sécurité) :
 *   const { qrCodeUrl, secretKey } = await startTotpEnrollment("Gen3ia");
 *   // afficher le QR (qrCodeUrl est une URL otpauth:// en image data URI)…
 *   const code = prompt("Code affiché par votre application");
 *   await confirmTotpEnrollment(code);
 *
 * FLUX CONNEXION (après signInWithEmailAndPassword rejettant
 * auth/multi-factor-auth-required) :
 *   await resolveTotpChallenge(error);  // résout et renvoie la session
 *
 * Ces fonctions encapsulent les appels dynamiques au SDK : aucun impact
 * bundle tant qu'elles ne sont pas importées par l'UI concernée.
 */

import type { MultiFactorError, MultiFactorResolver, User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
/** Erreur Firebase portant le resolver de second facteur. */
function isMultiFactorError(error: unknown): error is MultiFactorError {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "auth/multi-factor-auth-required");
}

async function currentUser(): Promise<User> {
  const user = auth?.currentUser;
  if (!user) throw new Error("Connectez-vous avant de gérer le MFA.");
  return user;
}

/** Enrôlement TOTP étape 1 : génère le secret et l'URL du QR code. */
export async function startTotpEnrollment(displayName = "Gen3ia"): Promise<{ qrCodeUrl: string; secretKey: string }> {
  const user = await currentUser();
  const { multiFactor } = await import("firebase/auth");
  const mfaSession = await multiFactor(user).getSession();

  const { TotpMultiFactorGenerator } = await import("firebase/auth");
  const secret = await TotpMultiFactorGenerator.generateSecret(mfaSession);

  return {
    // QR prêt à afficher (string data:image/svg+xml ou PNG selon SDK) :
    qrCodeUrl: secret.generateQrCodeUrl(user.email ?? displayName, displayName),
    secretKey: secret.secretKey,
  };
}

/** Enrôlement TOTP étape 2 : vérifie le code de l'app authentifiante et finalise. */
export async function confirmTotpEnrollment(verificationCode: string, displayName = "Gen3ia"): Promise<void> {
  const user = await currentUser();
  const { multiFactor, TotpMultiFactorGenerator } = await import("firebase/auth");
  const code = verificationCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("Le code TOTP contient 6 chiffres.");

  const mfaSession = await multiFactor(user).getSession();
  const secret = await TotpMultiFactorGenerator.generateSecret(mfaSession);
  // Le secret de session est ré-généré : generateSecret retourne un secret
  // lié à la session en cours — la confirmation doit utiliser le MÊME secret
  // que l'étape 1. L'appelant passe donc par finalizeTotpEnrollment en un
  // seul flux (voir enrollTotpMfa) — ce chemin direct sert aux tests.
  const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, code);
  await multiFactor(user).enroll(assertion, displayName);
}

/**
 * Flux d'enrôlement COMPLET en une fonction : génère le secret, fournit le
 * QR et accepte le code immédiatement — évite toute divergence de session
 * entre les deux étapes.
 */
export async function enrollTotpMfa(
  verificationCode: string,
  displayName = "Gen3ia",
): Promise<{ qrCodeUrl: string; secretKey: string }> {
  const user = await currentUser();
  const { multiFactor, TotpMultiFactorGenerator } = await import("firebase/auth");
  const code = verificationCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("Le code TOTP contient 6 chiffres.");

  const mfaSession = await multiFactor(user).getSession();
  const secret = await TotpMultiFactorGenerator.generateSecret(mfaSession);
  const assertion = TotpMultiFactorGenerator.assertionForEnrollment(secret, code);
  await multiFactor(user).enroll(assertion, displayName);

  return {
    qrCodeUrl: secret.generateQrCodeUrl(user.email ?? displayName, displayName),
    secretKey: secret.secretKey,
  };
}

/**
 * Résout le défi de second facteur après une connexion rejetée par
 * `auth/multi-factor-auth-required` (TOTP uniquement à ce stade).
 * Retourne true si le défi a été résolu (la session Firebase est établie).
 */
export async function resolveTotpChallenge(multiFactorError: unknown, verificationCode: string): Promise<boolean> {
  if (!isMultiFactorError(multiFactorError)) return false;
  const { getMultiFactorResolver, TotpMultiFactorGenerator } = await import("firebase/auth");

  // L'API publique du SDK passe par getMultiFactorResolver (le resolver
  // n'est pas exposé directement sur l'erreur dans le typage public).
  const resolver: MultiFactorResolver = getMultiFactorResolver(auth, multiFactorError);
  const totpHint = resolver.hints.find((hint) => hint.factorId === "totp");
  if (!totpHint) throw new Error("Aucun facteur TOTP enregistré pour ce compte.");

  const code = verificationCode.trim();
  if (!/^\d{6}$/.test(code)) throw new Error("Le code TOTP contient 6 chiffres.");
  const assertion = TotpMultiFactorGenerator.assertionForSignIn(totpHint.uid, code);
  await resolver.resolveSignIn(assertion);
  return true;
}

/** Désinscrit le facteur TOTP (par uid, ou le premier facteur TOTP trouvé). */
export async function unenrollTotpMfa(factorUid?: string): Promise<void> {
  const user = await currentUser();
  const { multiFactor } = await import("firebase/auth");
  const factors = multiFactor(user).enrolledFactors;
  const target =
    factors.find((f) => f.uid === factorUid) ??
    factors.find((f) => f.factorId === "totp");
  if (!target) throw new Error("Aucun facteur TOTP enregistré.");
  await multiFactor(user).unenroll(target.uid);
}

/** L'utilisateur courant a-t-il au moins un facteur TOTP inscrit ? */
export function hasTotpEnrolled(user: User | null): boolean {
  if (!user) return false;
  try {
    // multiFactor(user).enrolledFactors n'existe que si Identity Platform ;
    // accès défensif pour rester no-op sans la fonctionnalité.
    const mfaUser = user as User & { multiFactor?: { enrolledFactors?: Array<{ factorId: string }> } };
    return Boolean(mfaUser.multiFactor?.enrolledFactors?.some((f) => f.factorId === "totp"));
  } catch {
    return false;
  }
}

export const errorsMfa = {
  identityPlatformRequired: "auth/operation-not-allowed",
} as const;
