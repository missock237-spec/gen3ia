import "server-only";

import { logger } from "@/lib/observability/logger";
import { isSupabaseAdminConfigured } from "@/lib/supabase/config";
import { isSupabaseBackend } from "@/lib/db/driver";

/**
 * Double-écriture Firestore ⇄ Supabase — Phase P2 (ADR-006, Task 43).
 *
 * Principe (docs/migration-supabase.md, P2) : Firestore reste la VÉRITÉ,
 * Supabase reçoit un MIROIR best-effort des écritures. Les lectures ne
 * bougent PAS (P3 fera le cutover). Un échec de miroir ne peut JAMAIS
 * bloquer le flux métier ni corrompre la vérité Firestore.
 *
 * Activation par DOMAINE : DUAL_WRITE_DOMAINS="notifications,artifacts"
 * (liste CSV, défaut vide = miroir désactivé partout). Un domaine non
 * inscrit conserve son chemin Firestore pur — zéro changement.
 *
 * Gardes de sécurité :
 *   1. Supabase non configuré (service-role absent) → miroir OFF.
 *   2. DATA_BACKEND=supabase → miroir OFF (le repository écrit DÉJÀ dans
 *      Postgres comme backend principal — dupliquer serait absurde).
 *   3. `mirrorToSupabase` ne lève JAMAIS : échec journalisé (pino warn),
 *      compteur incrémenté, valeur `null` retournée.
 *
 * Observabilité : `getDualWriteStats()` expose par domaine les compteurs
 * (tentatives, succès, échecs, dernière erreur) — consommé par
 * GET /api/health/infra (section dualWrite). La réconciliation finale
 * reste assurée par le backfill idempotent + checksums (scripts/backfill_supabase.ts).
 */

export const DUAL_WRITE_DOMAINS_ENV = "DUAL_WRITE_DOMAINS";

/** Domaines pilotés éligibles au miroir (P2 — ordre recommandé du guide). */
export type DualWriteDomain = "notifications" | "artifacts" | "conversations" | "agents" | "teams" | "wallet";

const KNOWN_DOMAINS: readonly DualWriteDomain[] = [
  "notifications",
  "artifacts",
  "conversations",
  "agents",
  "teams",
  "wallet",
];

// ---------------------------------------------------------------------------
// Résolution des domaines inscrits (cache process-local, invalidable tests)
// ---------------------------------------------------------------------------

let cachedDomains: Set<string> | null = null;

/** Parse la variable DUAL_WRITE_DOMAINS (CSV, insensible à la casse).
 * Les domaines inconnus (typo) sont FILTRÉS : une variable mal formée ne
 * peut pas inscrire silencieusement un domaine inexistant. */
export function parseDualWriteDomains(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  const tokens = raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => (KNOWN_DOMAINS as readonly string[]).includes(token));
  return new Set(tokens);
}

function resolveEnrolledDomains(): Set<string> {
  if (cachedDomains) return cachedDomains;
  cachedDomains = parseDualWriteDomains(process.env[DUAL_WRITE_DOMAINS_ENV]);
  return cachedDomains;
}

/**
 * Le miroir est-il actif pour ce domaine ?
 * Actif seulement si : domaine inscrit ET Supabase configuré ET Firestore
 * est le backend principal (en mode supabase, l'écriture primaire existe déjà).
 */
export function isDualWriteEnabled(domain: DualWriteDomain): boolean {
  if (!resolveEnrolledDomains().has(domain)) return false;
  if (!isSupabaseAdminConfigured()) return false;
  if (isSupabaseBackend()) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Miroir best-effort + statistiques
// ---------------------------------------------------------------------------

export interface DualWriteDomainStats {
  attempted: number;
  ok: number;
  failed: number;
  lastError: string | null;
  lastErrorAt: string | null;
}

const stats = new Map<string, DualWriteDomainStats>();

function statsFor(domain: string): DualWriteDomainStats {
  let entry = stats.get(domain);
  if (!entry) {
    entry = { attempted: 0, ok: 0, failed: 0, lastError: null, lastErrorAt: null };
    stats.set(domain, entry);
  }
  return entry;
}

export interface MirrorOutcome {
  /** "ok" = miroir écrit ; "failed" = erreur journalisée ; "skipped" = inactif. */
  status: "ok" | "failed" | "skipped";
  error?: string;
}

/**
 * Exécute une écriture miroir best-effort pour un domaine inscrit.
 * - domaine inactif → { status: "skipped" } sans exécuter `op` (coût nul) ;
 * - échec → journalisé (pino), compteur failed, JAMAIS levé.
 */
export async function mirrorToSupabase(
  domain: DualWriteDomain,
  op: () => Promise<void>,
): Promise<MirrorOutcome> {
  if (!isDualWriteEnabled(domain)) return { status: "skipped" };

  const entry = statsFor(domain);
  entry.attempted += 1;
  try {
    await op();
    entry.ok += 1;
    return { status: "ok" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    entry.failed += 1;
    entry.lastError = message.slice(0, 300);
    entry.lastErrorAt = new Date().toISOString();
    logger.warn({ domain, error: message }, "dual_write_mirror_failed");
    return { status: "failed", error: message };
  }
}

/** Instantané des statistiques (pour /api/health/infra — jamais de valeurs sensibles). */
export function getDualWriteStats(): Record<string, DualWriteDomainStats> {
  return Object.fromEntries(stats);
}

/** Domaines inscrits tels que résolus (diagnostic, sans secret). */
export function getDualWriteDomains(): string[] {
  return [...resolveEnrolledDomains()];
}

/** Réinitialise caches et compteurs (tests uniquement). */
export function resetDualWriteForTests(): void {
  cachedDomains = null;
  stats.clear();
}
