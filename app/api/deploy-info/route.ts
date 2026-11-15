import { NextResponse } from "next/server";
import { readBuildId } from "@/lib/deploy/build-id";

/**
 * Empreinte du déploiement actif — carburant du rechargement automatique
 * (Task 51 + demande du 2026-10-22 : « à chaque mise à jour le navigateur
 * doit charger automatiquement la nouvelle version sans même que
 * l'utilisateur le sache »).
 *
 * Après chaque déploiement, les onglets ouverts (dont les PWA laissées
 * ouvertes pendant des jours) doivent pouvoir charger la nouvelle version
 * SANS navigation : DeployWatcher (components/deploy-watcher.tsx) sonde ce
 * point périodiquement et compare l'empreinte à celle relevée au chargement
 * de la page. Un écart = nouveau déploiement → rechargement transparent au
 * moment sûr (onglet caché, ou onglet qui passe en arrière-plan) ou
 * bannière à compte à rebours (onglet resté au premier plan).
 *
 * CORRECTION 2026-10-22 : sur le VPS auto-hébergé (déploiement continu
 * deploy-vps.yml → cd-finisher.sh), la chaîne historique
 * VERCEL_DEPLOYMENT_ID → GEN3IA_RELEASE retombait sur « local-dev » — une
 * empreinte CONSTANTE : le watcher ne détectait JAMAIS un nouveau
 * déploiement et les onglets ouverts restaient sur l'ancienne version.
 * L'empreinte est désormais le .next/BUILD_ID du build effectivement
 * servi (lib/deploy/build-id.ts) — régénéré par chaque build et swappé
 * atomiquement par chaque déploiement : il change à CHAQUE mise en
 * production, sur VPS comme partout ailleurs.
 *
 * Contraintes de conception :
 * - ULTRA-LÉGER : sondé toutes les ~90 s par chaque onglet ouvert. Une
 *   lecture d'un fichier de ~20 octets — aucun accès base de données,
 *   aucun SDK, aucune auth. NE JAMAIS y brancher Firebase ou toute autre
 *   dépendance : le coût du sondage resterait celui d'une vraie route
 *   applicative.
 * - Lu À LA REQUÊTE (jamais au chargement du module) : le swap atomique de
 *   .next par cd-finisher.sh doit être visible dès la requête suivante,
 *   même si le process n'a pas encore redémarré.
 * - JAMAIS CACHÉE : `no-store` — une empreinte servie depuis un cache
 *   navigateur/CDN ferait rater des déploiements (même raisonnement que
 *   l'étape 11 pour sw.js).
 * - Informations non sensibles : le BUILD_ID figure déjà dans les URL
 *   /_next/static/ de chaque page ; SHA et identifiants de déploiement
 *   sont publics (dépôt GitHub).
 * - Toujours 200 : la sonde distingue « empreinte » de « indisponible »
 *   côté client ; un échec est simplement retenté au prochain cycle.
 * - Repli conservateur : BUILD_ID illisible (dev sans build, disque)
 *   → GEN3IA_RELEASE → variables Vercel → « local-dev ». Le pire cas
 *   reste le comportement d'avant (empreinte stable), jamais pire.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Chaîne de repli : BUILD_ID servi → release générique (auto-hébergement)
 * → plateforme Vercel → environnement de développement local. Lu À LA
 * REQUÊTE (jamais au chargement du module) pour rester testable et suivre
 * l'environnement d'exécution réel.
 *
 * DURCISSEMENT 2026-10-22 : un repli en PRODUCTION est un INCIDENT — l'empreinte
 * devient stable, le watcher client redevient aveugle aux déploiements (le bug
 * d'origine, mais invisible). Le repli est désormais signalé (warn une fois par
 * process + Sentry si disponible) au lieu de passer inaperçu. */
let repliDejaSignale = false;

function signalerRepliEmpreinte(empreinte: string, cause: string): void {
  if (repliDejaSignale) return;
  repliDejaSignale = true;
  console.warn(
    `[DEPLOY] BUILD_ID illisible depuis ce process (${cause}) — empreinte de repli « ${empreinte} » utilisée : le rechargement automatique des onglets est AVEUGLE tant que le BUILD_ID n'est pas lisible. Vérifier le répertoire de travail de PM2 et les permissions de .next/BUILD_ID.`,
  );
  void import("@sentry/nextjs")
    .then((Sentry) => {
      Sentry.captureMessage(
        "deploy-info : empreinte de repli utilisée en production (BUILD_ID illisible)",
        { level: "warning", extra: { empreinte, cause } },
      );
    })
    .catch(() => {
      // Sentry indisponible (dev, bundle minimal) — le warn console suffit.
    });
}

function resolveDeploymentId(): string {
  const buildId = readBuildId();
  if (buildId) return buildId;
  const empreinte =
    process.env.GEN3IA_RELEASE ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    "local-dev";
  if (process.env.NODE_ENV === "production") {
    signalerRepliEmpreinte(empreinte, "fichier .next/BUILD_ID absent ou illisible");
  }
  return empreinte;
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
