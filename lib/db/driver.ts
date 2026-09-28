import "server-only";

import { isSupabaseAdminConfigured } from "@/lib/supabase/config";
import { resolveProfileFromToken } from "@/lib/supabase/auth-bridge";

/**
 * Sélecteur de backend de données — Task 40 (ADR-006).
 *
 * DATA_BACKEND contrôle la bascule Firestore ⇄ Supabase PARS repository
 * piloté (phase 1 : notifications). Valeurs :
 *   - "firebase" (défaut) : comportement actuel, zéro changement.
 *   - "supabase" : les repositories pilotés lisent/écrivent dans Postgres.
 *
 * Garde-fous :
 *   1. La bascule est silencieusement REJETÉE (repli firebase) si Supabase
 *      n'est pas configuré — un flag oublié ne peut pas casser la prod.
 *   2. Chaque repository piloté décide de sa participation : tant qu'un
 *      domaine n'est pas migré, il ignore ce module (Firestore direct).
 *   3. Le pilote notifications conserve la sémantique exacte (zod, cache
 *      Redis, best-effort) — seul le stockage change.
 *
 * Phases (docs/migration-supabase.md) :
 *   P1  infrastructure + pilote (ce module) — flag off
 *   P2  double-écriture + backfill par lots — flag par domaine
 *   P3  lectures Supabase → cutover → retrait Firestore
 */

export type DataBackend = "firebase" | "supabase";

export interface DataBackendInfo {
  backend: DataBackend;
  /** La demande explicite DATA_BACKEND=supabase a été honorée ? */
  requestedSupabase: boolean;
  supabaseConfigured: boolean;
}

export function resolveDataBackendInfo(env: NodeJS.ProcessEnv = process.env): DataBackendInfo {
  const requested = env.DATA_BACKEND?.trim().toLowerCase() === "supabase";
  const configured = isSupabaseAdminConfigured();
  return {
    backend: requested && configured ? "supabase" : "firebase",
    requestedSupabase: requested,
    supabaseConfigured: configured,
  };
}

/** Raccourci booléen pour les repositories pilotés. */
export function isSupabaseBackend(): boolean {
  return resolveDataBackendInfo().backend === "supabase";
}

// ---------------------------------------------------------------------------
// Résolution uid Firebase → profile_id Postgres (cache TTL process-local)
// ---------------------------------------------------------------------------

const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min : l'identité est stable
const profileIdCache = new Map<string, { profileId: string | null; cachedAt: number }>();
const PROFILE_CACHE_MAX = 10_000;

export interface IdentityForBackend {
  uid: string;
  email?: string;
  name?: string;
  picture?: string;
  provider?: string;
}

/**
 * Résout (et provisionne à la volée) le profil Postgres d'un uid Firebase.
 * Cache process-local 5 min — un utilisateur actif ne déclenche qu'une
 * résolution par fenêtre, les requêtes suivantes sont locales.
 * Retourne null si Supabase est absent OU si le provisionnement échoue :
 * l'appelant replie sur Firestore (jamais de crash pour un pont).
 */
export async function resolveProfileId(identity: IdentityForBackend): Promise<string | null> {
  const info = resolveDataBackendInfo();
  if (!info.supabaseConfigured) return null;

  const cached = profileIdCache.get(identity.uid);
  if (cached && Date.now() - cached.cachedAt < PROFILE_CACHE_TTL_MS) {
    return cached.profileId;
  }

  try {
    const profile = await resolveProfileFromToken({
      uid: identity.uid,
      email: identity.email,
      name: identity.name,
      picture: identity.picture,
      firebase: { sign_in_provider: identity.provider ?? "unknown" },
    });
    const profileId = profile?.id ?? null;

    if (profileIdCache.size >= PROFILE_CACHE_MAX) {
      // Éviction simple (map ordonnée par insertion) : purge le plus ancien.
      const oldest = profileIdCache.keys().next().value;
      if (oldest) profileIdCache.delete(oldest);
    }
    profileIdCache.set(identity.uid, { profileId, cachedAt: Date.now() });
    return profileId;
  } catch {
    // Pont en échec : ne pas cacher l'erreur, retenter à la requête suivante.
    return null;
  }
}

/** Vide le cache (tests uniquement). */
export function resetProfileCacheForTests(): void {
  profileIdCache.clear();
}
