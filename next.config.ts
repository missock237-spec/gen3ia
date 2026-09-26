import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

// Analyse du poids des bundles : ANALYZE=true npm run analyze
const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? bundleAnalyzer({ enabled: true })
    : (config: NextConfig): NextConfig => config;

// Content-Security-Policy : posée de manière centralisée par le middleware
// (proxy.ts), qui couvre toutes les réponses y compris les routes API.
// Ne pas redéclarer ici : deux en-têtes CSP = l'intersection s'applique.

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
          { key: "Strict-Transport-Security", value: "max-age=63072000" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
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
  // La config web Firebase est fournie directement via les variables
  // NEXT_PUBLIC_FIREBASE_* (inlinees par Next.js a build time).
  // ⚠️ Ne PAS remapper FIREBASE_* (projet ADMIN "gen3ia") vers NEXT_PUBLIC_*
  // : cela inlinerait le mauvais projectId et casserait la verification des
  // ID tokens (mismatch iss/aud) en production.
  // Firebase Admin, AWS SDK and pino rely on Node.js APIs and must stay external
  // to the server bundle for correct behaviour on Vercel.
  serverExternalPackages: [
    "firebase-admin",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "pino",
    "exceljs",
  ],
};

export default withBundleAnalyzer(nextConfig);
