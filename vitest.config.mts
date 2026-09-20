import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { defineConfig } from "vitest/config";

// A throwaway but cryptographically valid RSA key: firebase-admin `cert()`
// parses the PEM at import time, so a malformed dummy would throw.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dummyPrivateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      // `server-only` is a build-time guard that throws outside React Server
      // Components. Unit tests run in plain Node, so stub it out.
      "server-only": path.resolve(import.meta.dirname, "vitest/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "lib/__tests__/**/*.test.ts", "app/**/*.test.ts"],
    env: {
      // Dummy Firebase Admin credentials so server modules that initialize
      // Firestore at import time can be loaded without network access.
      FIREBASE_PROJECT_ID: "test-project",
      FIREBASE_CLIENT_EMAIL: "test@test-project.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: dummyPrivateKeyPem,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      // Périmètre soumis au seuil minimal : les fichiers couverts par la
      // suite actuelle (facturation pure, routage IA, garde de route).
      // Étendre cette liste à mesure que de nouveaux modules sont testés.
      include: [
        "lib/billing/cost-engine.ts",
        "lib/billing/tool-meter.ts",
        "lib/ai/router.ts",
        "lib/security/route-guard.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.d.ts", "lib/security/rate-limit.ts"],
      thresholds: {
        lines: 70,
        functions: 60,
        branches: 60,
        statements: 70,
      },
    },
  },
});
