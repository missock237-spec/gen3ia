import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

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
  ],
};

export default withBundleAnalyzer(nextConfig);
