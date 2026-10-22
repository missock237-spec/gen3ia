/**
 * LISTE BLANCHE D'ACCÈS UTILISATEUR — demande n°7 (deny-by-default).
 *
 * Source CENTRALE de vérité : quels chemins (pages + API) un utilisateur
 * STANDARD a le droit d'atteindre. Tout ce qui n'est ni public ni listé
 * ici est INTERDIT aux utilisateurs standard (403) — c'est le contrat
 * « deny-by-default » appliqué par le middleware (middleware.ts) et, en
 * seconde barrière, par protectRoute (lib/security/route-guard.ts).
 *
 * MATRICE DE DÉCISION (identique dans les deux barrières) :
 *
 *   Chemin PUBLIC  (auth, santé, stats publiques, webhooks, cron, assets)
 *     → ouvert à TOUS, y compris anonyme (comportement existant inchangé :
 *       401 levé par la route elle-même sur les API privées, redirection
 *       login gérée par le client sur les pages privées).
 *
 *   Chemin UTILISATEUR (famille listée ci-dessous)
 *     → ouvert à tout visiteur (la route applique elle-même requireUser :
 *       un anonyme reçoit 401 exactement comme aujourd'hui) ; un
 *       utilisateur standard et un admin passent tous les deux.
 *
 *   Chemin RESTREINT (tout le reste — deny-by-default)
 *     → ANONYME        : la requête CONTINUE (comportement auth existant
 *                        strictement inchangé : 401 API / redirection
 *                        client sur pages) ;
 *     → ADMIN (custom claim Firebase `admin: true` vérifié, OU rôle
 *       plateforme admin résolu via l'annuaire — même source que
 *       getPlatformAccess) : ACCÈS COMPLET ;
 *     → UTILISATEUR STANDARD : 403 (JSON sur API, page HTML ailleurs).
 *
 * Ce module est PUR (aucun import) : utilisable par le middleware, les
 * routes API et les tests. Les seules fonctions asynchrones
 * (createCachedAdminResolver) reçoivent leur chargeur en INJECTION —
 * aucun graphe de dépendances serveur n'est tiré ici.
 *
 * FAMILIES AUTORISÉES AUX UTILISATEURS (demande n°7, élargie sur demande
 * explicite du propriétaire — « les utilisateurs n'ont plus accès au
 * projet ») : chat IA · studio d'entraînement (+ sa configuration) ·
 * connecteurs · planifications · facturation · paramètres · accès au
 * compte (auth) · base de connaissances · projets · fichiers ·
 * automatisation · intégrations · observabilité · mémoire permanente ·
 * STUDIO MÉTIER (hub complet hors IDE développeur /studio/console, incl.
 * atelier vidéo) · AGENT LIVE (PC + Android) · ÉQUIPE/COLLABORATION ·
 * PUBLICITÉ UTILISATEUR (campagnes personnelles, hors inventaire admin) ·
 * CLIENTS ID (CRM commercial du studio).
 *
 * DEMANDE PROPRIÉTAIRE (restauration) : planifications, publicité, équipe
 * et clients ID doivent rester ACCESSIBLES À TOUS LES COMPTES — ces
 * familles ne doivent JAMAIS être retirées de la liste blanche.
 *
 * TOUT le reste est interdit : admin, IDE développeur (/studio/console,
 * /api/developer/*), monde, essaim, arène, ondes, inventaire publicitaire
 * admin (/api/ads/campaigns), extensions, terminal, workflows,
 * orchestrator, notifications push, etc. La matrice COMPLÈTE allow/deny
 * est documentée dans la PR de cette branche.
 */

export type AccessLevel = "public" | "user" | "restreint";

export type RouteFamily =
  | "public"
  | "auth-compte"
  | "sante"
  | "systeme"
  | "chat"
  | "training"
  | "connecteurs"
  | "planifications"
  | "facturation"
  | "parametres"
  | "connaissances"
  | "projets"
  | "fichiers"
  | "automatisation"
  | "integrations"
  | "observabilite"
  | "memoire"
  | "studio"
  | "live"
  | "collaboration";

export interface PathDecision {
  access: AccessLevel;

  family: RouteFamily;
}

/* ------------------------------------------------------------------ */
/* API — chemins PUBLICS (préservés, anonyme inclus)                   */
/* ------------------------------------------------------------------ */

