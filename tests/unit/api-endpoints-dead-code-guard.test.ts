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
/* Baseline honnête — 81 endpoints orphelins au 2026-10-30 (it.39 ;     */
/* 103 à l'it.29, puis settings/export-data, tool-consents et           */
/* memory/consent câblés (it.29-30), le lot marketplace                 */
/* extensions/{installed,purchases,licenses,usage} câblé sur /extensions*/
/* (it.31), finance-unpaid, finance-cashflow, hr-training et            */
/* operations-maintenance câblés sur /business (it.33, lot 1/3),        */
/* hr-leaves, compliance-gdpr et documents-onboarding câblés sur        */
/* /business (it.35, lot 2/3), puis documents-contracts,                */
/* marketing-landing, marketing-webinar et automations câblés sur       */
/* /business (it.36, lot 3/3 — /business/pulse reste volontairement     */
/* sans vue lecture : mission agent POST coûteuse), puis les 6          */
/* doublons morts /orchestrator* SUPPRIMÉS (it.37 — la lib du workflow  */
/* d'approbation reste vivante via agent/chat/approve, ads/*,           */
/* messaging ; les entrées HTTP n'avaient AUCUN appelant, l'UI passe     */
/* par /api/team/[teamId]/orchestrator), puis RECULS DE /skills* et     */
/* /knowledge* vers « pre-ui-roadmap » (it.38 — API de données de       */
/* l'agent, UI classée LOT 6 du plan plateforme, décision produit        */
/* documentée ; total inchangé, classification corrigée), puis les 4     */
/* doublons morts /ads/{connect,connections,composio/*} SUPPRIMÉS        */
/* (it.39 — la connexion Composio vivante passe par la porte GÉNÉRIQUE  */
/* /api/integrations/composio/connect appelée par nova-chat +           */
/* connectors-panel ; /ads/generate + /ads/publish restent des candidats */
/* UI documentés — guide-technique), puis AFFINAGE DE CLASSIFICATION     */
/* (it.40 — total inchangé 81 : les 4 /admin/* audités 4 canaux (0       */
/* appelant UI, libs toutes vivantes) et /ads/{generate,publish} sont    */
/* reclassés en 2 catégories explicites : « conserver-motive » (outils   */
/* ops sans UI par conception : reconcile paiement Chariow, modération   */
/* avis, migration Firestore→R2) et « candidat-ui-documente » (API au    */
/* contrat produit : mfa-requirement dans enterprise-security.md,        */
/* generate/publish dans guide-technique — sous-statut it.39 élevé).     */
/* Classés par motif.                                                    */
/* Réviser à chaque suppression/ajout d'UI.                              */
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
  /** Endpoints PRÉ-UI (roadmap LOT 6 du plan plateforme) : la LIB et la
   *  porte HTTP sont DÉJÀ construites et vivantes côté agent (tool
   *  knowledge.search enregistrée dans le runtime, catalog capacités),
   *  l'UI de gestion n'est PAS ENCORE ÉCHUE — décision produit documentée
   *  (docs/plan-plateforme-enterprise.md : « Skills backend réels, zéro
   *  UI — pas de @Skills dans le composer », « UI Knowledge Spaces »
   *  classée LOT 6). Constat it.38 : 4 canaux vérifiés (aucun fetch
   *  frontend, aucun fetch serveur, SDK hors scope, tests = unitaires lib)
   *  — ce ne sont NI des candidats UI imminents NI des doublons morts :
   *  ce sont les API de données de l'agent, en attente de leur LOT. */
  "pre-ui-roadmap": [
    "/knowledge",
    "/knowledge/triggers",
    "/knowledge/triggers/[id]",
    "/skills",
    "/skills/create",
    "/skills/import",
  ],
  /** Vrais orphelins connus : fonctionnalités livrées SANS surface
   *  utilisateur détectée. Chaque entrée est un candidat UI (ou un
   *  doublon mort à supprimer). Ex. : /business/* (lot métier sans
   *  écran), /settings/export-data (constat it.27, câblé it.29),
   *  /extensions/{installed,licenses,purchases,usage} (lot marketplace,
   *  câblé it.31 sur /extensions) … ; les doublons morts
   *  /orchestrator* ont été SUPPRIMÉS à l'it.37 (voir verrou dédié) ;
   *  les 6 /skills* + /knowledge* sont partis en « pre-ui-roadmap »
   *  à l'it.38 (décision produit LOT 6, voir cette catégorie) ; les
   *  4 /admin/* + /ads/{generate,publish} sont partis en
   *  « conserver-motive » / « candidat-ui-documente » à l'it.40
   *  (classification affinée, voir ces catégories). */
  /** Outils d'EXPLOITATION (ops) invoqués par un opérateur authentifié
   *  (console, curl, cron VPS) — PAS D'UI par conception : l'utilisateur
   *  final n'a pas à déclencher un rapprochement de paiements ni une
   *  migration de stockage. Constat it.40 : audit 4 canaux des 4
   *  /admin/* — 0 fetch frontend, 0 fetch serveur, docs internes
   *  vérifiées, 0 test d'intégration UI ; chaque lib servie est vivante
   *  (webhook Chariow, repository extensions 16+ portes, moteur r2fs,
   *  mfa lecture via session+topup). Motivations :
   *   - /admin/billing/reconcile : rattrapage des livraisons Chariow
   *     coincées (Task 104-b) — le chemin de RECOUVREMENT du canal de
   *     paiement unique (règle plateforme) ; le webhook temps réel
   *     (/webhooks/chariow, vivant) ne couvre pas les baux expirés ;
   *     documenté docs/analyse-projet.md (rapprochement périodique).
   *   - /admin/extensions/reviews : modération hide/show des avis de la
   *     marketplace (repository vivant, signalements /reports existants)
   *     — l'UI admin de modération nécessiterait d'abord une route GET
   *     de liste (inexistante) : chantier documenté, pas une perte.
   *   - /admin/migrate-firestore-r2 : SEUL lecteur Firestore restant du
   *     projet (Task 111-b) — pont de migration 1:1 vers R2, relançable
   *     et idempotent, invocation ponctuelle opérateur par conception.
   *  Verrou dédié it.40 en fin de fichier (routes + libs + docs). */
  "conserver-motive": [
    "/admin/billing/reconcile",
    "/admin/extensions/reviews",
    "/admin/migrate-firestore-r2",
  ],
  /** API documentées au CONTRAT PRODUIT sans appelant dans le dépôt :
   *  les supprimer serait un breaking change contractuel (leçon it.39
   *  §8.3 — « les API documentées ne sont pas du code mort »). Le câblage
   *  UI reste leur destin naturel — l'entrée sortira de la baseline le
   *  jour où une surface utilisateur consommera la porte.
   *   - /admin/security/mfa-requirement : politique MFA par compte
   *     (Task 63), documentée DEUX FOIS dans docs/enterprise-security.md
   *     (tableau des endpoints + « jamais par l'utilisateur ») ; lib
   *     mfa vivante côté lecture (auth/session, billing/topup) ; garde
   *     anti-locked-out : refuse tant qu'Identity Platform est inactif.
   *   - /ads/generate + /ads/publish : sous-statut implicite it.39
   *     élevé en catégorie explicite — guide-technique.md les documente
   *     (« Génération de contenu publicitaire multi-canal », « Publication
   *     de campagnes ») avec flux payant complet (wallet, media-meter,
   *     action-approvals). */
  "candidat-ui-documente": [
    "/admin/security/mfa-requirement",
    "/ads/generate",
    "/ads/publish",
  ],
  "orphelin-connu": [
    "/agents/generate",
    "/ai/generate",
    "/business/pulse",
    "/deployments/create",
    "/developer/secrets",
    "/developer/simulation",
    "/files/workspaces",
    "/ia/auto-apprentissage/rapport",
    "/media/professeur-statut",
    "/monde/stats",
    "/neural/evolve",
    "/observability/org",
    "/provisioning/intent",
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

  it("les 6 doublons morts /orchestrator* restent SUPPRIMÉS (it.37) — la porte HTTP morte ne doit pas renaître", () => {
    // Constat it.37 : la lib du workflow d'approbation est VIVANTE
    // (agent/chat/approve avec UI notification-center, ads/generate,
    // ads/publish, integrations/messaging, autonomy-guard), mais ses 6
    // entrées HTTP /api/orchestrator* n'avaient AUCUN appelant : ni fetch
    // frontend, ni fetch serveur, ni SDK documenté. L'UI d'orchestration
    // passe par /api/team/[teamId]/orchestrator (adhésion équipe vérifiée).
    // Ces routes étaient donc des doublons morts : supprimées, pas câblées.
    const doublonsSupprimes = [
      "app/api/orchestrator/route.ts",
      "app/api/orchestrator/action-plan/route.ts",
      "app/api/orchestrator/actions/route.ts",
      "app/api/orchestrator/actions/[id]/approve/route.ts",
      "app/api/orchestrator/actions/[id]/execute/route.ts",
      "app/api/orchestrator/actions/[id]/reject/route.ts",
    ];
    for (const rel of doublonsSupprimes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} a été supprimé à l'it.37 (doublon mort sans appelant) — ne le recréez pas sans UI ; l'orchestration passe par /api/team/[teamId]/orchestrator`,
      ).toBe(false);
    }
    // La LIB du workflow reste vivante et consommée — si l'un de ces
    // fichiers disparaît, c'est une régression fonctionnelle (approbations
    // agent/chat, ads, messaging cassées), pas un nettoyage.
    const libVivantes = [
      "lib/agents/action-approvals.ts",
      "lib/orchestrator/team-coordination.ts",
      "app/api/team/[teamId]/orchestrator/route.ts",
      "app/api/agent/chat/approve/route.ts",
    ];
    for (const rel of libVivantes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est VIVANT (consommé par l'UI ou d'autres entrées HTTP) — sa disparition est une régression, pas un nettoyage`,
      ).toBe(true);
    }
  });

  it("les 6 API /skills* + /knowledge* restent des portes PRE-UI vivantes (it.38) — ni supprimées ni câblées en avance de phase", () => {
    // Constat it.38 : ces 6 endpoints sont les API de DONNÉES de l'agent.
    // Leur lib est consommée par le runtime agent (tool knowledge.search
    // dans lib/agents/tool-resolver, catalog capacités) et la porte HTTP
    // est déjà construite (Zod, rate-limit, org-scoping). L'UI de gestion
    // est classée LOT 6 du plan plateforme — pas encore échue. Décision
    // produit documentée dans docs/plan-plateforme-enterprise.md.
    const portesPreUi = [
      "app/api/skills/route.ts",
      "app/api/skills/create/route.ts",
      "app/api/skills/import/route.ts",
      "app/api/knowledge/route.ts",
      "app/api/knowledge/triggers/route.ts",
      "app/api/knowledge/triggers/[id]/route.ts",
    ];
    for (const rel of portesPreUi) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est la porte de données de l'agent (LOT 6) — la supprimer détruirait l'infrastructure pré-UI`,
      ).toBe(true);
    }
    // La chaîne lib côté agent doit rester vivante (sinon l'outil agent
    // knowledge.search et le catalog capacités se cassent).
    const chainesLib = [
      "lib/knowledge/ingestion.ts",
      "lib/skills/repository.ts",
      "lib/capabilities/catalog.ts",
    ];
    for (const rel of chainesLib) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le socle agent des API pre-UI — sa disparition est une régression fonctionnelle`,
      ).toBe(true);
    }
    // La décision produit doit rester documentée (anti-dérive : si le plan
    // change, mettre à jour CE verrou ET la catégorie pre-ui-roadmap).
    const plan = readFileSync(
      path.join(RACINE, "docs/plan-plateforme-enterprise.md"),
      "utf8",
    );
    expect(
      plan.includes("UI Knowledge Spaces"),
      "Le plan plateforme doit toujours référencer l'UI Knowledge Spaces (LOT 6) — catégorie pre-ui-roadmap à réviser sinon",
    ).toBe(true);
  });

  it("les 4 doublons morts /ads/{connect,connections,composio/*} restent SUPPRIMÉS (it.39) — la porte générique Composio est la voie vivante", () => {
    // Constat it.39 : la connexion Composio de la plateforme passe par la
    // porte GÉNÉRIQUE /api/integrations/composio/connect (nova-chat,
    // developer/tabs/connectors-panel) et /api/integrations/composio/
    // connections (integrations-workspace, nova-chat, lab ondes). Les
    // variantes /ads/* en dupliquaient la fonction pour 3 providers :
    // supprimées, pas câblées. /ads/callback reste (infra, référencé par
    // lib/ad-connections consommée par ad-publisher) ; /ads/generate et
    // /ads/publish restent des candidats UI documentés (guide-technique).
    const doublonsAds = [
      "app/api/ads/connect/route.ts",
      "app/api/ads/connections/route.ts",
      "app/api/ads/composio/connect/route.ts",
      "app/api/ads/composio/connections/route.ts",
    ];
    for (const rel of doublonsAds) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} a été supprimé à l'it.39 (doublon de la porte générique /api/integrations/composio/connect) — ne le recréez pas sans UI`,
      ).toBe(false);
    }
    // Les chaînes vivantes doivent rester : porte générique Composio (UI),
    // campagnes (UI admin), placement, et les 2 candidats UI documentés.
    const chainesVivantes = [
      "app/api/integrations/composio/connect/route.ts",
      "app/api/integrations/composio/connections/route.ts",
      "app/api/ads/callback/route.ts",
      "app/api/ads/campaigns/route.ts",
      "app/api/ads/my-campaigns/route.ts",
      "app/api/ads/placement/route.ts",
      "app/api/ads/generate/route.ts",
      "app/api/ads/publish/route.ts",
      "lib/ads/ad-connections.ts",
      "lib/ads/ad-publisher.ts",
    ];
    for (const rel of chainesVivantes) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est VIVANT (UI générique, infra OAuth, ou candidat UI documenté) — sa disparition est une régression, pas un nettoyage`,
      ).toBe(true);
    }
  });

  it("les 4 outils ops /admin/* restent vivants avec leurs libs et leurs docs (it.40) — outils d'exploitation, pas du code mort", () => {
    // Constat it.40 : audit 4 canaux des 4 /admin/* — 0 fetch frontend,
    // 0 fetch serveur, docs vérifiées (analyse-projet, enterprise-security),
    // 0 test d'intégration UI. Ce sont des outils d'EXPLOITATION invoqués
    // par un opérateur authentifié (console/curl/cron VPS) : pas d'UI par
    // conception, pas des doublons morts. Leurs libs servies sont toutes
    // vivantes : /webhooks/chariow (porte temps réel du paiement),
    // repository extensions (16+ portes), moteur r2fs (chemin de données),
    // lib mfa (lecture via auth/session + billing/topup).
    const outilsOps = [
      "app/api/admin/billing/reconcile/route.ts",
      "app/api/admin/extensions/reviews/route.ts",
      "app/api/admin/migrate-firestore-r2/route.ts",
      "app/api/admin/security/mfa-requirement/route.ts",
    ];
    for (const rel of outilsOps) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est un OUTIL OPS documenté (catégorie conserver-motive / candidat-ui-documente) — sa suppression détruirait une capacité d'exploitation (recouvrement paiement, modération, migration, politique MFA)`,
      ).toBe(true);
    }
    // Les libs servies par ces outils doivent rester vivantes.
    const libsServies = [
      "lib/billing/chariow-delivery.ts",
      "lib/extensions/repository.ts",
      "lib/r2fs/store.ts",
      "lib/security/mfa.ts",
      "lib/security/admin-access.ts",
    ];
    for (const rel of libsServies) {
      expect(
        existsSync(path.join(RACINE, rel)),
        `${rel} est le socle d'un outil ops /admin/* — sa disparition est une régression fonctionnelle`,
      ).toBe(true);
    }
    // Anti-dérive documentaire : les docs qui justifient la classification
    // doivent continuer à référencer les outils (sinon, réviser les
    // catégories conserver-motive / candidat-ui-documente ET ce verrou).
    const analyseProjet = readFileSync(
      path.join(RACINE, "docs/analyse-projet.md"),
      "utf8",
    );
    expect(
      analyseProjet.includes("billing/reconcile"),
      "docs/analyse-projet.md doit toujours documenter le rapprochement Chariow — catégorie conserver-motive à réviser sinon",
    ).toBe(true);
    const docSecurite = readFileSync(
      path.join(RACINE, "docs/enterprise-security.md"),
      "utf8",
    );
    expect(
      docSecurite.includes("mfa-requirement"),
      "docs/enterprise-security.md doit toujours documenter la politique MFA admin — catégorie candidat-ui-documente à réviser sinon",
    ).toBe(true);
  });
});
