/**
 * Manifeste du SDK public @gen3ia/sdk (Task 61 — priorité #4 de la feuille
 * de route : « SDK distribué depuis app/api/public »).
 *
 * SOURCE UNIQUE de vérité pour les routes de distribution : la version
 * déclarée ici DOIT rester identique à sdk/package.json et au tarball
 * committé public/sdk/gen3ia-sdk-<version>.tgz. Un test dédié
 * (app/api/public/sdk/route.test.ts) échoue dès que les trois sources
 * divergent — c'est la garde anti-dérive qui rend cette triple écriture sûre.
 *
 * Le tarball est un artefact COMMITTÉ (regénéré via `npm run sdk:pack`
 * après toute modification du SDK, avec bump de version) : sa diffusion ne
 * dépend d'aucune exécution de build à la volée, et `npm install <url>`
 * le télécharge depuis le CDN statique Vercel de l'application elle-même.
 */

export const SDK_PACKAGE_NAME = "@gen3ia/sdk";

export const SDK_VERSION = "1.0.0";

/** Fichier tarball servi depuis public/sdk/ — nom versionné = immuable par construction. */
export const SDK_TARBALL_FILENAME = `gen3ia-sdk-${SDK_VERSION}.tgz`;

/** Chemin statique du tarball dans l'application (CDN Vercel). */
export const SDK_TARBALL_PUBLIC_PATH = `/sdk/${SDK_TARBALL_FILENAME}`;

/** Description courte réutilisée par la route de métadonnées. */
export const SDK_DESCRIPTION =
  "SDK TypeScript officiel de l'API Gen3ia — exécution d'agents par clé développeur, missions longues (file QStash + suivi SSE), salons clients publics et déclencheurs webhook.";
