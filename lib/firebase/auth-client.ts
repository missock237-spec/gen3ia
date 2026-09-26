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

/**
 * Codes d'erreur qui imposent le repli automatique vers la connexion par
 * redirection : la fenêtre popup n'est pas disponible (bloquée, webview,
 * stockage tiers refusé). Firebase recommande ce fallback officiel.
 */
const POPUP_FALLBACK_CODES = new Set([
  "auth/popup-blocked",
  "auth/operation-not-supported-in-this-environment",
  "auth/popup-unsupported",
]);

function codeDe(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

/**
 * Connexion OAuth avec stratégie complète :
 *  1. Popup (desktop) — rapide, sans quitter la page ;
 *  2. Repli AUTOMATIQUE en redirection si la popup est indisponible ;
 *  3. Redirection directe sur mobile (doitUtiliserRedirection).
 * Le résultat de redirection est traité par completerConnexionRedirect
 * au retour sur /login.
 */
export async function signInWithGoogle(): Promise<User> {
  if (doitUtiliserRedirection()) {
    await signInWithRedirect(auth, googleProvider);
    throw new Error("REDIRECTION_EN_COURS");
  }
  try {
    return (await signInWithPopup(auth, googleProvider)).user;
  } catch (error) {
    if (POPUP_FALLBACK_CODES.has(codeDe(error))) {
      await signInWithRedirect(auth, googleProvider);
      throw new Error("REDIRECTION_EN_COURS");
    }
    throw error;
  }
}

export async function signInWithGitHub(): Promise<User> {
  if (doitUtiliserRedirection()) {
    await signInWithRedirect(auth, githubProvider);
    throw new Error("REDIRECTION_EN_COURS");
  }
  try {
    return (await signInWithPopup(auth, githubProvider)).user;
  } catch (error) {
    if (POPUP_FALLBACK_CODES.has(codeDe(error))) {
      await signInWithRedirect(auth, githubProvider);
      throw new Error("REDIRECTION_EN_COURS");
    }
    throw error;
  }
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
    case "auth/internal-error": {
      // Le message brut Firebase est affiché en complément : il contient la
      // cause réelle (domaine non autorisé, fournisseur désactivé…) et
      // évite les diagnostics à l'aveugle côté support.
      const brut = error instanceof Error && error.message && error.message !== code
        ? ` (${error.message.slice(0, 300)})`
        : "";
      return `Erreur interne Firebase pendant la connexion. Verifiez que gen3ia.online est bien autorise dans la console Firebase, puis reessayez.${brut}`;
    }
    case "auth/popup-blocked": return "Le navigateur a bloqué la fenêtre de connexion. Autorisez les popups ou reessayez — la connexion par redirection est tentée automatiquement.";
    case "auth/popup-closed-by-user": return "Fenêtre de connexion fermée avant la fin. Veuillez reessayer.";
    case "auth/cancelled-popup-request": return "Une seule fenêtre de connexion peut etre ouverte a la fois. Veuillez reessayer.";
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

  const enregistrerProfil = async (): Promise<void> => {
    const displayName = `${profile.firstName.trim()} ${profile.lastName.trim()}`.replace(/\s+/g, " ");
    await updateProfile(result.user, { displayName });

    const token = await result.user.getIdToken(true);
    let dernierDetail = "";
    // 2 tentatives : une panne Firestore transitoire ne doit pas casser
    // l'inscription (le compte Firebase est desormais le bien de l'utilisateur).
    for (let essai = 1; essai <= 2; essai++) {
      let response: Response;
      try {
        response = await fetch("/api/auth/profile", {
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
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        dernierDetail = "serveur injoignable";
        if (essai < 2) { await attendre(800); continue; }
        break;
      }
      if (response.ok) return;
      let detail = "";
      try {
        const errBody = (await response.json()) as { error?: string };
        if (errBody?.error) detail = errBody.error;
      } catch { /* corps illisible */ }
      dernierDetail = detail || `erreur ${response.status}`;
      if (response.status >= 500 && essai < 2) { await attendre(800); continue; }
      break;
    }
    throw new Error(
      `Votre compte a bien ete cree, mais le profil n'a pas pu etre enregistre (${dernierDetail}). ` +
      "Reessayez de vous connecter dans un instant : la session finalisera la synchronisation automatiquement.",
    );
  };

  try {
    await enregistrerProfil();
    try { await sendEmailVerification(result.user); } catch { /* best effort */ }
    return result.user;
  } catch (error) {
    // IMPORTANT : on ne supprime PLUS le compte Firebase en cas d'echec du
    // profil — une panne serveur transitoire detruisait sinon un compte
    // valide (et l'utilisateur repartait de zero). Il peut se connecter :
    // la session se synchronise automatiquement (mode dégradé serveur).
    throw error;
  }
}

/** Petite attente avec backoff pour les reprises réseau. */
function attendre(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Etablit la session serveur (profil + wallet) apres une authentification
 * Firebase reussie, puis redirige vers le tableau de bord (ou la destination
 * `redirectTo` fournie : chemin interne uniquement, pour eviter les
 * redirections ouvertes).
 *
 * Robustesse : 3 tentatives en cas d'erreur reseau, 429 ou 5xx (pannes
 * transitoires de Firestore côté serveur) — un échec définitif remonte le
 * message d'erreur exact du serveur pour faciliter le diagnostic.
 */
export async function establishSession(user: User, redirectTo?: string | null): Promise<void> {
  const token = await user.getIdToken(true);
  const tentatives = 3;
  let dernierDetail = "";

  for (let essai = 1; essai <= tentatives; essai++) {
    let response: Response;
    try {
      response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // Erreur reseau/timeout : reprise utile si la panne est transitoire.
      dernierDetail = "connexion au serveur impossible";
      if (essai < tentatives) { await attendre(600 * essai); continue; }
      break;
    }

    if (response.ok) {
      window.location.href = sanitizeRedirect(redirectTo) ?? "/studio";
      return;
    }

    // 429/5xx = panne transitoire côté serveur -> nouvelle tentative.
    // 4xx definitifs (401, 403...) = pas la peine d'insister.
    let detail = "";
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch { /* corps illisible : message generique */ }
    dernierDetail = detail;

    if (response.status === 429 || response.status >= 500) {
      if (essai < tentatives) { await attendre(800 * essai); continue; }
    }
    break;
  }

  throw new Error(
    dernierDetail
      ? `Impossible d'etablir la session authentifiee (${dernierDetail}).`
      : "Impossible d'etablir la session authentifiee. Verifiez votre connexion puis reessayez.",
  );
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
      // 2 tentatives : une erreur reseau isolée ne doit pas basculer un
      // utilisateur authentifié (cookie présent) vers le portail de login.
      for (let essai = 1; essai <= 2; essai++) {
        try {
          const response = await fetch("/api/auth/session", {
            cache: "no-store",
            signal: AbortSignal.timeout(12_000),
          });
          // 200 = session valide (même en mode dégradé). 401 = vraiment
          // sans session. 5xx = panne serveur transitoire -> reprise.
          if (!cancelled) {
            if (response.ok) { setServerSession(true); return; }
            if (response.status < 500 && essai < 2) { await attendre(500); continue; }
            setServerSession(response.ok);
            if (response.status < 500) return;
          }
          if (response.status < 500) return;
        } catch {
          if (!cancelled && essai >= 2) { setServerSession(false); return; }
        }
        if (essai < 2) await attendre(600);
      }
    })();
    return () => { cancelled = true; };
  }, [user, loading]);

  if (user) return true;
  if (loading) return null;
  return serverSession;
}

