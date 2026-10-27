import "server-only";

import { readBuildId } from "@/lib/deploy/build-id";
import { getAdminApp } from "@/lib/firebase/admin";
import { pingR2 } from "@/lib/storage/r2";
import { tickQueueConfigured } from "@/lib/queue/tick-queue";

/**
 * SONDES DE STATUT PARTAGÉES (durcissement production) — source unique pour
 * la sonde JSON /api/status (moniteurs d'uptime) ET la page publique /status
 * (transparence de service lisible par les utilisateurs). Un seul code, deux
 * surfaces : toute évolution des sondes reste cohérente.
 *
 * AUCUNE donnée utilisateur, AUCUN secret dans les résultats : uniquement des
 * booléens et des raisons stables ("not_configured" | "timeout" | "error").
 */

export interface ServiceHealth {
  ok: boolean;
  /** Raison stable de dégradation : "not_configured" | "timeout" | "error". */
  reason?: string;
}

export interface StatutServices {
  status: "ok" | "degraded";
  version: string;
  services: {
    auth: ServiceHealth;
    r2: ServiceHealth;
    ticks: ServiceHealth;
  };
  checkedAt: string;
}

function resolverVersion(): string {
  // Empreinte de version — même chaîne que /api/deploy-info : le BUILD_ID
  // effectivement servi d'abord (change à CHAQUE déploiement VPS), puis les
  // replis historiques (l'ancienne chaîne Vercel seule retombait sur
  // « local-dev » constant sur le VPS auto-hébergé).
  return (
    readBuildId() ||
    process.env.GEN3IA_RELEASE ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "local-dev"
  );
}

function authHealth(): ServiceHealth {
  try {
    getAdminApp();
    return { ok: true };
  } catch {
    return { ok: false, reason: "not_configured" };
  }
}

/** Sondes complètes (R2 borné 3 s — la page et la JSON partagent le contrat). */
export async function sonderServices(): Promise<StatutServices> {
  // R2 est sondé UNE fois : il fonde à la fois le service « r2 » et le
  // service « ticks » (les tickets vivent dans le même bucket).
  const r2 = await pingR2(3_000);
  const ticks: ServiceHealth = tickQueueConfigured()
    ? { ok: r2.ok, reason: r2.reason }
    : { ok: false, reason: "not_configured" };
  const auth = authHealth();

  const services = { auth, r2, ticks };
  const degraded = !auth.ok || !r2.ok || !ticks.ok;

  return {
    status: degraded ? "degraded" : "ok",
    version: resolverVersion(),
    services,
    checkedAt: new Date().toISOString(),
  };
}
