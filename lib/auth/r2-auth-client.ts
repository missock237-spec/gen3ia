"use client";

import {
  invalidateSessionProbe,
  readNextRedirect,
  sanitizeRedirect,
} from "@/lib/firebase/auth-client";

/**
 * Task 151 — CLIENT D'AUTHENTIFICATION NATIF R2 (comptes stockés dans R2).
 *
 * Ces fonctions remplacent les appels Firebase SDK du formulaire e-mail /
 * mot de passe : les identifiants sont vérifiés PAR LE SERVEUR contre les
 * comptes natifs R2 (lib/auth/r2-accounts.ts), et la session est posée par
 * le cookie signé `gen3ia_session` — aucune dépendance à la configuration
 * Firebase (domaines autorisés, fournisseurs activés).
 *
 * Après un succès, le comportement est IDENTIQUE à establishSession :
 * invalidation de la sonde de session partagée (une 401 dédupliquée ne doit
 * pas masquer la session fraîchement posée) puis redirection vers la
 * destination `next` interne ou le tableau de bord.
 */

export interface R2SignupInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  username: string;
  country?: string;
  language?: string;
  timezone?: string;
}

interface R2AuthResponseBody {
  authenticated?: boolean;
  error?: string;
  message?: string;
  ok?: boolean;
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; status: number; data: R2AuthResponseBody | null }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    credentials: "same-origin",
  });
  let data: R2AuthResponseBody | null = null;
  try {
    data = (await response.json()) as R2AuthResponseBody;
  } catch {
    // corps illisible (502 HTML du proxy…) : le statut suffit au message générique
  }
  return { ok: response.ok, status: response.status, data };
}

function messageDErreur(result: { status: number; data: R2AuthResponseBody | null }, repli: string): string {
  return result.data?.error?.trim() || repli;
}

/** Invalide la sonde puis redirige (destination interne uniquement). */
function redirigerApresSession(redirectTo?: string | null): void {
  invalidateSessionProbe();
  window.location.href = sanitizeRedirect(redirectTo) ?? "/dashboard";
}

/**
 * Inscription par compte natif R2 : le serveur crée le compte (identifiants
 * hashés scrypt dans R2), provisionne l'identité + le wallet, ouvre l'espace
 * de stockage (1 Go offert) et pose la session — puis redirection.
 */
export async function signUpWithR2(
  input: R2SignupInput,
  redirectTo?: string | null,
): Promise<void> {
  const result = await postJson("/api/auth/r2/signup", input);
  if (!result.ok || result.data?.authenticated !== true) {
    throw new Error(
      messageDErreur(result, "L'inscription a échoué. Vérifiez vos informations puis réessayez."),
    );
  }
  redirigerApresSession(redirectTo);
}

/** Connexion par identifiants de compte R2 : cookie de session + redirection. */
export async function signInWithR2(
  email: string,
  password: string,
  redirectTo?: string | null,
): Promise<void> {
  const result = await postJson("/api/auth/r2/login", { email, password });
  if (!result.ok || result.data?.authenticated !== true) {
    throw new Error(messageDErreur(result, "E-mail ou mot de passe incorrect."));
  }
  redirigerApresSession(redirectTo);
}

/**
 * Demande de réinitialisation : la réponse serveur est volontairement
 * identique que le compte existe ou non (aucune énumération d'adresses).
 * Retourne le message à afficher à l'utilisateur.
 */
export async function requestR2PasswordReset(email: string): Promise<string> {
  const result = await postJson("/api/auth/r2/password-reset", { email });
  if (!result.ok) {
    throw new Error(messageDErreur(result, "La demande a échoué. Réessayez dans un instant."));
  }
  return result.data?.message ?? "Si un compte existe avec cette adresse, un e-mail de réinitialisation vient d'être envoyé.";
}

/** Confirmation : applique le nouveau mot de passe via le jeton à usage unique. */
export async function confirmR2PasswordReset(token: string, newPassword: string): Promise<string> {
  const result = await postJson("/api/auth/r2/password-reset/confirm", {
    token,
    newPassword,
  });
  if (!result.ok || result.data?.ok !== true) {
    throw new Error(messageDErreur(result, "Le lien est invalide ou expiré. Refaites une demande de réinitialisation."));
  }
  return result.data?.message ?? "Mot de passe modifié. Vous pouvez vous connecter avec vos nouveaux identifiants.";
}

/** Destination ?next= courante (réutilisée par le formulaire R2). */
export { readNextRedirect, sanitizeRedirect };
