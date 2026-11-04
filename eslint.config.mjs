import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/**
 * ESLint 10 flat config for Gen3ia (Next.js 16 + TypeScript).
 *
 * eslint-config-next@16 expose un preset flat NATIF (dist/*.js) : plus besoin
 * de FlatCompat/@eslint/eslintrc (supprimé dans ESLint 10). Les presets
 * s'étalent directement dans le tableau de config.
 */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "next-env.d.ts",
      "desktop/**",
      "services/**",
      "functions/**",
      "public/sw.js",
    ],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Les tests vitest utilisent des expressions regulieres longues et
      // des caracteres d'echappement legittimes (bornes de fenetres horaires).
      "no-useless-escape": "off",
      // Data-loading effects synchronize React with external I/O. The React 19 rule
      // flags the invocation site even when the state updates happen asynchronously.
      "react-hooks/set-state-in-effect": "off",
      // Règles expérimentales du compilateur React (react-hooks@7) : les canvas
      // d'animation (essaim, ondes, production vidéo) lisent .current pendant le
      // render pour dessiner — refactor profond requis (state miroir), suivi dans
      // l'issue « Phase 3 — Logique métier ». Pas de désactivation silencieuse :
      // les autres règles du preset restent actives.
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/preserve-manual-memoization": "off",
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
