import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

// Analyse du poids des bundles : ANALYZE=true npm run analyze
const withBundleAnalyzer =
  process.env.ANALYZE === "true"
    ? bundleAnalyzer({ enabled: true })
    : (config: NextConfig): NextConfig => config;

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
