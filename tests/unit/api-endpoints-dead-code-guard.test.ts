import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GARDE ANTI-CODE-MORT GLOBAL (itération 29, Job 478451).
 *
 * Constat d'audit : le motif « code mort livré en production » s'est produit
 * QUATRE fois — ErrorBoundary jamais monté (it.22), politique de sauvegarde
 * documentée sans implémentation (it.23), endpoints RGPD sans UI (it.25),
 * /api/settings/export-data orphelin (it.27). À chaque fois, le code était
 * testé vert, déployé… et inaccessible aux utilisateurs : personne ne
 * référence la route depuis l'interface.
 *
 * Ce garde croise SYSTÉMATIQUEMENT l'inventaire des endpoints
 * (`app/api/…/route.ts`) avec les fichiers atteignables par l'utilisateur
 * (`app/` hors `app/api/`, `components/`, `public/`, `middleware.ts`,
 * `next.config.*`). Il échoue à la CI dès qu'un endpoint apparaît SANS
 * aucune référence UI : la 5e occurrence du motif devient structurellement
 * impossible à livrer sans décision explicite (entrée dans la baseline).
 *
 * Baseline = registre HONNÊTE des endpoints actuels sans référence UI,
 * classés par motif. Deux règles d'hygiène :
 *  - une entrée de baseline qui DEVIENT référencée doit être retirée
 *    (la CI refuse les entrées obsolètes) ;
 *  - une entrée de baseline qui ne correspond à aucun endpoint réel est
 *    refusée (pas de registre fantôme).
 */

const RACINE = process.cwd();

/* ------------------------------------------------------------------ */
/* Walk du code source (hors node_modules — on ne descend que dans     */
/* les répertoires produit).                                           */
/* ------------------------------------------------------------------ */

function walk(rel: string, acc: string[] = []): string[] {
  const abs = path.join(RACINE, rel);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs)) {
    const relEntry = `${rel}/${entry}`;
    const absEntry = path.join(abs, entry);
    if (statSync(absEntry).isDirectory()) walk(relEntry, acc);
    else acc.push(relEntry);
  }
  return acc;
}

/** Endpoints = tous les fichiers app/api/**\/route.ts → chemin /api/… */
function inventorierEndpoints(): string[] {
  const fichiers = walk("app/api").filter((f) => f.endsWith("route.ts"));
  return fichiers
    .map((f) => f.replace(/^app\/api/, "").replace(/\/route\.ts$/, ""))
    .sort();
}

/** Fichiers « surface utilisateur » : le seul lieu où une route devient
 *  accessible à quelqu'un. Les tests, lib/ et docs ne comptent PAS :
 *  un endpoint testé mais jamais appelé depuis l'UI est précisément le
 *  motif que cette garde traque. */
function inventaireSurfaceUtilisateur(): string[] {
  const fichiers = [
    ...walk("app").filter((f) => !f.startsWith("app/api/")),
    ...walk("components"),
    ...walk("public"),
  ];
  for (const racine of ["middleware.ts", "next.config.ts", "next.config.js", "next.config.mjs"]) {
    if (existsSync(path.join(RACINE, racine))) fichiers.push(racine);
  }
  return fichiers;
}

/* ------------------------------------------------------------------ */
/* Baseline honnête — 92 endpoints orphelins au 2026-10-29 (it.33 ;     */
/* 103 à l'it.29, puis settings/export-data, tool-consents et           */
/* memory/consent câblés (it.29-30), le lot marketplace                 */
/* extensions/{installed,purchases,licenses,usage} câblé sur /extensions*/
/* (it.31), puis finance-unpaid, finance-cashflow, hr-training et       */
/* operations-maintenance câblés sur /business (it.33, lot 1/3).        */
/* Classés par motif. Réviser à chaque suppression/ajout d'UI.          */
/* ------------------------------------------------------------------ */

