import { NextResponse } from "next/server";

/**
 * Empreinte du déploiement actif — carburant du rechargement automatique
 * (Task 51).
 *
 * Après chaque build Vercel, les onglets ouverts (dont les PWA laissées
 * ouvertes pendant des jours) doivent pouvoir charger la nouvelle version
 * SANS navigation : DeployWatcher (components/deploy-watcher.tsx) sonde ce
 * point périodiquement et compare l'empreinte à celle relevée au chargement
 * de la page. Un écart = nouveau déploiement → bannière à compte à rebours
 * annulable (onglet visible) ou rechargement transparent (onglet caché).
 *
 * Contraintes de conception :
 * - ULTRA-LÉGER : sondé toutes les ~90 s par chaque onglet ouvert. Aucun
 *   accès base de données, aucun SDK, aucune auth — une lecture de
 *   variables d'environnement système Vercel (injectées par la plateforme
 *   au runtime) et une réponse JSON. NE JAMAIS y brancher Firebase ou
 *   toute autre dépendance : le coût du sondage resterait celui d'une
 *   vraie route applicative.
 * - JAMAIS CACHÉE : `no-store` — une empreinte servie depuis un cache
 *   navigateur/CDN ferait rater des déploiements (même raisonnement que
 *   l'étape 11 pour sw.js).
 * - Informations non sensibles : identifiant de déploiement et SHA de
 *   commit sont publics (dépôt GitHub, dashboard Vercel).
 * - Toujours 200 : la sonde distingue « empreinte » de « indisponible »
 *   côté client ; un échec est simplement retenté au prochain cycle.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Chaîne de repli : Vercel (déploiement puis commit) → release générique
 * (auto-hébergement) → environnement de développement local. Lu À LA
 * REQUÊTE (jamais au chargement du module) pour rester testable et suivre
 * l'environnement d'exécution réel. */
function resolveDeploymentId(): string {
  return (
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GEN3IA_RELEASE ||
    "local-dev"
  );
}

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      deploymentId: resolveDeploymentId(),
      generatedAt: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
