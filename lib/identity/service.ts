import "server-only";

import { logger } from "@/lib/observability/logger";

import {
  IdentitySchema,
  IdentityPatchSchema,
  type Identity,
  type IdentityPatch,
} from "./schema";
import {
  IdentityError,
  deleteIdentity,
  getIdentity,
  putIdentity,
} from "./r2-identity-store";

export { IdentityError } from "./r2-identity-store";
export type { IdentityErrorCode } from "./r2-identity-store";

/**
 * Task 108-b — logique métier de la base d'identités R2.
 *
 * Principes :
 * - `ensureIdentity` est IDEMPOTENT et appelé à chaque session : il crée
 *   l'identité absente, sinon ne fait que REMPLIR DES VIDES (jamais écrasant)
 *   + dédupliquer les fournisseurs + retracer le login au plus 1×/heure
 *   (throttle, miroir de la politique Task 101 sur lib/firebase/users.ts —
 *   une session ne doit pas coûter une écriture à chaque chargement de page).
 * - Une panne R2 devient IdentityError("unavailable") : les routes restent
 *   en mode dégradé — une panne de la base d'identités n'invalide JAMAIS une
 *   authentification Firebase par ailleurs valide (philosophie du code
 *   historique, bug "database was deleted").
 * - L'email est une mutation SERVEUR : il ne passe que par un jeton Firebase
 *   portant un email vérifié (setEmailFromVerifiedToken). role/plan/status
 *   ne sont modifiables par aucun chemin utilisateur.
 */

/** Throttle d'écriture du login (miroir Task 101 — lib/firebase/users.ts). */
const LOGIN_WRITE_THROTTLE_MS = 60 * 60_000;

/**
 * Champs NON modifiables par l'utilisateur : filtrés AVANT le parse strict
 * du patch, donc silencieusement IGNORÉS (un client qui renvoie l'objet
 * complet reçoit un 200 et zéro effet de bord) ; tout AUTRE champ inconnu
 * est rejeté par zod strictObject (422).
 */
const CHAMPS_IMMUTABLES = [
  "uid",
  "email",
  "emailVerified",
  "providers",
  "plan",
  "role",
  "status",
  "createdAt",
  "updatedAt",
  "lastLoginAt",
  "identityVersion",
] as const;

/** Nettoyage textuel hérité de lib/firebase/users.ts (trim + espaces + borne). */
function propre(valeur: string | null | undefined, max: number): string | null {
  const normalized = typeof valeur === "string" ? valeur.trim().replace(/\s+/g, " ") : "";
  return normalized ? normalized.slice(0, max) : null;
}

/** URL : trim seul (jamais de repli d'espaces — les URLs n'en contiennent pas). */
function propreUrl(valeur: string | null | undefined): string | null {
  const normalized = typeof valeur === "string" ? valeur.trim() : "";
  return normalized ? normalized.slice(0, 2048) : null;
}

/** Traduit une erreur brute (panne R2…) en IdentityError("unavailable"). */
function envelopper(error: unknown): IdentityError {
  if (error instanceof IdentityError) return error;
  return new IdentityError("unavailable", "Base d'identités momentanément indisponible.", { cause: error });
}

/**
 * Pose l'email d'un jeton VÉRIFIÉ (autorité serveur) : il remplit un email
 * absent ET écrase un email antérieur non vérifié / différent. Retourne
 * true si l'identité a été modifiée.
 */
function appliquerEmailVerifie(fusion: Identity, email: string): boolean {
  if (fusion.email === email && fusion.emailVerified) return false;
  fusion.email = email;
  fusion.emailVerified = true;
  return true;
}

/** Lit une identité existante ; absente → IdentityError("not_found"). */
async function lireOuErreur(uid: string): Promise<Identity> {
  let existante: Identity | null;
  try {
    existante = await getIdentity(uid);
  } catch (error) {
    throw envelopper(error);
  }
  if (!existante) {
    throw new IdentityError(
      "not_found",
      "Identité introuvable : le profil n'a pas encore été provisionné.",
    );
  }
  return existante;
}

/** Champs de provisionnement fournis par la session (jeton/cookie Firebase). */
export interface EnsureIdentityParams {
  uid: string;
  email?: string | null;
  /** Vrai si le JETON Firebase porte un email vérifié (claim email_verified). */
  emailVerified?: boolean;
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  photoURL?: string | null;
  phoneNumber?: string | null;
  country?: string | null;
  bio?: string | null;
  language?: string | null;
  timezone?: string | null;
  provider?: string;
}

/**
 * Garantit l'existence de l'identité (provisionnement à chaque session).
 * - Absente (ou corrompue) → création COMPLÈTE (status active, défauts du
 *   schéma, createdAt/updatedAt/lastLoginAt = maintenant).
 * - Existante → fusion par REMPLISSAGE DES VIDES uniquement (email null →
 *   set, etc.), email d'un jeton vérifié = autorité serveur, fournisseurs
 *   dédupliqués, lastLoginAt retracé UNIQUEMENT si > 1 h (throttle Task 101).
 *   Rien à écrire + login déjà tracé → ZÉRO écriture R2 (idempotent).
 * Lève IdentityError("unavailable") sur panne R2 (routes → mode dégradé).
 */