/** Endpoints publics EXACTS — santé, sondes et stats documentées. */
const PUBLIC_API_EXACT: Readonly<Record<string, RouteFamily>> = {
  "/api/health": "sante",
  "/api/health/infra": "sante",
  "/api/neural/public-stats": "public",
  "/api/status": "systeme",
  "/api/deploy-info": "systeme",
};

/**
 * Préfixes publics d'API :
 *  - /api/auth : flux d'authentification (login, signup, réinitialisation,
 *    session) ET accès au compte (account, profile, session, access) —
 *    indispensable anonyme ET utilisateur ;
 *  - /api/public : portail client, SDK, pages commerciales publiques ;
 *  - /api/webhooks : callbacks signés externes (Chariow, triggers) ;
 *  - /api/cron, /api/queue, /api/video/worker : tâches système
 *    (CRON_SECRET / signature interne — pas une surface utilisateur) ;
 *  - /api/ads/callback : point d'entrée OAuth externe (voir matrice PR :
 *    le module ads reste interdit aux utilisateurs standard).
 */
const PUBLIC_API_PREFIXES: ReadonlyArray<readonly [string, RouteFamily]> = [
  ["/api/auth", "auth-compte"],
  ["/api/public", "public"],
  ["/api/webhooks", "systeme"],
  ["/api/cron", "systeme"],
  ["/api/queue", "systeme"],
  ["/api/video/worker", "systeme"],
];

/* ------------------------------------------------------------------ */
/* API — LISTE BLANCHE UTILISATEUR (les 14 familles de la demande)     */
/* ------------------------------------------------------------------ */

/**
 * Préfixes autorisés pour un utilisateur STANDARD. Le suffixage est
 * strict : `/api/agents/schedules` autorise `/api/agents/schedules` et
 * `/api/agents/schedules/<id>/run` mais PAS `/api/agents/run`.
 */
const USER_API_PREFIXES: ReadonlyArray<readonly [string, RouteFamily]> = [
  // Chat IA (pages /chat, /chat-v4, /dashboard, /workspace/conversations).
  // /api/agent/chat ne couvre plus que /approve (approbations missions/ads) ;
  // les routes du chat d'agent universel sont supprimées du projet.
  ["/api/agent/chat", "chat"],
  ["/api/ai/feedback", "chat"],
  ["/api/workspace/conversations", "chat"],
  ["/api/workspace/approvals", "chat"],
  ["/api/workspace/prompt-templates", "chat"],
  // Studio d'entraînement + configuration. /api/ia/auto-apprentissage est
  // l'état/toggle de la boucle d'entraînement affiché DANS la page de chat
  // (components/chat/auto-apprentissage-carte.tsx) : le refuser casserait
  // une fonctionnalité visible d'une page allowlistée — c'est un paramètre
  // de configuration de l'entraînement au sens de la demande n°7.
  ["/api/training", "training"],
  ["/api/ia/auto-apprentissage", "training"],
  // Connecteurs (API personnalisées + hub /studio/connections)
  ["/api/custom-apis", "connecteurs"],
  // Planifications (hub agents/schedules consommé par /workspace/schedules)
  // DEMANDE PROPRIÉTAIRE : ouverte à TOUS LES COMPTES (scoping propriétaire
  // listSchedules/getSchedule(user.uid, …) assuré au niveau des routes).
  ["/api/agents/schedules", "planifications"],
  // Facturation
  ["/api/billing", "facturation"],
  // Paramètres
  ["/api/settings", "parametres"],
  // Base de connaissances
  ["/api/knowledge", "connaissances"],
  // Projets
  ["/api/workspace/projects", "projets"],
  // Fichiers (+ artefacts de conversation, stockage permanent, capture photo)
  ["/api/files", "fichiers"],
  ["/api/documents", "fichiers"],
  ["/api/workspace/artifacts", "fichiers"],
  ["/api/storage", "fichiers"],
  ["/api/camera", "fichiers"],
  // Automatisation (exécution pilotée depuis la conversation)
  ["/api/workspace/tasks", "automatisation"],
  ["/api/workspace/missions", "automatisation"],
  // Intégrations (Composio, MCP, messagerie, webhooks utilisateur)
  ["/api/integrations", "integrations"],
  // Observabilité (vue personnelle ; /api/observability/org reste restreint)
  ["/api/observability/overview", "observabilite"],
  // Mémoire permanente
  ["/api/memory", "memoire"],
  // STUDIO MÉTIER (réouverture demandée par le propriétaire — les
  // utilisateurs doivent avoir accès au projet) : atelier vidéo
  // (/studio/video → /api/video/projects), projets et rendus vidéo.
  // Le worker vidéo reste SYSTEME (public/signé) — jamais exposé.
  ["/api/video/projects", "studio"],
  // AGENT LIVE (réouverture demandée) : sessions et frames du tableau
  // de bord live — auth utilisateur + cloisonnement propriétaire déjà
  // assurés par les routes elles-mêmes (assertLiveSessionOwner).
  ["/api/live", "live"],
  // AGENTS DÉDIÉS (schedules/live/missions — le workshop universel
  // /studio/agents est supprimé) : les routes d'ORCHESTRATION
  // (run/generate/plan, PATCH [id]) restent gardées AU NIVEAU DE LA ROUTE
  // (requireAgentSystemAccess) — défense en profondeur conservée. La
  // SUPPRESSION (DELETE [id]) est ouverte au propriétaire (demande
  // explicite — « supprime l'agent IA » ne devait rien faire).
  ["/api/agents", "studio"],
  // CLIENTS ID (demande propriétaire — accessible à TOUS LES COMPTES) :
  // CRM commercial du studio (/studio/clients), routes requireUser
  // scopées propriétaire/org.
  ["/api/commercial", "studio"],
  // ÉQUIPE / COLLABORATION (demande propriétaire — accessible à TOUS LES
  // COMPTES) : /team et ses APIs — routes requireUser + scoping membre.
  ["/api/teams", "collaboration"],
  ["/api/team", "collaboration"],
  ["/api/organizations", "collaboration"],
  // PUBLICITÉ UTILISATEUR (demande propriétaire — accessible à TOUS LES
  // COMPTES) : campagne personnelle (placement, mes campagnes,
  // publication) — chaque route authentifie elle-même (requireUser ou
  // protectRoute). L'INVENTAIRE ADMIN (/api/ads/campaigns) reste
  // RESTREINT (voir RESTRICTED_API_PREFIXES).
  ["/api/ads", "parametres"],
];

