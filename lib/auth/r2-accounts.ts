import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { adminDb } from "@/lib/firebase/admin";
import { FieldValue, Timestamp } from "@/lib/r2fs";

/**
 * COMPTES D'AUTHENTIFICATION NATIFS R2 — Task 151.
 *
 * Le système d'authentification repose désormais sur des comptes dont les
 * identifiants vivent DANS R2 (moteur r2fs, documents JSON sous
 * fs/{collection}/{docId}.json) — aucune dépendance Firebase :
 *
 *   fs/authAccounts/<uid>.json       → compte complet (hash scrypt du mot
 *                                      de passe, profil, horodatages) ;
 *   fs/authEmailIndex/<emailHash>    → index e-mail → uid (lecture directe,
 *                                      JAMAIS de scan de collection) ;
 *   fs/authPasswordResets/<token>    → jetons de réinitialisation (usage
 *                                      unique, TTL 30 min).
 *
 * À l'ouverture du compte :
 *   · l'espace de stockage R2 de l'utilisateur s'ouvre (préfixe
 *     users/<uid>/permanent/ — un fichier de bienvenue y est déposé par la
 *     route d'inscription) ;
 *   · le quota de stockage offert est de 1 Go (plan « free » de
 *     lib/storage/plans.ts, appliqué dynamiquement par
 *     getQuotaBytesForUser — aucune création de document nécessaire) ;
 *   · l'identité plateforme + le wallet sont provisionnés (route signup).
 *
 * La reconnaissance de chaque utilisateur par ses identifiants de connexion
 * s'opère via le cookie de session signé `gen3ia_session`
 * (lib/server/session-cookie.ts) : provider « r2-password ». Toutes les
 * routes API existantes l'acceptent déjà (requireUser / verifyFirebaseAuth
 * en mode dual Bearer+cookie) — les comptes R2 sont reconnus PARTOUT sans
 * modification des surfaces protégées.
 *
 * Hachage : scrypt (N=16384, r=8, p=1, 64 octets, sel aléatoire de 16 octets)
 * — paramètres OWASP 2023, format auto-descriptif
 * `scrypt$N$r$p$saltB64$hashB64`, vérification à temps constant.
 */

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

const ACCOUNTS_COLLECTION = "authAccounts";
const EMAIL_INDEX_COLLECTION = "authEmailIndex";
const RESETS_COLLECTION = "authPasswordResets";

/** Provider enregistré dans la session signée et l'identité R2. */
export const R2_ACCOUNT_PROVIDER = "r2-password";

/** Durée de vie d'un jeton de réinitialisation de mot de passe. */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

/** Longueur minimale du mot de passe (comptes natifs R2). */
export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ------------------------------------------------------------------ */
/* Erreurs typées                                                      */
/* ------------------------------------------------------------------ */

export type R2AuthErrorCode =
  | "INVALID_EMAIL"
  | "WEAK_PASSWORD"
  | "EMAIL_TAKEN"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_TOKEN";

/** Statut HTTP associé à chaque code d'erreur. */
const CODE_STATUS: Record<R2AuthErrorCode, number> = {
  INVALID_EMAIL: 400,
  WEAK_PASSWORD: 400,
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_NOT_FOUND: 404,
  INVALID_TOKEN: 400,
};

export class R2AuthError extends Error {
  readonly code: R2AuthErrorCode;
  readonly status: number;

  constructor(code: R2AuthErrorCode, message: string) {
    super(message);
    this.name = "R2AuthError";
    this.code = code;
    this.status = CODE_STATUS[code];
  }
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validerEmail(email: string): void {
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    throw new R2AuthError(
      "INVALID_EMAIL",
      "Veuillez saisir une adresse e-mail valide.",
    );
  }
}

function validerMotDePasse(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH || password.length > 128) {
    throw new R2AuthError(
      "WEAK_PASSWORD",
      `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`,
    );
  }
}

/** Identifiant de document d'index : hash SHA-256 de l'e-mail normalisé. */
function emailDocId(email: string): string {
  return createHash("sha256").update(`gen3ia-account|${normalizeEmail(email)}`).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Hachage scrypt                                                      */
/* ------------------------------------------------------------------ */

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N < 1024 || r < 1 || p < 1) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scrypt(password, salt, expected.length, { N, r, p });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/* ------------------------------------------------------------------ */
/* Modèle de compte                                                    */
/* ------------------------------------------------------------------ */

