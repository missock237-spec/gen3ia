"use client";

import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  getRedirectResult,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  updateProfile,
  User,
} from "firebase/auth";

import {
  auth,
  googleProvider,
  githubProvider,
  hasFirebaseClientConfig,
} from "./client";

export interface AuthState {
  user: User | null;
  loading: boolean;
}

export interface SignupProfile {
  firstName: string;
  lastName: string;
  username: string;
  country?: string;
  language?: string;
  timezone?: string;
}

export function useAuth(): AuthState {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hasFirebaseClientConfig()) {
      setLoading(false);
      return;
    }

    try {
      const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
        setUser(nextUser);
        setLoading(false);
      });
      return unsubscribe;
    } catch {
      setLoading(false);
      return undefined;
    }
  }, []);

  return { user, loading };
}

/**
 * Les navigateurs mobiles et les webviews bloquent generalement les popups :
 * on utilise la connexion par redirection, plus fiable, sur ces appareils.
 */
function doitUtiliserRedirection(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent || "";
  const estMobile = /Android|iPhone|iPad|iPod|Mobile|Opera Mini|IEMobile/i.test(ua)
    || (window.navigator.maxTouchPoints ?? 0) > 1;
  return estMobile;
}

export async function signInWithGoogle(): Promise<User> {
  if (doitUtiliserRedirection()) {
    await signInWithRedirect(auth, googleProvider);
    throw new Error("REDIRECTION_EN_COURS");
  }
  return (await signInWithPopup(auth, googleProvider)).user;
}

export async function signInWithGitHub(): Promise<User> {
  if (doitUtiliserRedirection()) {
    await signInWithRedirect(auth, githubProvider);
    throw new Error("REDIRECTION_EN_COURS");
  }
  return (await signInWithPopup(auth, githubProvider)).user;
}

/**
 * Traite le retour d'une connexion par redirection (mobile) : lorsque
 * l'utilisateur revient sur /login apres le flux OAuth, cette fonction
 * recupere le resultat et etablit la session serveur.
 */
export async function completerConnexionRedirect(redirectTo?: string | null): Promise<void> {
  const result = await getRedirectResult(auth);
  if (result?.user) {
    await establishSession(result.user, redirectTo);
  }
}

export async function logout(): Promise<void> {
  try { await fetch("/api/auth/session", { method: "DELETE" }); } catch { /* le cookie expire de toute facon */ }
  await signOut(auth);
}

export function traduireErreurAuth(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code) : "";
  switch (code) {
    case "auth/email-already-in-use": return "Cette adresse email est deja utilisee par un compte existant.";
    case "auth/invalid-email": return "L'adresse email saisie n'est pas valide.";
    case "auth/missing-email": return "Veuillez saisir une adresse email.";
    case "auth/missing-password": return "Veuillez saisir un mot de passe.";
    case "auth/weak-password": return "Le mot de passe est trop faible : utilisez au moins 6 caracteres.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
    case "auth/invalid-login-credentials": return "Email ou mot de passe incorrect.";
    case "auth/too-many-requests": return "Trop de tentatives. Veuillez reessayer dans quelques minutes.";
    case "auth/unauthorized-domain": return "Ce domaine n'est pas autorise pour l'authentification. Ajoutez gen3ia.online (et www.gen3ia.online) dans la console Firebase (Authentication -> Settings -> Authorized domains).";
    case "auth/internal-error": return "Erreur interne Firebase. Verifiez que gen3ia.online est bien autorise dans la console Firebase (domaines autorises), puis reessayez.";
    case "auth/popup-blocked": return "Le navigateur a bloque la fenetre de connexion. Autorisez les popups ou reessayez.";
    case "auth/popup-closed-by-user": return "Fenetre de connexion fermee avant la fin. Veuillez reessayer.";
    case "auth/cancelled-popup-request": return "Une seule fenetre de connexion peut etre ouverte a la fois. Veuillez reessayer.";
    case "auth/user-disabled": return "Ce compte a ete desactive.";
    case "auth/network-request-failed": return "Erreur reseau : verifiez votre connexion internet.";
    case "auth/operation-not-allowed": return "La connexion par email/mot de passe n'est pas encore activee sur ce projet.";
    case "auth/admin-restricted-operation": return "La creation de compte n'est pas autorisee actuellement.";
    default: return error instanceof Error && error.message ? error.message : "Une erreur inattendue s'est produite. Veuillez reessayer.";
  }
}

function validateProfile(profile: SignupProfile): void {
  if (!profile.firstName.trim() || profile.firstName.trim().length > 80) throw new Error("Le prenom est obligatoire.");
  if (!profile.lastName.trim() || profile.lastName.trim().length > 80) throw new Error("Le nom est obligatoire.");
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(profile.username.trim())) throw new Error("Le nom d'utilisateur doit contenir 3 a 32 caracteres (lettres, chiffres, ., _ ou -).");
}

