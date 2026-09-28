import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseConfig } from "./config";

/**
 * Client Supabase ANON côté serveur (Task 40).
 *
 * Rôle distinct du service-role (admin.ts) : ce client respecte la RLS.
 * Il servira en phase 2/3 de la migration (ADR-006) quand les politiques
 * RLS seront ouvertes avec Supabase Auth — par exemple pour valider un
 * jeton Supabase ou lire des tables explicitement publiques.
 *
 * Aucun secret : utilise uniquement les variables publiques.
 */

let anonClient: SupabaseClient | null = null;

/** Client anon serveur (null sans configuration). */
export function getSupabaseAnon(): SupabaseClient | null {
  const config = getSupabaseConfig();
  if (!config) return null;
  if (anonClient) return anonClient;

  anonClient = createClient(config.url, config.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return anonClient;
}