const BASELINE_ORPHELINS: Record<string, string[]> = {
  /** Déclenchés par l'infrastructure (cron Vercel, workers, webhooks
   *  externes, sondes) — jamais par le navigateur. */
  "infra-externe": [
    "/ads/callback",
    "/cron/cleanup-invitations",
    "/cron/knowledge-ingest",
    "/cron/observability",
    "/cron/training-sweep",
    "/cron/workflow-triggers",
    "/health/infra",
    "/public/health",
    "/queue/dispatch-tick",
    "/queue/mission-tick",
    "/training/worker",
    "/video/worker/production-tick",
    "/video/worker/tick",
    "/webhooks/chariow",
    "/workflows/triggers/webhook/[token]",
  ],
  /** Appelés côté serveur par des chaînes lib/ vivantes (files d'attente,
   *  clients d'agents, SDK interne, upload R2…) — la surface utilisateur
   *  est en amont dans la chaîne. */
  "chaine-serveur-lib": [
    "/agents/plan",
    "/agents/runs/[runId]",
    "/agents/runs/[runId]/stream",
    "/agents/system/activate",
    "/auth/r2/password-reset",
    "/auth/r2/password-reset/confirm",
    "/billing/api-usage",
    "/documents/[artifactId]",
    "/essaim/canal",
    "/essaim/job/[id]",
    "/essaim/ondes",
    "/essaim/resultat",
    "/extensions/entitlements",
    "/files/read",
    "/files/write",
    "/identity/twin",
    "/integrations/composio/tools",
    "/networks",
    "/networks/[id]",
    "/networks/[id]/run",
    "/ondes/rpia",
    "/ondes/signaling",
    "/storage/permanent/commit",
    "/storage/permanent/session",
  ],
  /** Consommés par des clients hors dépôt app : SDK public, extension
   *  navigateur, bridge d'entraînement. */
  "api-publique-sdk": [
    "/capabilities",
    "/public/sdk/download",
    "/v1/capabilities",
    "/v1/chat",
    "/v1/essaim/manifeste",
    "/v1/wallet",
  ],
  /** Vrais orphelins connus : fonctionnalités livrées SANS surface
   *  utilisateur détectée. Chaque entrée est un candidat UI (ou un
   *  doublon mort à supprimer). Ex. : /business/* (lot métier sans
   *  écran), /orchestrator* (l'UI passe par /api/team/{id}/orchestrator),
   *  /settings/export-data (constat it.27, câblé it.29),
   *  /extensions/{installed,licenses,purchases,usage} (lot marketplace,
   *  câblé it.31 sur /extensions), /skills* … */
  "orphelin-connu": [
    "/admin/billing/reconcile",
    "/admin/extensions/reviews",
    "/admin/migrate-firestore-r2",
    "/admin/security/mfa-requirement",
    "/ads/composio/connect",
    "/ads/composio/connections",
    "/ads/connect",
    "/ads/connections",
    "/ads/generate",
    "/ads/publish",
    "/agents/generate",
    "/ai/generate",
    "/business/automations",
    "/business/compliance-gdpr",
    "/business/documents-contracts",
    "/business/documents-onboarding",
    "/business/hr-leaves",
    "/business/marketing-landing",
    "/business/marketing-webinar",
    "/business/pulse",
    "/deployments/create",
    "/developer/secrets",
    "/developer/simulation",
    "/files/workspaces",
    "/ia/auto-apprentissage/rapport",
    "/knowledge",
    "/knowledge/triggers",
    "/knowledge/triggers/[id]",
    "/media/professeur-statut",
    "/monde/stats",
    "/neural/evolve",
    "/observability/org",
    "/orchestrator",
    "/orchestrator/action-plan",
    "/orchestrator/actions",
    "/orchestrator/actions/[id]/approve",
    "/orchestrator/actions/[id]/execute",
    "/orchestrator/actions/[id]/reject",
    "/provisioning/intent",
    "/skills",
    "/skills/create",
    "/skills/import",
    "/storage/r2-diagnostic",
    "/tools/execute",
    "/training/hub/inspect",
    "/workspace/conversations/search",
    "/workspace/tasks/clarify",
  ],
};

/* Endpoints dont le câblage UI est une EXIGENCE produit (RGPD) — ils ne
 * doivent JAMAIS rejoindre la baseline. */
const RGPD_A_CABLAGE_OBLIGATOIRE = [
  "/account/export",
  "/auth/account",
  "/memory/export",
  "/memory/purge",
];

/* ------------------------------------------------------------------ */
/* Calcul partagé                                                      */
/* ------------------------------------------------------------------ */

