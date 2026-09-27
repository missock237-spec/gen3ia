import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "path";
import { fileURLToPath } from "url";

/**
 * ESLint 9 flat config for Gen3ia (Next.js 15 + TypeScript).
 *
 * eslint-config-next@15 expose un format legacy (.eslintrc) : il passe par
 * FlatCompat (approche officielle Next 15). Le preset natif flat n'existe
 * qu'à partir de eslint-config-next@16.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "next-env.d.ts",
      "desktop/**",
      "sandbox/**",
      "live-agent/**",
      "functions/**",
      "public/sw.js",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Les tests vitest utilisent des expressions regulieres longues et
      // des caracteres d'echappement legittimes (bornes de fenetres horaires).
      "no-useless-escape": "off",
      // Data-loading effects synchronize React with external I/O. The React 19 rule
      // flags the invocation site even when the state updates happen asynchronously.
      "react-hooks/set-state-in-effect": "off",
      // Convention standard : un identifiant préfixé `_` marque une variable
      // VOLONTAIREMENT non utilisée (signature uniforme, paramètre requis par
      // une interface, déstructuration partielle) — pas du code mort.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Scripts de diagnostic e2e production (outils d'audit éphémères, hors
    // produit) : les variables capturées pour inspection manuelle y sont
    // légitimes. Le code produit (app/, components/, lib/) reste strict.
    files: ["scripts/**/*.mjs"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];

export default config;
