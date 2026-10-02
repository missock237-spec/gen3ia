import { NextResponse, type NextRequest } from "next/server";

import {
  SDK_DESCRIPTION,
  SDK_PACKAGE_NAME,
  SDK_TARBALL_FILENAME,
  SDK_TARBALL_PUBLIC_PATH,
  SDK_VERSION,
} from "@/lib/public-sdk/manifest";

/**
 * Point d'entrée de la distribution du SDK (Task 61 — priorité #4 : « SDK
 * @gen3ia/sdk distribué depuis app/api/public »).
 *
 * GET /api/public/sdk — métadonnées d'installation : version, commandes
 * `npm install` prêtes à copier (URL tarball absolue, construite sur
 * l'origine réelle de la requête), surface d'API couverte et quickstart.
 * Aucune authentification : c'est la vitrine d'intégration du produit.
 *
 * Le tarball lui-même est servi par GET /api/public/sdk/download (redirection
 * vers l'asset statique public/sdk/<version>.tgz). La version est ISSUE D'UNE
 * SEULE SOURCE (lib/public-sdk/manifest.ts) — un test échoue si elle diverge
 * de sdk/package.json ou du tarball committé.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const origin = new URL(request.url).origin;
  const downloadUrl = `${origin}/api/public/sdk/download`;
  const tarballUrl = `${origin}${SDK_TARBALL_PUBLIC_PATH}`;

  return NextResponse.json(
    {
      name: SDK_PACKAGE_NAME,
      version: SDK_VERSION,
      description: SDK_DESCRIPTION,
      engines: { node: ">=20" },
      install: {
        npm: `npm install ${downloadUrl}`,
        pnpm: `pnpm add ${downloadUrl}`,
        yarn: `yarn add ${downloadUrl}`,
        tarball: tarballUrl,
      },
      endpoints: [
        { method: "POST", path: "/api/v1/agents/{agentId}/run", auth: "clé développeur (Bearer g3x_… + X-Gen3ia-Project-Id)", sdk: "client.agents.run()" },
        { method: "POST", path: "/api/agents/run", auth: "token Firebase (Bearer)", sdk: "client.missions.run()" },
        { method: "GET", path: "/api/agents/runs/{runId}", auth: "token Firebase (Bearer)", sdk: "client.missions.get() / waitFor()" },
        { method: "GET", path: "/api/agents/runs/{runId}/stream", auth: "token Firebase (Bearer)", sdk: "client.missions.stream() / follow()" },
        { method: "POST", path: "/api/webhooks/agent-triggers/{token}", auth: "token webhook (URL secrète)", sdk: "client.webhooks.trigger()" },
        { method: "GET", path: "/api/public/agents/{agentId}", auth: "aucune", sdk: "client.publicAgents.get() / chat()" },
        { method: "GET", path: "/api/public/commercial/{slug}", auth: "aucune", sdk: "client.commercial.get() / chat()" },
        { method: "GET", path: "/api/public/health", auth: "aucune", sdk: "client.health()" },
      ],
      quickstart: {
        import: `import { Gen3iaClient } from "${SDK_PACKAGE_NAME}";`,
        developerKey: `const client = new Gen3iaClient({ apiKey: "g3x_…", projectId: "…" });\nconst result = await client.agents.run("<agentId>", { objective: "Rédige la veille du jour." });`,
        missions: `const client = new Gen3iaClient({ firebaseToken: () => getIdToken() });\nconst queued = await client.missions.run({ objective: "…" });\nawait client.missions.follow(queued.runId, { onProgress, onFinal });`,
        webhook: `// Déclenche une mission « agent toujours actif » depuis un système externe.\nawait client.webhooks.trigger("<token>", { event: "stripe.paid", id: "evt_…" });`,
      },
      docs: `${origin}/docs/sdk.md`,
      download: downloadUrl,
      tarball: tarballUrl,
      tarballFilename: SDK_TARBALL_FILENAME,
    },
    {
      headers: { "Cache-Control": "no-store" },
    },
  );
}
