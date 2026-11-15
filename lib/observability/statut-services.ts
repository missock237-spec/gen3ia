import "server-only";

import { readBuildId } from "@/lib/deploy/build-id";
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

/**
 * Sonde AUTH (corrigée 2026-10-28, Job 478451) — mesure la VRAIE voie
 * d'authentification servie aux utilisateurs, plus une dépendance legacy :
 *
 *   · e-mail + mot de passe (voie principale) : comptes scrypt stockés
 *     dans R2 (lib/auth/r2-accounts.ts) + cookie de session signé
 *     (lib/server/session-cookie.ts) — vit et meurt avec R2 ;
 *   · Google : SDK client Firebase + vérification JWT du serveur contre
 *     les certificats PUBLICS Google (lib/firebase/auth-server.ts) —
 *     aucun compte de service requis.
 *
 * L'ancienne sonde appelait getAdminApp() (compte de service Firebase
 * Admin) : en production ce composant n'est requis par AUCUN flux
 * utilisateur (uniquement des outils d'admin ponctuels — migration
 * Firestore→R2, suppression de compte Firebase). Un VPS sans
 * FIREBASE_PRIVATE_KEY affichait donc publiquement « Authentification :
 * dégradé » et des 503 aux moniteurs d'uptime ALORS QUE la connexion
 * fonctionnait (constaté en production le 2026-10-28 : login R2 répond
 * 401 structuré, /api/status = 503). Désinformation d'état corrigée.
 */
function authHealth(r2: ServiceHealth): ServiceHealth {
  // Voie principale e-mail/mot de passe : si R2 est indisponible, la
  // connexion par identifiants l'est aussi — auth suit la panne avec la
  // même raison (diagnostic unique côté exploitation).
  if (!r2.ok) return { ok: false, reason: r2.reason ?? "r2-indisponible" };
  return { ok: true };
}

/** Sondes complètes (R2 borné 3 s — la page et la JSON partagent le contrat). */
export async function sonderServices(): Promise<StatutServices> {
  // R2 est sondé UNE fois : il fonde à la fois le service « r2 » et le
  // service « ticks » (les tickets vivent dans le même bucket).
  const r2 = await pingR2(3_000);
  const ticks: ServiceHealth = tickQueueConfigured()
    ? { ok: r2.ok, reason: r2.reason }
    : { ok: false, reason: "not_configured" };
  const auth = authHealth(r2);

  const services = { auth, r2, ticks };
  const degraded = !auth.ok || !r2.ok || !ticks.ok;

  return {
    status: degraded ? "degraded" : "ok",
    version: resolverVersion(),
    services,
    checkedAt: new Date().toISOString(),
  };
}