export async function signUpWithEmail(
  email: string,
  password: string,
  profile: SignupProfile,
): Promise<User> {
  validateProfile(profile);
  const result = await createUserWithEmailAndPassword(auth, email.trim(), password);

  try {
    const displayName = `${profile.firstName.trim()} ${profile.lastName.trim()}`.replace(/\s+/g, " ");
    await updateProfile(result.user, { displayName });

    const token = await result.user.getIdToken(true);
    const response = await fetch("/api/auth/profile", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        firstName: profile.firstName,
        lastName: profile.lastName,
        username: profile.username,
        country: profile.country || null,
        language: profile.language || "fr",
        timezone: profile.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        photoURL: result.user.photoURL || null,
      }),
    });
    if (!response.ok) {
      let detail = "";
      try {
        const errBody = (await response.json()) as { error?: string };
        if (errBody?.error) detail = errBody.error;
      } catch { /* corps illisible */ }
      throw new Error(detail ? `Le profil n'a pas pu etre enregistre (${detail}).` : "Le profil n'a pas pu etre enregistre.");
    }

    try { await sendEmailVerification(result.user); } catch { /* best effort */ }
    return result.user;
  } catch (error) {
    try { await result.user.delete(); } catch { /* evite de laisser un compte Auth a moitié cree quand c'est possible */ }
    throw error;
  }
}

/**
 * Etablit la session serveur (profil + wallet) apres une authentification
 * Firebase reussie, puis redirige vers le tableau de bord (ou la destination
 * `redirectTo` fournie : chemin interne uniquement, pour eviter les
 * redirections ouvertes).
 * Remonte le message d'erreur exact du serveur pour faciliter le diagnostic.
 */
export async function establishSession(user: User, redirectTo?: string | null): Promise<void> {
  const token = await user.getIdToken(true);
  const response = await fetch("/api/auth/session", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch { /* corps illisible : message generique */ }
    throw new Error(detail ? `Impossible d'etablir la session authentifiee (${detail}).` : "Impossible d'etablir la session authentifiee.");
  }
  window.location.href = sanitizeRedirect(redirectTo) ?? "/dashboard";
}

/** N'accepte qu'un chemin interne relatif ("(("/")…") — bloque les URL externes. */
export function sanitizeRedirect(target?: string | null): string | null {
  if (!target) return null;
  if (!target.startsWith("/") || target.startsWith("//")) return null;
  return target;
}

/** Lit le parametre ?next= de l'URL courante (cote client). */
export function readNextRedirect(): string | null {
  if (typeof window === "undefined") return null;
  return sanitizeRedirect(new URLSearchParams(window.location.search).get("next"));
}

/**
 * Indique si l'utilisateur dispose d'une session utilisable, soit via l'etat
 * Firebase client, soit via le cookie de session serveur. Retourne :
 * - true : session presente (l'une ou l'autre) ;
 * - false : aucune session ;
 * - null : encore indetermine (chargement).
 */
export function useSessionAvailable(): boolean | null {
  const { user, loading } = useAuth();
  const [serverSession, setServerSession] = useState<boolean | null>(null);

  useEffect(() => {
    if (user) { setServerSession(null); return; }
    if (loading) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!cancelled) setServerSession(response.ok);
      } catch {
        if (!cancelled) setServerSession(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, loading]);

  if (user) return true;
  if (loading) return null;
  return serverSession;
}

/**
 * fetch authentifie pour toutes les fonctionnalites de la plateforme.
 *
 * - Si le SDK Firebase connait l'utilisateur courant : ID token en Bearer
 *   (comportement historique).
 * - Sinon (etat Firebase client perdu : webviews mobiles, stockage bloque,
 *   reload apres redirection OAuth) : la requete part "nue" et le cookie de
 *   session signe pose par POST /api/auth/session authentifie l'appel cote
 *   serveur (requireUser accepte les deux).
 *
 * A utiliser partout a la place d'un fetch + getIdToken manuel, afin qu'aucune
 * fonctionnalite ne devienne inaccessible apres une connexion reussie.
 */
export async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Le cookie de session serveur reste utilisable même si la configuration
  // Firebase Web n'est pas injectée dans un déploiement public.
  let currentUser: User | null = null;
  try {
    currentUser = auth.currentUser;
  } catch {
    currentUser = null;
  }

  if (currentUser) {
    try {
      const token = await currentUser.getIdToken();
      const headers = new Headers(init?.headers ?? undefined);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers, credentials: init?.credentials ?? "same-origin" });
    } catch {
      /* ID token indisponible : on retombe sur le cookie de session. */
    }
  }
  return fetch(input, { ...init, credentials: init?.credentials ?? "same-origin" });
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  return (await signInWithEmailAndPassword(auth, email, password)).user;
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}
