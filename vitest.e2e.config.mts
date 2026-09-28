import path from "node:path";
import { generateKeyPairSync } from "node:crypto";

import { defineConfig } from "vitest/config";

/**
 * Configuration vitest DÉDIÉE aux tests e2e Firebase (dossier e2e/).
 *
 * Ces tests exigent les émulateurs Firebase (auth 9099 + firestore 8080) :
 * ils ne participent JAMAIS au run unitaire principal (vitest.config.mts)
 * ni à la couverture. Ils sont exécutés via :
 *   npm run test:e2e   (firebase-tools emulators:exec)
 *
 * Alias et identités factices alignés sur la config principale.
 */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dummyPrivateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(import.meta.dirname, "vitest/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["e2e/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      FIREBASE_PROJECT_ID: "demo-gen3ia",
      FIREBASE_CLIENT_EMAIL: "test@demo-gen3ia.iam.gserviceaccount.com",
      FIREBASE_PRIVATE_KEY: dummyPrivateKeyPem,
      // Émulateurs Firebase (ports alignés sur firebase.json) — définis
      // AVANT tout import : firebase-admin lit ces variables à l'init.
      GCLOUD_PROJECT: "demo-gen3ia",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
      FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    },
  },
});
