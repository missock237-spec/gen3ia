import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseAdmin } from "./admin";

/**
 * Pont d'identité Firebase Auth → Supabase (Task 40, ADR-006).
 *
 * DÉCISION D'ARCHITECTURE : en phase 1, Firebase RESTE le fournisseur
 * d'identité (IdP) — OAuth Google/GitHub opérationnel, cookies de session
 * signés, vérification RS256 en production (lib/firebase/auth-server.ts).
 * Supabase devient la base de DONNÉES. Le pont réconcilie les deux :
 *
 *   Firebase UID (subject du JWT vérifié)  ⇄  profiles.firebase_uid
 *
 * Chaque requête authentifiée (verifyFirebaseAuth) résout l'uid, puis les
 * repositories Supabase opèrent sur le profil lié. La table profiles est
 * synchronisée à la volée (upsert idempotent) au premier contact d'un
 * utilisateur avec le backend Postgres — aucune migration de masse
 * obligatoire, la réplication à froid se fait utilisateur par utilisateur.
 *
 * Phase 3 (optionnelle, documentée docs/migration-supabase.md) : bascule
 * de l'IdP vers Supabase Auth (users.auth.users) et retrait du pont.
 */

export interface IdentityProfile {
  firebaseUid: string;
  email: string | null;
  displayName: string | null;
  photoUrl: string | null;
  provider: string;
}

/** Rangée de la table profiles (types générés en phase 2 ; scoping volontaire). */
export interface ProfileRow {
  id: string;
  firebase_uid: string;
  email: string | null;
  display_name: string | null;
  photo_url: string | null;
  provider: string | null;
  is_platform_admin: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Résout le profil Postgres d'un uid Firebase, en le provisionnant à la
 * volée si nécessaire (upsert idempotent, conflit sur firebase_uid).
 * Retourne null si Supabase n'est pas configuré (repli Firestore appelant).
 */
export async function resolveProfileByFirebaseUid(
  identity: IdentityProfile,
): Promise<ProfileRow | null> {
  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data: existing, error: selectError } = await supabase
    .from("profiles")
    .select("*")
    .eq("firebase_uid", identity.firebaseUid)
    .maybeSingle();

  if (selectError) throw new Error(`resolveProfile select: ${selectError.message}`);
  if (existing) {
    // Rafraîchissement discret des attributs d'identité (email/_nom/photo)
    // quand ils ont changé côté Firebase — pas de réécriture inutile.
    const row = existing as ProfileRow;
    const drifted =
      (identity.email && identity.email !== row.email) ||
      (identity.displayName && identity.displayName !== row.display_name) ||
      (identity.photoUrl && identity.photoUrl !== row.photo_url);
    if (!drifted) return row;

    const { data: updated, error: updateError } = await supabase
      .from("profiles")
      .update({
        email: identity.email ?? row.email,
        display_name: identity.displayName ?? row.display_name,
        photo_url: identity.photoUrl ?? row.photo_url,
        provider: identity.provider,
      })
      .eq("id", row.id)
      .select("*")
      .single();
    if (updateError) throw new Error(`resolveProfile update: ${updateError.message}`);
    return updated as ProfileRow;
  }

  // Premier contact : provisioning (l'utilisateur peut exister dans Firebase
  // depuis longtemps — la migration est incrémentale par conception).
  const { data: created, error: insertError } = await supabase
    .from("profiles")
    .insert({
      firebase_uid: identity.firebaseUid,
      email: identity.email,
      display_name: identity.displayName,
      photo_url: identity.photoUrl,
      provider: identity.provider,
    })
    .select("*")
    .single();

  if (insertError) {
    // Course concurrente (deux requêtes provisionnent le même uid en
    // parallèle) : relire l'état gagnant.
    const { data: raced, error: reselectError } = await supabase
      .from("profiles")
      .select("*")
      .eq("firebase_uid", identity.firebaseUid)
      .maybeSingle();
    if (reselectError || !raced) {
      throw new Error(`resolveProfile insert: ${insertError.message}`);
    }
    return raced as ProfileRow;
  }

  return created as ProfileRow;
}

/** Raccourci : résout depuis un DecodedIdToken-like (uid + claims). */
export async function resolveProfileFromToken(
  token: { uid: string; email?: string; name?: string; picture?: string; firebase?: { sign_in_provider?: string } },
): Promise<ProfileRow | null> {
  return resolveProfileByFirebaseUid({
    firebaseUid: token.uid,
    email: token.email ?? null,
    displayName: token.name ?? null,
    photoUrl: token.picture ?? null,
    provider: token.firebase?.sign_in_provider ?? "unknown",
  });
}

/** Types utilitaires exportés pour les repositories pilotés Supabase. */
export type { SupabaseClient };
