import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { adminDb } from "@/lib/firebase/admin";
import { getPlanState } from "@/lib/billing/abonnements";
import { PLANS } from "@/lib/billing/plans";
import { runFirestoreGuarded } from "@/lib/queue/firestore-guard";
import { enforceRateLimit } from "./rate-limit";
import { HttpError } from "./http-errors";

/**
 * CLÉS API ENTREPRISE (Task 126) — collection `apiKeys` (moteur r2fs).
 *
 * Contrairement aux clés développeur extensions (`g3x_`, liées à UN projet
 * Gen3ia pour le SDK), les clés `g3a_` sont des identifiants de compte
 * à SCOPES nominaux (media / agents / terminal / read) consommables sur
 * l'API publique `/api/v1/**`.
 *
 * Sécurité :
 *   - SEUL le hash SHA-256 de la clé est persisté (jamais la clé en
 *     clair — convention « secrets jamais en clair » du projet) ;
 *   - la clé (`g3a_` + 32 octets base64url) n'est affichée qu'UNE fois,
 *     à la création (le préfixe `g3a_XXXXXX` reste listable ensuite) ;
 *   - l'identifiant du document EST le hash : résolution d'auth en UNE
 *     lecture directe, sans scan ;
 *   - quota par clé : `rateLimitPerMinute` appliqué via enforceRateLimit
 *     (locale + par-instance) AVANT toute exécution métier ;
 *   - révocation soft (revokedAt) : auditable, immédiat à l'auth.
 *
 * GATE PLAN PRO (demande utilisateur n°8) : la CRÉATION d'une clé exige le
 * plan Pro ou supérieur (entitlement « api_keys » — pro, entreprise,
 * modele-sur-mesure). Les clés DÉJÀ créées restent VALABLES : aucune
 * révocation rétroactive n'est appliquée au changement/descente de plan —
 * seul le passage du plan est vérifié au moment de la création, et
 * `authenticateApiKey` ne consulte PAS l'abonnement (contrat documenté).
 * L'usage des clés reste en revanche facturé au token
 * (lib/billing/api-usage.ts : 1,00 €/1M entrant, 1,50 €/1M sortant).
 */

const COLLECTION = "apiKeys";

/** Préfixe des clés API entreprise (distinct de `g3x_` développeur extensions). */
export const API_KEY_PREFIX = "g3a_";

/** Scopes nominaux de l'API publique v1. */
export const API_KEY_SCOPES = ["media", "agents", "terminal", "read"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Garde hygiène : nombre de clés actives max par compte. */
const MAX_ACTIVE_KEYS_PER_OWNER = 10;

/** Plafonds du quota configurable par clé (req/min). */
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;
const MAX_RATE_LIMIT_PER_MINUTE = 600;

/** Document persisté (id = keyHash SHA-256 hex — jamais la clé en clair). */
interface ApiKeyDoc {
  id: string;
  ownerId: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Vue publique d'une clé (hash jamais exposé hors de l'identifiant interne). */
export interface ApiKeyPublicView {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

/** Contexte d'identité dérivé d'une clé API valide. */
export interface ApiKeyIdentity {
  userId: string;
  keyId: string;
  prefix: string;
  scopes: ApiKeyScope[];
  via: "api_key";
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key.trim()).digest("hex");
}

/** Génère une clé `g3a_…` (32 octets aléatoires) + son hash et son préfixe d'affichage. */
export function generateApiKey(): { key: string; keyHash: string; prefix: string } {
  const key = API_KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, keyHash: hashApiKey(key), prefix: API_KEY_PREFIX + key.slice(4, 10) };
}

/** Valide/nettoie une liste de scopes en entrée (zod est appliqué au niveau route). */
export function normalizeScopes(input: readonly string[]): ApiKeyScope[] {
  const valid = input.filter((scope): scope is ApiKeyScope =>
    (API_KEY_SCOPES as readonly string[]).includes(scope));
  const unique = [...new Set(valid)];
  if (unique.length === 0) throw new HttpError(400, `Scopes invalides : au moins un parmi ${API_KEY_SCOPES.join(", ")}.`);
  return unique;
}

function toPublicView(doc: ApiKeyDoc): ApiKeyPublicView {
  return {
    id: doc.id,
    name: doc.name,
    prefix: doc.prefix,
    scopes: doc.scopes,
    rateLimitPerMinute: doc.rateLimitPerMinute,
    createdAt: doc.createdAt,
    lastUsedAt: doc.lastUsedAt,
    revokedAt: doc.revokedAt,
  };
}