/* ------------------------------------------------------------------ */
/* API — EXCEPTIONS RESTREINTES (évaluées AVANT la liste blanche)       */
/* ------------------------------------------------------------------ */

/**
 * Sous-chemins d'un préfixe autorisé qui restent INTERDITS aux
 * utilisateurs standard : l'ORCHESTRATION du système agent (exécution,
 * génération de plan, activation interne) est réservée à l'IA (demande
 * n°5, maintenue) — seul le provisionnement des agents dédiés est ouvert.
 */
const RESTRICTED_API_PREFIXES: ReadonlyArray<readonly [string, RouteFamily]> = [
  ["/api/agents/run", "systeme"],
  ["/api/agents/generate", "systeme"],
  ["/api/agents/plan", "systeme"],
  ["/api/agents/system", "systeme"],
  // L'INVENTAIRE PUBLICITAIRE GLOBAL (toutes campagnes de la plateforme,
  // écran /admin/ads) reste ADMIN : seule la PUBLICITÉ UTILISATEUR est
  // ouverte (demande propriétaire). Exception évaluée AVANT le préfixe
  // /api/ads de la liste blanche.
  ["/api/ads/campaigns", "systeme"],
];

/* ------------------------------------------------------------------ */
/* PAGES — publiques                                                   */
/* ------------------------------------------------------------------ */

const PUBLIC_PAGE_EXACT: Readonly<Record<string, RouteFamily>> = {
  "/": "public",
  "/login": "public",
  "/signup": "public",
  "/faq": "public",
  "/privacy": "public",
  "/en": "public",
  "/monitoring": "public",
  // Fichiers servis depuis /public et routes système
  "/robots.txt": "public",
  "/sitemap.xml": "public",
  "/manifest.webmanifest": "public",
  "/sw.js": "public",
  "/offline.html": "public",
  "/ads.txt": "public",
  "/llms.txt": "public",
  "/llms-full.txt": "public",
};

const PUBLIC_PAGE_PREFIXES: ReadonlyArray<readonly [string, RouteFamily]> = [
  // Portail client isolé (cookie gen3ia_client_access — flux existant)
  ["/client", "public"],
  // Aperçu d'artefacts (iframe sandboxée, CSP dédiée)
  ["/preview", "public"],
  // Assets publics servis depuis /public
  ["/icons", "public"],
  ["/images", "public"],
  ["/sdk", "public"],
  ["/worklets", "public"],
];