const endpoints = inventorierEndpoints();
const surface = inventaireSurfaceUtilisateur();
const contenus = surface.map((f) => readFileSync(path.join(RACINE, f), "utf8"));

/** Clé de recherche : préfixe statique (coupe avant le 1er segment [dyn]) —
 *  une référence UI en template literal `/api/agents/${id}` contient le
 *  préfixe `/api/agents/`. */
const cleRecherche = (endpoint: string) => endpoint.split("[")[0];

const references = (endpoint: string) =>
  contenus.filter((c) => c.includes(cleRecherche(endpoint)));

const orphelinsCalcules = endpoints.filter((ep) => references(ep).length === 0).sort();

const baselineUnion = Object.values(BASELINE_ORPHELINS)
  .flat()
  .sort();

/* ------------------------------------------------------------------ */
/* Garde                                                               */
/* ------------------------------------------------------------------ */

describe("garde anti-code-mort — endpoints vs surface utilisateur (it.29)", () => {
  it("inventaire auto-protégé : le scan voit assez d'endpoints et de fichiers UI", () => {
    // Si ces planchers tombent à zéro, le walker est cassé et la garde
    // deviendrait vacuole (0 orphelin = tout passe). Planchers volontairement
    // sous les valeurs courantes (302 endpoints / ~240 fichiers UI).
    expect(endpoints.length).toBeGreaterThanOrEqual(250);
    expect(surface.length).toBeGreaterThanOrEqual(200);
    expect(endpoints.some((ep) => ep.includes("[id]"))).toBe(true);
  });

  it("chaque route.ts exporte au moins un gestionnaire HTTP", () => {
    const sansHandler = endpoints.filter((ep) => {
      const src = readFileSync(
        path.join(RACINE, `app/api${ep}/route.ts`),
        "utf8",
      );
      return !/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(
        src,
      );
    });
    expect(
      sansHandler,
      `Routes sans gestionnaire HTTP exporté (code mort pur) : ${sansHandler.join(", ")}`,
    ).toEqual([]);
  });

  it("aucun NOUVEL endpoint orphelin hors baseline — la 5e occurrence du motif code-mort est bloquée à la CI", () => {
    const horsBaseline = orphelinsCalcules.filter(
      (ep) => !baselineUnion.includes(ep),
    );
    expect(
      horsBaseline,
      `NOUVEAUX endpoints sans aucune référence UI — soit câbler l'UI, soit ` +
        `documenter une entrée motivée dans BASELINE_ORPHELINS ` +
        `(tests/unit/api-endpoints-dead-code-guard.test.ts) : ${horsBaseline.join(", ")}`,
    ).toEqual([]);
  });

  it("baseline sans entrée obsolète — une route désormais référencée sort du registre", () => {
    const obsoletes = baselineUnion.filter(
      (ep) => endpoints.includes(ep) && references(ep).length > 0,
    );
    expect(
      obsoletes,
      `Entrées de baseline devenues référencées — retirer de BASELINE_ORPHELINS : ${obsoletes.join(", ")}`,
    ).toEqual([]);
  });

  it("baseline couvre exactement les orphelins actuels (pas de registre fantôme, pas de trou)", () => {
    const fantomes = baselineUnion.filter((ep) => !endpoints.includes(ep));
    const manquants = orphelinsCalcules.filter(
      (ep) => !baselineUnion.includes(ep),
    );
    expect(fantomes, `Entrées baseline sans endpoint réel : ${fantomes.join(", ")}`).toEqual([]);
    expect(manquants, `Orphelins absents de la baseline : ${manquants.join(", ")}`).toEqual([]);
    expect(new Set(baselineUnion).size).toBe(baselineUnion.length);
  });

  it("les endpoints RGPD critiques restent câblés à l'UI (jamais en baseline)", () => {
    for (const ep of RGPD_A_CABLAGE_OBLIGATOIRE) {
      expect(endpoints, `${ep} doit exister`).toContain(ep);
      expect(
        references(ep).length,
        `${ep} (RGPD) n'est plus référencé depuis app/components/public — régressions it.25/it.27`,
      ).toBeGreaterThan(0);
      expect(baselineUnion, `${ep} ne doit JAMAIS être baseliné`).not.toContain(ep);
    }
  });
});