export interface R2Account {
  uid: string;
  email: string;
  displayName: string | null;
  username: string | null;
  provider: string;
  emailVerified: boolean;
  passwordHash: string;
  createdAt: number;
  lastLoginAt: number | null;
  failedLoginAttempts: number;
}

type AccountDoc = {
  uid: string;
  email: string;
  displayName: string | null;
  username: string | null;
  provider: string;
  emailVerified: boolean;
  passwordHash: string;
  createdAt: unknown;
  updatedAt: unknown;
  lastLoginAt: unknown;
  failedLoginAttempts: number;
};

function toMillis(value: unknown): number {
  if (value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return 0;
}

function docToAccount(uid: string, data: Record<string, unknown> | undefined): R2Account | null {
  if (!data || typeof data.uid !== "string" || typeof data.passwordHash !== "string") return null;
  return {
    uid,
    email: String(data.email ?? ""),
    displayName: typeof data.displayName === "string" ? data.displayName : null,
    username: typeof data.username === "string" ? data.username : null,
    provider: typeof data.provider === "string" ? data.provider : R2_ACCOUNT_PROVIDER,
    emailVerified: data.emailVerified === true,
    passwordHash: data.passwordHash,
    createdAt: toMillis(data.createdAt),
    lastLoginAt: toMillis(data.lastLoginAt) || null,
    failedLoginAttempts: Number(data.failedLoginAttempts ?? 0) || 0,
  };
}

/* ------------------------------------------------------------------ */
/* Lectures                                                            */
/* ------------------------------------------------------------------ */

/** Compte par e-mail : index direct (uid) puis compte — aucun scan. */
export async function getR2AccountByEmail(email: string): Promise<R2Account | null> {
  const indexSnap = await adminDb
    .collection(EMAIL_INDEX_COLLECTION)
    .doc(emailDocId(email))
    .get();
  if (!indexSnap.exists) return null;
  const uid = indexSnap.get("uid");
  if (typeof uid !== "string" || !uid) return null;
  return getR2AccountByUid(uid);
}

export async function getR2AccountByUid(uid: string): Promise<R2Account | null> {
  if (!uid?.trim()) return null;
  const snap = await adminDb.collection(ACCOUNTS_COLLECTION).doc(uid).get();
  if (!snap.exists) return null;
  return docToAccount(uid, (snap.data() as Record<string, unknown> | undefined) ?? undefined);
}

export async function emailAccountExists(email: string): Promise<boolean> {
  return (await getR2AccountByEmail(email)) !== null;
}

/* ------------------------------------------------------------------ */
/* Création de compte (atomique : index e-mail + compte)               */
/* ------------------------------------------------------------------ */

export interface CreateR2AccountParams {
  email: string;
  password: string;
  displayName?: string | null;
  username?: string | null;
}

function generateUid(): string {
  return `r2_${randomBytes(12).toString("hex")}`;
}

/**
 * Crée le compte dans R2. L'unicité de l'e-mail est garantie par la
 * transaction r2fs (create-if-absent sur le document d'index, CAS S3) :
 * deux inscriptions simultanées de la même adresse ne peuvent pas créer
 * deux comptes — la seconde échoue avec EMAIL_TAKEN.
 */
export async function createR2Account(params: CreateR2AccountParams): Promise<R2Account> {
  const email = normalizeEmail(params.email);
  validerEmail(email);
  validerMotDePasse(params.password);

  const uid = generateUid();
  const passwordHash = await hashPassword(params.password);
  const displayName = params.displayName?.trim() || null;
  const username = params.username?.trim().toLowerCase() || null;

  await adminDb.runTransaction(async (tx) => {
    const indexRef = adminDb.collection(EMAIL_INDEX_COLLECTION).doc(emailDocId(email));
    const snap = await tx.get(indexRef);
    if (snap.exists) {
      throw new R2AuthError(
        "EMAIL_TAKEN",
        "Cette adresse e-mail est déjà utilisée par un compte existant.",
      );
    }
    tx.set(indexRef, {
      uid,
      email,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(adminDb.collection(ACCOUNTS_COLLECTION).doc(uid), {
      uid,
      email,
      displayName,
      username,
      provider: R2_ACCOUNT_PROVIDER,
      emailVerified: false,
      passwordHash,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastLoginAt: null,
      failedLoginAttempts: 0,
    } satisfies AccountDoc & { createdAt: unknown; updatedAt: unknown });
  });

  return {
    uid,
    email,
    displayName,
    username,
    provider: R2_ACCOUNT_PROVIDER,
    emailVerified: false,
    passwordHash,
    createdAt: Date.now(),
    lastLoginAt: null,
    failedLoginAttempts: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Authentification par identifiants                                   */
/* ------------------------------------------------------------------ */

/**
 * Vérifie les identifiants de connexion. Les messages sont volontairement
 * IDENTIQUES pour « compte inconnu » et « mot de passe erroné » (aucune
 * énumération de comptes), et une dérivation scrypt factice de même coût
 * est exécutée quand le compte n'existe pas (atténuation des timings).
 */
export async function authenticateR2Account(params: {
  email: string;
  password: string;
}): Promise<R2Account> {
  const email = normalizeEmail(params.email);
  const account = await getR2AccountByEmail(email);

  if (!account) {
    // Coût équivalent à une vraie vérification : pas de signal temporel.
    await hashPassword(params.password);
    throw new R2AuthError("INVALID_CREDENTIALS", "E-mail ou mot de passe incorrect.");
  }

  const valid = await verifyPassword(params.password, account.passwordHash);
  if (!valid) {
    // Observabilité (compteur) — best effort, jamais bloquant.
    await adminDb
      .collection(ACCOUNTS_COLLECTION)
      .doc(account.uid)
      .set(
        { failedLoginAttempts: FieldValue.increment(1) },
        { merge: true },
      )
      .catch(() => undefined);
    throw new R2AuthError("INVALID_CREDENTIALS", "E-mail ou mot de passe incorrect.");
  }

  // Succès : remise à zéro du compteur + horodatage du login (best effort).
  await adminDb
    .collection(ACCOUNTS_COLLECTION)
    .doc(account.uid)
    .set(
      { failedLoginAttempts: 0, lastLoginAt: FieldValue.serverTimestamp() },
      { merge: true },
    )
    .catch(() => undefined);

  return account;
}

/* ------------------------------------------------------------------ */
/* Réinitialisation de mot de passe                                    */
/* ------------------------------------------------------------------ */

/** Crée un jeton à usage unique (TTL 30 min). null : compte introuvable. */
export async function createPasswordResetToken(email: string): Promise<string | null> {
  const account = await getR2AccountByEmail(normalizeEmail(email));
  if (!account) return null;
  const token = randomBytes(32).toString("hex");
  await adminDb.collection(RESETS_COLLECTION).doc(token).set({
    uid: account.uid,
    email: account.email,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromMillis(Date.now() + PASSWORD_RESET_TTL_MS),
  });
  return token;
}

/**
 * Consomme le jeton (usage unique : le document est supprimé même si
 * expiré — purge). Retourne le compte si le jeton est valide et vivant ;
 * sinon lève R2AuthError("INVALID_TOKEN") — ne renvoie JAMAIS null.
 */
export async function consumePasswordResetToken(token: string): Promise<R2Account> {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    throw new R2AuthError("INVALID_TOKEN", "Lien de réinitialisation invalide ou expiré.");
  }
  const ref = adminDb.collection(RESETS_COLLECTION).doc(token);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new R2AuthError("INVALID_TOKEN", "Lien de réinitialisation invalide ou expiré.");
  }
  const data = (snap.data() as Record<string, unknown> | undefined) ?? {};
  await ref.delete().catch(() => undefined);

  if (toMillis(data.expiresAt) <= Date.now()) {
    throw new R2AuthError("INVALID_TOKEN", "Lien de réinitialisation invalide ou expiré.");
  }
  const account = await getR2AccountByUid(String(data.uid ?? ""));
  if (!account) {
    throw new R2AuthError("INVALID_TOKEN", "Lien de réinitialisation invalide ou expiré.");
  }
  return account;
}

/** Remplace le mot de passe d'un compte (après réinitialisation validée). */
export async function updateR2AccountPassword(uid: string, newPassword: string): Promise<void> {
  validerMotDePasse(newPassword);
  const passwordHash = await hashPassword(newPassword);
  await adminDb
    .collection(ACCOUNTS_COLLECTION)
    .doc(uid)
    .set(
      { passwordHash, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );
}

/** Vue publique d'un compte (JAMAIS le hash). */
export function publicR2Account(account: R2Account): {
  uid: string;
  email: string;
  name: string | null;
  username: string | null;
  provider: string;
} {
  return {
    uid: account.uid,
    email: account.email,
    name: account.displayName,
    username: account.username,
    provider: account.provider,
  };
}