/** Extensions de fichiers statiques servis depuis /public (repli public). */
const STATIC_EXTENSIONS: ReadonlySet<string> = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "avif", "ico", "bmp",
  "css", "js", "mjs", "map", "json", "txt", "xml", "webmanifest",
  "woff", "woff2", "ttf", "otf", "eot", "wasm",
  "html", "mp4", "webm", "mp3", "wav", "ogg", "csv", "md",
]);

/* ------------------------------------------------------------------ */
/* PAGES — EXCEPTIONS RESTREINTES (évaluées AVANT la liste blanche)     */
/* ------------------------------------------------------------------ */

/**
 * Surfaces du studio qui restent INTERDITES aux utilisateurs standard
 * même après la réouverture du studio : /studio/console est l'atelier
 * IDE développeur (clés API, projets, paiements développeur via
 * /api/developer/* — surfaces à privilège). Même sémantique que
 * /developer (filtre par rôle côté nav).
 */
const RESTRICTED_PAGE_PREFIXES: ReadonlyArray<readonly [string, RouteFamily]> = [
  ["/studio/console", "systeme"],
];

/* ------------------------------------------------------------------ */
/* PAGES — liste blanche utilisateur                                   */
/* ------------------------------------------------------------------ */

const USER_PAGE_EXACT: Readonly<Record<string, RouteFamily>> = {
  "/chat": "chat",
  "/chat-v4": "chat",
  "/dashboard": "chat",
  "/billing": "facturation",
  "/memory": "memoire",
  "/observability": "observabilite",
  "/integrations": "integrations",
  "/storage": "fichiers",
  "/workspace": "chat",
  "/settings": "parametres",
};

const USER_PAGE_PREFIXES: ReadonlyArray<readonly [string, RouteFamily]> = [
  // Pages de conversation + approbations du flux agent
  ["/workspace/conversations", "chat"],
  ["/approvals", "chat"],
  // Studio d'entraînement
  ["/workspace/training", "training"],
  // Connecteurs (redirige vers le hub /studio/connections)
  ["/workspace/connectors", "connecteurs"],
  ["/studio/connections", "connecteurs"],
  // Connaissances, projets, fichiers (+ bibliothèque d'artefacts)
  ["/workspace/knowledge", "connaissances"],
  ["/workspace/projects", "projets"],
  ["/workspace/files", "fichiers"],
  ["/workspace/bibliotheque", "fichiers"],
  // Planifications
  ["/workspace/schedules", "planifications"],
  // ÉQUIPE (demande propriétaire — accessible à TOUS LES COMPTES)
  ["/team", "collaboration"],
  // PUBLICITÉ UTILISATEUR (demande propriétaire — accessible à TOUS LES
  // COMPTES) : /settings est une entrée EXACTE, la sous-page /settings/ads
  // doit donc être allowlistée explicitement.
  ["/settings/ads", "parametres"],
  // STUDIO MÉTIER (réouverture demandée par le propriétaire — « les
  // utilisateurs n'ont plus accès au projet ») : hub complet (agents,
  // clients, documents, finance, marketing, opérations, résultats,
  // ventes, conformité, vidéo, création). Exception : /studio/console
  // reste RESTREINT (IDE développeur — voir RESTRICTED_PAGE_EXACT).
  ["/studio", "studio"],
  // AGENT LIVE (réouverture demandée) : PC (partage d'écran) ET
  // Android (caméra) — le panneau adapte sa source selon l'appareil.
  ["/live", "live"],
];

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