/**
 * Lit le corps JSON d'une reponse sans jamais lever : retourne null si le
 * corps est vide, tronque ou non-JSON (502 HTML du proxy, gateway timeout…).
 * A preferer a `await response.json()` nu dans tout code qui affiche une
 * erreur utilisateur — un JSON illisible ne doit pas masquer l'erreur reelle.
 */
export async function readJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export interface AuthFetchOptions {
  /** Timeout global de la requete en ms (aucun par defaut : certaines
   *  operations agents durent plusieurs minutes). */
  timeoutMs?: number;
  /** Retenter une fois sur erreur reseau/5xx (defaut : GET et HEAD only,
   *  car seuls ces verbes sont idempotents). */
  retry?: boolean;
}

async function fetchUneFois(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  opts: AuthFetchOptions | undefined,
): Promise<Response> {
  const signal = opts?.timeoutMs
    ? (init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(opts.timeoutMs)])
      : AbortSignal.timeout(opts.timeoutMs))
    : init?.signal;

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
      return await fetch(input, { ...init, headers, signal, credentials: init?.credentials ?? "same-origin" });
    } catch (error) {
      // Abort volontaire de l'appelant : ne pas retomber sur un second appel.
      if (signal?.aborted) throw error;
      /* ID token indisponible : on retombe sur le cookie de session. */
    }
  }
  return fetch(input, { ...init, signal, credentials: init?.credentials ?? "same-origin" });
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
 * Robustesse : retry automatique (1x) sur erreur reseau ou 502/503/504 pour
 * les verbes idempotents (GET/HEAD), timeout optionnel via { timeoutMs }.
 * A utiliser partout a la place d'un fetch + getIdToken manuel, afin qu'aucune
 * fonctionnalite ne devienne inaccessible apres une connexion reussie.
 */
export async function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  opts?: AuthFetchOptions,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const idempotent = method === "GET" || method === "HEAD";
  const peutRetenter = opts?.retry ?? idempotent;

  try {
    const response = await fetchUneFois(input, init, opts);
    if (
      peutRetenter &&
      (response.status === 502 || response.status === 503 || response.status === 504)
    ) {
      await attendre(500);
      return fetchUneFois(input, init, opts);
    }
    return response;
  } catch (error) {
    if (opts?.timeoutMs && error instanceof DOMException && error.name === "TimeoutError") throw error;
    if (init?.signal?.aborted) throw error;
    if (!peutRetenter) throw error;
    await attendre(500);
    return fetchUneFois(input, init, opts);
  }
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  return (await signInWithEmailAndPassword(auth, email, password)).user;
}

export async function resetPassword(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email);
}