export async function ensureIdentity(params: EnsureIdentityParams): Promise<Identity> {
  let existante: Identity | null = null;
  try {
    existante = await getIdentity(params.uid);
  } catch (error) {
    if (error instanceof IdentityError && error.code === "corrupted") {
      // Document illisible : le provisionnement RECRÉE (l'appelant décide).
      // Une identité corrompue ne doit jamais bloquer définitivement une
      // session valide ; les champs perdus seront re-remplis par les appels
      // suivants (jeton) ou par l'utilisateur (profil).
      logger.warn({ err: error, uid: params.uid }, "identity.ensure.recreated_from_corrupted");
      existante = null;
    } else {
      throw envelopper(error);
    }
  }

  const maintenant = new Date().toISOString();
  const provider = propre(params.provider, 60);

  if (!existante) {
    const creee = construireIdentite({
      uid: params.uid,
      email: propre(params.email, 254),
      emailVerified: params.emailVerified === true,
      displayName: propre(params.displayName, 120),
      firstName: propre(params.firstName, 80),
      lastName: propre(params.lastName, 80),
      username: propre(params.username, 60)?.toLowerCase() ?? null,
      photoURL: propreUrl(params.photoURL),
      phoneNumber: propre(params.phoneNumber, 32),
      country: propre(params.country, 60),
      bio: propre(params.bio, 500),
      language: propre(params.language, 30) ?? "fr",
      timezone: propre(params.timezone, 60) ?? "UTC",
      providers: provider ? [provider] : [],
      createdAt: maintenant,
      updatedAt: maintenant,
      lastLoginAt: maintenant,
    });
    try {
      await putIdentity(creee);
    } catch (error) {
      throw envelopper(error);
    }
    return creee;
  }

  // ── Fusion (identité existante) : remplissage des VIDES seulement ──
  const fusion: Identity = { ...existante };
  let changements = 0;
  const estVide = (valeur: string | null): boolean => valeur === null || valeur === "";

  const remplirSiVide = (champ: "displayName" | "firstName" | "lastName" | "photoURL" | "phoneNumber" | "country" | "bio", valeur: string | null): void => {
    if (valeur === null || !estVide(fusion[champ])) return;
    fusion[champ] = valeur;
    changements += 1;
  };

  remplirSiVide("displayName", propre(params.displayName, 120));
  remplirSiVide("firstName", propre(params.firstName, 80));
  remplirSiVide("lastName", propre(params.lastName, 80));
  remplirSiVide("photoURL", propreUrl(params.photoURL));
  remplirSiVide("phoneNumber", propre(params.phoneNumber, 32));
  remplirSiVide("country", propre(params.country, 60));
  remplirSiVide("bio", propre(params.bio, 500));

  // Email : remplissage du vide (email null → set)…
  const emailFourni = propre(params.email, 254);
  if (emailFourni && estVide(fusion.email)) {
    fusion.email = emailFourni;
    fusion.emailVerified = params.emailVerified === true;
    changements += 1;
  }
  // …puis autorité du jeton VÉRIFIÉ (setEmailFromVerifiedToken) : il peut
  // écraser un email antérieur non vérifié / différent — mutation serveur.
  if (params.emailVerified === true && emailFourni && appliquerEmailVerifie(fusion, emailFourni)) {
    changements += 1;
  }

  // Username : vide + fourni → normalisé minuscule (parité historique users.ts).
  const usernameFourni = propre(params.username, 60)?.toLowerCase() ?? null;
  if (usernameFourni && estVide(fusion.username)) {
    fusion.username = usernameFourni;
    changements += 1;
  }

  // language/timezone : défauts non vides ; on ne comble qu'un vide anomalie.
  if (estVide(fusion.language) && params.language) {
    const langue = propre(params.language, 30);
    if (langue) {
      fusion.language = langue;
      changements += 1;
    }
  }
  if (estVide(fusion.timezone) && params.timezone) {
    const fuseau = propre(params.timezone, 60);
    if (fuseau) {
      fusion.timezone = fuseau;
      changements += 1;
    }
  }

  // Fournisseurs dédupliqués (plafond 10 posé par le schéma).
  if (provider && !fusion.providers.includes(provider)) {
    fusion.providers = [...fusion.providers, provider].slice(0, 10);
    changements += 1;
  }

  // Throttle login (Task 101) : lastLoginAt ne mérite une écriture qu'une
  // fois par heure — retracer à chaque session coûterait 1 write inutile.
  const dernierLoginMs = Date.parse(fusion.lastLoginAt);
  const loginATracer = Number.isNaN(dernierLoginMs) || Date.now() - dernierLoginMs > LOGIN_WRITE_THROTTLE_MS;

  if (!changements && !loginATracer) {
    // Identité à jour ET login déjà tracé < 1 h : ZÉRO écriture R2.
    return fusion;
  }

  if (loginATracer) {
    fusion.lastLoginAt = maintenant;
  }
  fusion.updatedAt = maintenant;

  try {
    await putIdentity(fusion);
  } catch (error) {
    throw envelopper(error);
  }
  return fusion;
}

