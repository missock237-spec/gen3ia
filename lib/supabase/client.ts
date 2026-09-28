"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Client Supabase NAVIGATEUR (Task 40) — prêt pour la phase 2 (accès
 * client temps réel : présence, streams de runs, notifications push).
 *
 * État actuel : AUCUN code produit n'y accède (ADR-006 : la couche données
 * reste serveur-seul, clé anon gouvernée par la RLS deny-all). Ce module
 * est la seule porte d'entrée autorisée pour le navigateur quand une
 * fonctionnalité temps réel la justifiera — même rôle que lib/firebase/
 * client.ts pour le SDK Firebase.
 *
 * La clé anon est PUBLIQUE par conception : elle n'autorise que ce que les
 * politiques RLS accordent explicitement (migration 0002 : deny-all par
 * défaut tant que l'auth Supabase n'est pas activée).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();

export function hasSupabaseClientConfig(): boolean {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}

let browserClient: SupabaseClient | null = null;

/** Client navigateur singleton (null sans configuration — appelants dégradent). */
export function getSupabaseBrowser(): SupabaseClient | null {
  if (!hasSupabaseClientConfig()) return null;
  if (browserClient) return browserClient;
  browserClient = createBrowserClient(SUPABASE_URL!, SUPABASE_ANON_KEY!);
  return browserClient;
}
