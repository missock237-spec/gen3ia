import "server-only";

/**
 * Configuration Supabase — Task 40 (migration Firestore → PostgreSQL).
 *
 * Trois variables minimum pour activer le backend Supabase :
 * - NEXT_PUBLIC_SUPABASE_URL      : URL du projet (publique par conception)
 * - NEXT_PUBLIC_SUPABASE_ANON_KEY : clé anon (publique, gouvernée par RLS)
 * - SUPABASE_SERVICE_ROLE_KEY     : clé service-role (SECRET serveur,
 *   contourne la RLS — même modèle de confiance que firebase-admin)
 *
 * Modèle de confiance retenu (ADR-006) : la plateforme Gen3ia n'accède
 * JAMAIS aux données depuis le navigateur. Toute la couche données est
 * serveur-seul (routes API) — la clé anon est fournie pour les phases
 * futures (temps réel client, présence) mais aucun code produit ne la
 * consomme aujourd'hui. La clé service-role joue le rôle exact de
 * firebase-admin : le scoping utilisateur reste appliqué EXPLICITEMENT
 * dans les repositories, exactement comme avec Firestore aujourd'hui.
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string | undefined;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && value !== "undefined" && value !== "null" ? value : undefined;
}

let cachedConfig: SupabaseConfig | null = null;

export function getSupabaseConfig(): SupabaseConfig | null {
  if (cachedConfig) return cachedConfig;

  const url = envValue("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = envValue("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;

  cachedConfig = {
    url,
    anonKey,
    serviceRoleKey: envValue("SUPABASE_SERVICE_ROLE_KEY"),
  };
  return cachedConfig;
}

/** Supabase est-il opérationnel côté serveur (service-role requis) ? */
export function isSupabaseAdminConfigured(): boolean {
  const config = getSupabaseConfig();
  return Boolean(config?.url && config?.anonKey && config?.serviceRoleKey);
}

/** Variables Supabase attendues (rapport de configuration, jamais les valeurs). */
export const SUPABASE_ENV_VARS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;
