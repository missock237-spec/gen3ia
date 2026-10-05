import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";
import { withSentryConfig } from "@sentry/nextjs";

// Analyse du poids des bundles : ANALYZE=true npm run analyze
const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? bundleAnalyzer({ enabled: true })
    : (config: NextConfig): NextConfig => config;

// Content-Security-Policy : posée de manière centralisée par le middleware
// (middleware.ts), qui couvre toutes les réponses y compris les routes API —
// SAUF /preview/* qui reçoit une CSP « artefact » dédiée (les apps générées
// par l'agent chargent des CDN dans un iframe sandboxé).
// Ne pas redéclarer la CSP ici : deux en-têtes CSP = l'intersection s'applique.
//
// ⚠️ Cohérence des en-têtes : les valeurs posées ici DOIVENT rester
// strictement identiques à celles du middleware (middleware.ts). Un écart
// entre les deux sources produit deux en-têtes contradictoires et le
// navigateur applique l'intersection (ex. Permissions-Policy camera=() vs
// camera=(self) = micro/caméra cassés).

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Task 100 (déploiement 10-2025) : la phase « Linting and checking
  // validity of types » de next build faisait dépasser la RAM du conteneur
  // de build (OOM SIGKILL en local comme sur Vercel — compile OK en 3,7 min,
  // mort au type-check). Le type-check et le lint restent des BARRIÈRES
  // obligatoires, mais déplacées là où la mémoire suffit :
  //   1. CI GitHub Actions à CHAQUE push (.github/workflows/ci.yml :
  //      typecheck + lint + tests + audit + build + budget) ;
  //   2. local avant tout push : npm run typecheck + npm run lint
  //      (tsc --noEmit = 0 erreur requis).
  // Le build Vercel compile et bundle uniquement — aucune perte de garantie
  // sur les types, l'exécution CI fait foi.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: true },
  // Production uniquement : console.* est retiré du bundle (moins de code,
  // pas de logs de debug en exploitation) — error/warn conservés.
  compiler: {
    removeConsole: { exclude: ["error", "warn"] },
  },
  // Les sous-services (tâches planifiées, workflows, automatisations) sont
  // exécutés par les agents IA : l'utilisateur décrit son besoin en langage
  // naturel dans la conversation. Les anciennes pages redirigent donc vers
  // l'espace de conversation, point d'entrée unique de l'exécution.
  async redirects() {
    return [
      { source: "/studio/schedules", destination: "/workspace/conversations", permanent: false },
      { source: "/studio/automations", destination: "/workspace/conversations", permanent: false },
      { source: "/workspace/workflows", destination: "/workspace/conversations", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Identique au middleware (audit 09-2026 : HSTS unifié, éligible
          // preload : 2 ans + sous-domaines + preload).
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          // Identique au middleware — Live Voice (micro/caméra) autorisé en
          // same-origin, géolocalisation refusée. NE JAMAIS diverger du
          // middleware : deux valeurs différentes = intersection navigateur.
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), display-capture=(self), geolocation=()" },
          // DENY sur l'application (double verrou avec CSP frame-ancestors
          // 'none') ; seule la surface /preview reçoit SAMEORIGIN via le
          // middleware — la modale d'aperçu d'artefacts l'y intègre en
          // iframe same-origin.
          { key: "X-Frame-Options", value: "DENY" },
          // Isolation cross-origin : les onglets tiers ne peuvent pas référencer
          // la fenêtre Gen3ia (mitigation Spectre / XS-Leaks). « allow-popups »
          // conserve le flux OAuth Google (popup + postMessage).
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
          // Les ressources Gen3ia ne se chargent pas depuis un document
          // cross-origin (protection contre l'embarquement d'assets).
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          // Réduction du bruit réseau sortant au survol des liens.
          { key: "X-DNS-Prefetch-Control", value: "off" },
        ],
      },
      // Politique de cache statique (étape 19 — perf) : les icônes et
      // l'image Open Graph sont versionnées (?v=g3-logo-1 / fichier
      // remplacé au déploiement) → cache navigateur long + stale-while-
      // revalidate : revisites instantanées, périmé de quelques heures
      // maximum auto-corrigé en arrière-plan. Le manifeste (méta
      // d'installabilité) reste frais 1 h puis revalidé périmé.
      {
        source: "/icons/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        source: "/og-image.png",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        source: "/manifest.webmanifest",
        headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }],
      },
      // SDK public (.tgz servi depuis /public/sdk) et corpus llms.txt /
      // llms-full.txt : fichiers quasi immuables — cache long + stale-while-
      // revalidate (téléchargements SDK et robots d'agents ne re-téléchargent
      // plus à chaque visite ; périmé auto-corrigé en arrière-plan).
      {
        source: "/sdk/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        source: "/llms.txt",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      {
        source: "/llms-full.txt",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
      // Justesse des mises à jour PWA (étape 11) : le service worker et la
      // page hors-ligne DOIVENT être revalidés à chaque visite — un sw.js
      // servi depuis un cache navigateur ferait rater toutes les mises à
      // jour suivantes (le navigateur plafonne sinon sa vérification à 24 h).
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      {
        source: "/offline.html",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
    ];
  },
  images: {
    // Formats modernes servis par l'optimiseur : AVIF (-50 % vs JPEG à
    // qualité égale) puis WebP en repli — LCP des visuels amélioré.
    formats: ["image/avif", "image/webp"],
    // Durée de cache des images optimisées (31 jours) : les visuels du
    // produit changent rarement, l'optimiseur n'est pas ré-invoqué à chaque
    // requête (capacité edge, latence P75 des images en baisse).
    minimumCacheTTL: 2_678_400,
    // Sources distantes légitimes du produit (next/image refuse tout le
    // reste) : stockage Firebase (deux domaines selon l'âge du bucket),
    // S3 (documents importés), avatars Google/GitHub des comptes OAuth,
    // qdrant.io réservé (intégrations futures, demandé par l'audit).
    remotePatterns: [
      { protocol: "https", hostname: "firebasestorage.googleapis.com" },
      { protocol: "https", hostname: "*.firebasestorage.app" },
      { protocol: "https", hostname: "*.s3.amazonaws.com" },
      { protocol: "https", hostname: "**.qdrant.io" },
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
  // Tree-shaking agressif des imports en barrel (index.ts réexportant tout) :
  // seuls les modules réellement utilisés entrent dans le bundle client.
  experimental: {
    optimizePackageImports: ["@monaco-editor/react", "openai", "@vercel/analytics"],
  },
  // La config web Firebase est fournie directement via les variables
  // NEXT_PUBLIC_FIREBASE_* (inlinees par Next.js a build time).
  // ⚠️ Ne PAS remapper FIREBASE_* (projet ADMIN "gen3ia") vers NEXT_PUBLIC_*
  // : cela inlinerait le mauvais projectId et casserait la verification des
  // ID tokens (mismatch iss/aud) en production.
  // Packages reposant sur des API Node.js et/ou lourds : ils restent
  // EXTERNES au bundle serveur (sinon Next tente de les bundler et les
  // fonctions dépassent la taille maximale / cassent à l'exécution).
  // Audit 09-2026 : générateurs de documents + zip + client Qdrant ajoutés.
  serverExternalPackages: [
    "firebase-admin",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "@qdrant/js-client-rest",
    "pino",
    "exceljs",
    "docx",
    "pptxgenjs",
    "pdf-lib",
    "archiver",
    "yauzl",
    "@supabase/supabase-js",
    // OpenTelemetry (Task 59) : SDK chargé dynamiquement UNIQUEMENT quand
    // OTEL_EXPORTER_OTLP_ENDPOINT est défini — reste externe au bundle pour
    // préserver les hooks de contexte Node (async_hooks) et la taille serverless.
    "@opentelemetry/sdk-node",
    "@opentelemetry/exporter-trace-otlp-http",
    "@opentelemetry/exporter-metrics-otlp-http",
    "@opentelemetry/resources",
    // Binaires statiques FFmpeg/ffprobe (Task 1-a) : embarquent de VRAIS
    // exécutables — ils doivent rester externes au bundle (le bundler ne
    // doit ni les inliner ni casser leurs chemins node_modules).
    "ffmpeg-static",
    "ffprobe-static",
  ],
  // NOTE (constat production 4 oct.) : PAS de outputFileTracingIncludes par
  // motifs — sur le plan Hobby (limite 12 fonctions serverless), ce réglage
  // éclate le bundle en fonctions séparées et le déploiement échoue
  // (exceeded_serverless_functions_per_deployment). Le binaire est résolu
  // par repli de TÉLÉCHARGEMENT RUNTIME dans /tmp (lib/video/security.ts).
};

/**
 * Sentry (Task 40) : upload des source maps au build + sourceBundleFiles.
 * L'AUTH TOKEN est un secret de build (Vercel) — sans lui, le build reste
 * vert et seuls les stacks minifiés sont remontés (dégradation assumée).
 * `silent` : l'upload n'inonde pas les logs Vercel ; `disableLogger` :
 * aucun console.log injecté en production ; `widenClientFileUpload` :
 * inclut les chunks partagés (stacks client complets).
 * Note : pas de tunnelRoute ici — le tunnel est un route handler dédié
 * (app/monitoring/route.ts) branché côté client (instrumentation-client.ts).
 */
export default withSentryConfig(withBundleAnalyzer(nextConfig), {
  org: process.env.SENTRY_ORG || "gen3ia",
  project: process.env.SENTRY_PROJECT || "javascript-nextjs",
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: { name: process.env.SENTRY_RELEASE || process.env.VERCEL_GIT_COMMIT_SHA },
  sourcemaps: {
    disable: !process.env.SENTRY_AUTH_TOKEN,
    deleteSourcemapsAfterUpload: true,
  },
  widenClientFileUpload: true,
  disableLogger: true,
  silent: !process.env.CI,
  telemetry: false,
});