/** Normalise un chemin (retire query/hash, supprime le ou les `/` finaux, sauf racine). */
export function normalizePathname(pathname: string): string {
  let end = pathname.length;
  const queryIndex = pathname.indexOf("?");
  if (queryIndex >= 0) end = Math.min(end, queryIndex);
  const hashIndex = pathname.indexOf("#");
  if (hashIndex >= 0) end = Math.min(end, hashIndex);

  const path = pathname.slice(0, end) || "/";
  if (path.length > 1 && path.endsWith("/")) {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.length > 0 ? trimmed : "/";
  }
  return path;
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Décision d'accès pour une route API (/api/**). */
export function classifyApiPath(pathname: string): PathDecision {
  const path = normalizePathname(pathname);

  const exact = PUBLIC_API_EXACT[path];
  if (exact) return { access: "public", family: exact };

  for (const [prefix, family] of PUBLIC_API_PREFIXES) {
    if (matchesPrefix(path, prefix)) return { access: "public", family };
  }

  // Exceptions RESTREINTES avant la liste blanche : l'orchestration du
  // système agent reste interdite même avec /api/agents ouvert.
  for (const [prefix, family] of RESTRICTED_API_PREFIXES) {
    if (matchesPrefix(path, prefix)) return { access: "restreint", family };
  }

  for (const [prefix, family] of USER_API_PREFIXES) {
    if (matchesPrefix(path, prefix)) return { access: "user", family };
  }

  return { access: "restreint", family: "systeme" };
}

function hasStaticExtension(path: string): boolean {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  if (dot <= 0) return false; // pas d'extension, ou fichier caché (.env…)
  return STATIC_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/** Décision d'accès pour une page (hors /api/**). */
export function classifyPagePath(pathname: string): PathDecision {
  const path = normalizePathname(pathname);

  const exact = PUBLIC_PAGE_EXACT[path];
  if (exact) return { access: "public", family: exact };

  for (const [prefix, family] of PUBLIC_PAGE_PREFIXES) {
    if (matchesPrefix(path, prefix)) return { access: "public", family };
  }

  // Exceptions RESTREINTES avant la liste blanche : /studio/console
  // (IDE développeur) reste interdit même avec /studio ouvert.
  for (const [prefix, family] of RESTRICTED_PAGE_PREFIXES) {
    if (matchesPrefix(path, prefix)) return { access: "restreint", family };
  }

  const userExact = USER_PAGE_EXACT[path];
  if (userExact) return { access: "user", family: userExact };

  for (const [prefix, family] of USER_PAGE_PREFIXES) {
    if (matchesPrefix(path, prefix)) return { access: "user", family };
  }

  // Assets statiques de /public : jamais bloqués (icônes, images, SW…).
  if (hasStaticExtension(path)) return { access: "public", family: "public" };

  return { access: "restreint", family: "systeme" };
}

export function isPublicApiPath(pathname: string): boolean {
  return classifyApiPath(pathname).access === "public";
}

export function isUserAllowedApiPath(pathname: string): boolean {
  return classifyApiPath(pathname).access === "user";
}

export function isPublicPagePath(pathname: string): boolean {
  return classifyPagePath(pathname).access === "public";
}

export function isUserAllowedPagePath(pathname: string): boolean {
  return classifyPagePath(pathname).access === "user";
}

/* ------------------------------------------------------------------ */
/* Admin — custom claim + rôle plateforme (annuaire partagé)           */
/* ------------------------------------------------------------------ */

/**
 * Un admin est reconnu par le custom claim Firebase `admin: true`
 * (porté par le Bearer, vérifié RS256 avant cet appel) — même convention
 * que requireAdmin (lib/security/admin-access.ts). Les claims du cookie
 * de session ne portent JAMAIS de privilèges : pour un utilisateur en
 * cookie, le rôle est résolu via l'annuaire plateforme (même source que
 * getPlatformAccess / app/admin/layout.tsx).
 */
export function isAdminActor(claims: Record<string, unknown> | undefined | null): boolean {
  return claims?.admin === true;
}

export type AdminRoleLoader = (uid: string) => Promise<boolean>;

export interface CachedAdminResolverOptions {
  /** Durée de vie du cache positif/négatif (défaut : 60 s). */
  ttlMs?: number;

  /** Nombre maximum d'entrées ( éviction FIFO — défaut : 1 000). */
  maxEntries?: number;
}

/**
 * Résolveur « cet utilisateur est-il admin ? » avec cache mémoire court.
 * Les décisions RESTREINTES sont rares (l'essentiel du trafic passe par
 * les chemins publics/allowlistés sans aucun appel) ; le cache borne le
 * coût de l'annuaire quand un client sonde des chemins interdits.
 * Les ERREURS du chargeur ne sont JAMAIS mises en cache : l'appelant
 * décide du repli (fail-closed chez gen3ia → traité comme standard).
 */
export function createCachedAdminResolver(
  loadRole: AdminRoleLoader,
  options: CachedAdminResolverOptions = {},
): AdminRoleLoader {
  const ttlMs = options.ttlMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 1_000;
  const cache = new Map<string, { value: boolean; expiresAt: number }>();

  return (uid: string): Promise<boolean> => {
    const hit = cache.get(uid);
    if (hit && hit.expiresAt > Date.now()) {
      return Promise.resolve(hit.value);
    }

    return loadRole(uid).then((value) => {
      if (cache.size >= maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(uid, { value, expiresAt: Date.now() + ttlMs });
      return value;
    });
  };
}
