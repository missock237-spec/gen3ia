import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseConfig, isSupabaseAdminConfigured } from "./config";

/**
 * Client Supabase SERVICE-ROLE (Task 40) — l'équivalent direct de
 * lib/firebase/admin.ts : accès total aux données, RLS contournée.
 *
 * ⚠️ Contrat de sécurité (identique à firebase-admin) :
 * 1. Ce module est "server-only" — jamais importé côté client ;
 * 2. Tout appelant filtre EXPLICITEMENT par uid utilisateur (owner_id,
 *    user_id) comme les repositories Firestore le font aujourd'hui ;
 * 3. La RLS reste active en base comme filet défensif (migration 0002) :
 *    si un code serveur oubliait son scoping, la politique deny-all par
 *    défaut ne protège pas le service-role — c'est le rôle des tests de
 *    repository + de la revue. La RLS couvre la clé anon (futur accès
 *    client temps réel).
 *
 * Singleton par process : le SDK maintient son pool HTTP (undici) —
 * une instance par requête épuiserait les sockets comme le ferait un
 * admin Firestore par requête.
 */

let adminClient: SupabaseClient | null = null;

/**
 * Client service-role singleton. Retourne null si la configuration est
 * absente — les appelants doivent dégrader proprement (repli Firestore,
 * mode DATA_BACKEND=firebase).
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (!isSupabaseAdminConfigured()) return null;
  if (adminClient) return adminClient;

  const config = getSupabaseConfig()!;
  adminClient = createClient(config.url, config.serviceRoleKey!, {
    auth: {
      // Le produit n'utilise PAS Supabase Auth en phase 1 (Firebase Auth
      // conservé, ADR-006) : aucune session à maintenir ici.
      persistSession: false,
      autoRefreshToken: false,
    },
    global: {
      headers: {
        // Traçabilité : chaque requête service-role est identifiable dans
        // les logs Postgres (corrélation avec les trace-id middleware).
        "x-gen3ia-surface": "server-admin",
      },
    },
  });
  return adminClient;
}

/** Réinitialise le singleton (tests uniquement). */
export function resetSupabaseAdminForTests(): void {
  adminClient = null;
}