/**
 * Construction d'une identité neuve : parse PAR LE SCHÉMA (défauts posés :
 * theme/plan/role/status/identityVersion) — invariant de construction,
 * l'échec est exposé en IdentityError("corrupted"), jamais en ZodError brute.
 */
function construireIdentite(input: Record<string, unknown>): Identity {
  const parsed = IdentitySchema.safeParse(input);
  if (!parsed.success) {
    throw new IdentityError("corrupted", "Construction d'identité non conforme au schéma.", { cause: parsed.error });
  }
  return parsed.data;
}

/**
 * Lecture d'AFFICHAGE : ne lève JAMAIS — IdentityError (corrupted /
 * unavailable / not_found / invalid / too_large) ET erreurs R2 brutes sont
 * avalées → null. Ne remplace jamais getIdentity pour une écriture : les
 * pannes doivent rester visibles aux chemins qui décident (service/routes),
 * pas aux rendus.
 */
export async function getIdentitySafe(uid: string): Promise<Identity | null> {
  try {
    return await getIdentity(uid);
  } catch {
    return null;
  }
}

/**
 * Met à jour l'identité avec un patch UTILISATEUR (PUT /api/auth/profile).
 * - Identité absente → IdentityError("not_found") (404 : pas encore
 *   provisionnée — la session provisionne).
 * - Champs immutables (email/role/plan/status/…) → IGNORÉS silencieusement.
 * - Champ inconnu → ZodError (strict) → 422 côté route.
 * - Écrit la version fusionnée + updatedAt (re-parse par le schéma dans
 *   putIdentity : le stocké reste toujours conforme).
 */
export async function updateIdentity(uid: string, patch: IdentityPatch): Promise<Identity> {
  const existante = await lireOuErreur(uid);

  const brut: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  for (const champ of CHAMPS_IMMUTABLES) delete brut[champ];
  const parsed = IdentityPatchSchema.parse(brut);

  const fusionnee: Identity = { ...existante, ...parsed, updatedAt: new Date().toISOString() };
  try {
    await putIdentity(fusionnee);
  } catch (error) {
    throw envelopper(error);
  }
  return fusionnee;
}

/**
 * Pose l'email depuis un jeton Firebase portant un email VÉRIFIÉ
 * (mutation serveur — appelé par la session via ensureIdentity, exposé
 * pour tout chemin serveur authentifié qui reçoit un tel jeton).
 * Idempotent : email déjà posé + déjà marqué vérifié → zéro écriture.
 */
export async function setEmailFromVerifiedToken(uid: string, email: string): Promise<Identity> {
  const existante = await lireOuErreur(uid);
  const emailPropre = email?.trim() ?? "";
  if (!emailPropre) {
    throw new IdentityError("invalid", "Email vérifié manquant : le jeton ne porte pas d'email exploitable.");
  }
  const fusion: Identity = { ...existante };
  if (appliquerEmailVerifie(fusion, emailPropre)) {
    fusion.updatedAt = new Date().toISOString();
    try {
      await putIdentity(fusion);
    } catch (error) {
      throw envelopper(error);
    }
  }
  return fusion;
}

/**
 * Supprime l'identité (droit à l'effacement RGPD art. 17). Idempotent.
 * La route de suppression l'attrape en mode « journalise et continue » :
 * une panne R2 n'empêche jamais la suppression Auth/Firestore.
 */
export async function deleteIdentityForAccount(uid: string): Promise<void> {
  try {
    await deleteIdentity(uid);
  } catch (error) {
    throw envelopper(error);
  }
}

/** Projection publique (réponses API éventuelles) — jamais de données privées. */
export interface PublicIdentity {
  uid: string;
  displayName: string | null;
  photoURL: string | null;
  theme: "light" | "dark";
  createdAt: string;
}

export function publicIdentity(identity: Identity): PublicIdentity {
  return {
    uid: identity.uid,
    displayName: identity.displayName,
    photoURL: identity.photoURL,
    theme: identity.theme,
    createdAt: identity.createdAt,
  };
}

/**
 * Statut HTTP pour une IdentityError (null si l'erreur est d'une autre
 * nature — la route applique alors sa propre classification).
 * not_found→404, invalid→400, unavailable→503, corrupted/too_large→500.
 */
export function identityErrorStatus(error: unknown): number | null {
  if (!(error instanceof IdentityError)) return null;
  switch (error.code) {
    case "not_found":
      return 404;
    case "invalid":
      return 400;
    case "unavailable":
      return 503;
    case "corrupted":
    case "too_large":
      return 500;
  }
}
