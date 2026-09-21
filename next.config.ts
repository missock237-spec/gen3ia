import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

// Analyse du poids des bundles : ANALYZE=true npm run analyze
const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? bundleAnalyzer({ enabled: true })
    : (config: NextConfig): NextConfig => config;

// Content-Security-Policy pragmatique pour la stack Gen3ia :
// - Next.js requiert 'unsafe-inline' (scripts d'hydratation inline) ;
// - Firebase Auth / Identity Toolkit : apis.google.com, gstatic, googleapis ;
// - connect-src ouvert https:/wss: (Firestore, Composio, Sentry, webhooks) —
//   resserrement possible après audit des domaines réellement appelés.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://apis.google.com https://www.gstatic.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://apis.google.com https://*.firebaseapp.com https://accounts.google.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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
          { key: "Content-Security-Policy", value: CSP },
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