/** Crée une clé : la clé en clair n'est retournée qu'ICI (affichage unique). */
export async function createApiKey(params: {
  ownerId: string;
  name: string;
  scopes: readonly string[];
  rateLimitPerMinute?: number;
}): Promise<{ key: string; view: ApiKeyPublicView }> {
  if (!params.ownerId.trim()) throw new HttpError(400, "Création de clé API : compte requis.");

  // GATE PLAN PRO (demande utilisateur n°8) : la création de clés API est
  // réservée au plan Pro ou supérieur. Message explicite avec l'orientation
  // /billing. Les clés existantes ne sont JAMAIS révoquées rétroactivement.
  const plan = await getPlanState(params.ownerId);
  if (!PLANS[plan.planId].entitlements.includes("api_keys")) {
    throw new HttpError(
      403,
      `La création de clés API est réservée au plan Pro ou supérieur (plan actuel : ${PLANS[plan.planId].name}). Mettez votre abonnement à niveau depuis /billing puis réessayez.`,
    );
  }

  const name = params.name.trim().slice(0, 100) || "clé API";
  const scopes = normalizeScopes(params.scopes);
  const rateLimitPerMinute = Math.min(
    Math.max(params.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE, 1),
    MAX_RATE_LIMIT_PER_MINUTE,
  );

  // Garde hygiène : plafond de clés ACTIVES par compte.
  const owned = await runFirestoreGuarded("api-keys list " + params.ownerId, async () => {
    const snap = await adminDb.collection(COLLECTION).where("ownerId", "==", params.ownerId).limit(100).get();
    return snap.docs.map((d) => d.data() as ApiKeyDoc);
  });
  if (owned.filter((doc) => doc.revokedAt === null).length >= MAX_ACTIVE_KEYS_PER_OWNER) {
    throw new HttpError(409, `Maximum de ${MAX_ACTIVE_KEYS_PER_OWNER} clés actives atteint. Révoquez une clé avant d'en créer une nouvelle.`);
  }

  const { key, keyHash, prefix } = generateApiKey();
  const now = Date.now();
  const doc: ApiKeyDoc = {
    id: keyHash,
    ownerId: params.ownerId,
    name,
    prefix,
    scopes,
    rateLimitPerMinute,
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  };
  // create() (et non set) : collision de hash impossible à ignorer silencieusement.
  await runFirestoreGuarded("api-keys create", () => adminDb.collection(COLLECTION).doc(keyHash).create(doc));
  return { key, view: toPublicView(doc) };
}

/** Liste les clés d'un compte (actives puis révoquées, plus récentes d'abord). */
export async function listApiKeys(ownerId: string): Promise<ApiKeyPublicView[]> {
  const snap = await runFirestoreGuarded("api-keys list " + ownerId, async () => {
    const query = adminDb.collection(COLLECTION).where("ownerId", "==", ownerId).limit(100);
    return query.get();
  });
  return snap.docs
    .map((d) => d.data() as ApiKeyDoc)
    .filter((doc) => doc.ownerId === ownerId)
    .sort((a, b) => (a.revokedAt === null ? 0 : 1) - (b.revokedAt === null ? 0 : 1) || b.createdAt - a.createdAt)
    .map(toPublicView);
}

/** Révoque une clé (soft delete : l'historique d'audit reste lisible). */
export async function revokeApiKey(ownerId: string, keyId: string): Promise<ApiKeyPublicView> {
  const ref = adminDb.collection(COLLECTION).doc(keyId.trim());
  const snap = await runFirestoreGuarded("api-keys get " + keyId, () => ref.get());
  const data = snap.exists ? (snap.data() as ApiKeyDoc) : null;
  if (!data || data.ownerId !== ownerId) throw new HttpError(404, "Clé API introuvable pour ce compte.");
  if (data.revokedAt === null) {
    await runFirestoreGuarded("api-keys revoke", () => ref.update({ revokedAt: Date.now() }));
    data.revokedAt = Date.now();
  }
  return toPublicView(data);
}

/** Résout une clé par son hash (identifiant du document) — null si absente. */
async function getApiKeyByHash(keyHash: string): Promise<ApiKeyDoc | null> {
  const snap = await runFirestoreGuarded("api-keys auth", () => adminDb.collection(COLLECTION).doc(keyHash).get());
  return snap.exists ? (snap.data() as ApiKeyDoc) : null;
}

/** Extrait la clé `g3a_…` d'une requête (Bearer ou X-API-Key). Vide si absente. */
export function extractApiKey(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (bearer.startsWith(API_KEY_PREFIX)) return bearer;
  const header = request.headers.get("x-api-key")?.trim() ?? "";
  if (header.startsWith(API_KEY_PREFIX)) return header;
  return "";
}

/**
 * Authentifie une requête `/api/v1/**` par clé API entreprise.
 *
 * Retourne `null` si AUCUNE clé `g3a_` n'est présentée (l'appelant peut
 * alors basculer sur une autre chaîne — ex. développeur Firebase) ; lève
 * une HttpError typée si une clé est présentée mais invalide, révoquée,
 * hors scope ou hors quota.
 */
export async function authenticateApiKey(
  request: Request,
  requiredScope: ApiKeyScope,
): Promise<ApiKeyIdentity | null> {
  const key = extractApiKey(request);
  if (!key) return null;

  const record = await getApiKeyByHash(hashApiKey(key));
  if (!record || record.revokedAt !== null) {
    throw new HttpError(401, "Clé API invalide ou révoquée.");
  }
  if (!record.scopes.includes(requiredScope)) {
    throw new HttpError(403, `La clé API (${record.prefix}) n'autorise pas le scope « ${requiredScope} ».`);
  }

  // Quota par clé AVANT toute exécution métier (locale + par-instance).
  const limit = await enforceRateLimit(`apikey:${record.id}`, {
    limit: record.rateLimitPerMinute,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    throw new HttpError(429, `Quota de la clé API ${record.prefix} dépassé (${record.rateLimitPerMinute} req/min). Réessayez dans quelques secondes.`);
  }

  // Marquage best-effort du dernier usage (jamais bloquant pour la requête).
  void adminDb
    .collection(COLLECTION)
    .doc(record.id)
    .update({ lastUsedAt: Date.now() })
    .catch(() => undefined);

  return { userId: record.ownerId, keyId: record.id, prefix: record.prefix, scopes: record.scopes, via: "api_key" };
}
