import { NextRequest, NextResponse } from "next/server";

import { classerChemin, enregistrerRequete } from "@/lib/observability/metrics-registry";
import {
  formaterTraceparent,
  GEN3IA_TRACE_HEADER,
  parserTraceparent,
  TRACEPARENT_HEADER,
  type TraceparentW3C,
} from "@/lib/observability/trace-w3c";
import { detectDeviceFromHeaders } from "@/lib/device/detect";

import {
  classifyApiPath,
  classifyPagePath,
  createCachedAdminResolver,
  isAdminActor,
} from "@/lib/security/user-access";
import { deciderMutationApi } from "@/lib/security/api-gate";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // Firebase Auth (connexion Google/GitHub) : l'iframe d'événements
  // (authDomain/__/auth/iframe, usegapi=1) charge gapi depuis
  // apis.google.com DANS le contexte héritant cette politique — un
  // script-src restreint produisait auth/internal-error sur TOUS les
  // logins OAuth (bug 07-2025). gstatic + googleapis : Google Identity
  // Services et reCAPTCHA (téléphonie).
  // ⚠️ PAS de 'unsafe-eval' (audit 09-2026) : Firebase Auth n'en a pas
  // besoin (unsafe-inline suffit) et eval ouvre une faille XSS. Les seules
  // surfaces exécutant du code utilisateur (apps artefact : ECharts, React
  // CDN, Babel) reçoivent la CSP ARTEFACT dédiée ci-dessous.
  // Google AdSense (Task 40) : loader pagead2 + sous-scripts dynamiques
  // (tpc.googlesyndication.com via *.googlesyndication.com), suivi de clic
  // doubleclick/googleadservices. Le rendu réel passe par des iframes
  // (frame-src ci-dessous) ; le push window.adsbygoogle est inline (déjà
  // couvert par 'unsafe-inline').
  // Widgets de paiement Chariow (/billing) : loader officiel
  // js.chariowcdn.com (widget.min.js + widget.min.css) — domaine unique,
  // sans eval ; les checkout s'ouvrent en iframe/redirect vers la boutique
  // *.mychariow.shop (frame-src + connect-src ci-dessous).
  "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com https://www.googleapis.com https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.googleadservices.com https://js.chariowcdn.com",
  "style-src 'self' 'unsafe-inline' https://js.chariowcdn.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' blob: https:",
  // Allowlist CONNECT-SRC explicite (Task 60, priorité #4 — remplace
  // « https: wss: » ouverts). Audit des domaines réellement appelés par le
  // NAVIGATEUR :
  //   - Firebase (client Auth uniquement) : identitytoolkit / securetoken /
  //     installations / logging + canal web-channel → *.googleapis.com
  //     (motif recommandé par la documentation Firebase) et canaux
  //     websocket Firebase (RTDB futur) ; gapi (apis.google.com) + gstatic
  //     pour le tunnel auth (cf. bug 07-2025 ci-dessus) ;
  //   - Sentry (SDK navigateur, DSN public) : hôtes d'ingestion
  //     o4511820262473728.ingest.de.sentry.io + replis (cf.
  //     SENTRY_INGEST_HOSTS dans instrumentation.ts) ;
  //   - Google AdSense (Task 40) : beacons du loader et suivi de clic
  //     (googlesyndication, doubleclick, googleadservices) ;
  //   - Composio, Upstash, Qdrant, Agnes/Groq, webhooks sortants :
  //     appels SERVEUR uniquement — volontairement ABSENTS de la CSP
  //     navigateur (aucun fetch direct depuis le client).
  "connect-src 'self' https://apis.google.com https://*.googleapis.com https://www.gstatic.com https://*.firebaseio.com wss://*.googleapis.com wss://*.firebaseio.com https://o4511820262473728.ingest.de.sentry.io https://ingest.de.sentry.io https://ingest.sentry.io https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.googleadservices.com https://js.chariowcdn.com https://*.mychariow.shop",
  // Google AdSense (Task 40) : les annonces se rendent dans des iframes
  // servies par googleads.g.doubleclick.net et tpc.googlesyndication.com.
  // Widgets Chariow (/billing) : iframe de checkout servie par le CDN widget
  // et la boutique (xdaagetk.mychariow.shop → *.mychariow.shop).
  "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://*.firebaseio.com https://content.googleapis.com https://googleads.g.doubleclick.net https://*.googlesyndication.com https://*.doubleclick.net https://js.chariowcdn.com https://*.mychariow.shop",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join('; ');

// CSP « ARTEFACT » — surface /preview/* uniquement.
//
// Les pages /preview/<id> servent une APP GÉNÉRÉE PAR L'AGENT rendue dans un
// iframe sandboxé (allow-scripts SANS allow-same-origin : origine opaque, pas
// d'accès aux cookies ni au DOM Gen3ia). Le document iframe est un srcDoc : il
// HÉRITE la CSP de cette réponse — elle doit donc autoriser les CDN que ces
// apps utilisent (ECharts, React 18 CDN, Babel, Tailwind CDN) ainsi qu'eval
// (Babel transpile en navigateur). C'est une sandbox à code utilisateur par
// conception : la périmètre restreint à /preview, le reste de l'app garde la
// CSP stricte. frame-ancestors 'self' : la modale d'aperçu de la conversation
// intègre /preview dans un iframe same-origin.
const ARTEFACT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com https://esm.sh https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdn.tailwindcss.com https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' blob: https:",
  // connect-src ouvert VOLONTAIRE (Task 60) : les apps artefact sont des
  // applications GÉNÉRÉES qui appellent par conception des API choisies
  // par leurs auteurs — une allowlist fixe les casserait. Le risque est
  // borné par la sandbox : iframe sans allow-same-origin (origine opaque,
  // ni cookies ni DOM Gen3ia) — « 'self' » n'y désigne AUCUNE origine
  // Gen3ia et aucune donnée de session n'y est exposée.
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join('; ');

const CLIENT_ACCESS_COOKIE = "gen3ia_client_access";

// Identifiant de corrélation de bout en bout (audit 25-a : les réponses
// /api/* ne portaient aucun trace-id, impossible de relier un log serveur
// à une requête client). Même grammaire que lib/observability/logger.ts
// (requestTraceId) mais en logique autonome : le module logger importe
// "server-only", interdit dans le runtime Edge du middleware.
//
// W3C TRACE CONTEXT (Task K) : le standard traceparent est accepté EN
// COMPLÉMENT (jamais à la place de la clé primaire custom). Le couple
// (x-gen3ia-trace-id, traceparent) est émis ENSEMBLE partout où l'en-tête
// custom l'était déjà — réponses API, propagation aval (requestHeaders)
// et 403 de la liste blanche. Logique 100 % autonome (module PUR
// lib/observability/trace-w3c.ts, sans server-only) : exécutable aux
// runtimes Edge comme Node.
const TRACE_HEADER = GEN3IA_TRACE_HEADER;
const TRACE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/** Id entrant réutilisé s'il est sain (anti-injection dans les logs), sinon remplacé. */
function traceIdEntrant(request: NextRequest): string | undefined {
  const value = request.headers.get(TRACE_HEADER)?.trim();
  return value && TRACE_ID_RE.test(value) ? value : undefined;
}

/**
 * Traceparent W3C entrant, décomposé et validé (Task K) : un traceparent
 * malformé est simplement IGNORÉ (on retombe sur la génération Gen3ia) —
 * jamais d'exception, jamais de valeur non validée réémise.
 */
function traceparentEntrant(request: NextRequest): TraceparentW3C | undefined {
  return parserTraceparent(request.headers.get(TRACEPARENT_HEADER));
}

/** Id court unique et cryptographiquement sûr (audit 09-2026 : crypto.randomUUID
 *  remplace Math.random(), non cryptographique). Disponible nativement dans le
 *  runtime Edge. Format trc_<uuid> = 40 caractères, conforme à TRACE_ID_RE. */
function genererTraceId(): string {
  return `trc_${crypto.randomUUID()}`;
}

/* ------------------------------------------------------------------ */
/* SLI — hook de métriques HTTP (Task G — SRE)                          */
/*                                                                      */
/* Chaque requête passant par le middleware est enregistrée dans le     */
/* registre in-memory (lib/observability/metrics-registry.ts) : classe   */
/* de route à CARDINALITÉ BORNÉE (chat/api/pages/static — JAMAIS le     */
/* chemin brut), famille de statut, durée. Coût : une Map.set + un push */
/* ring buffer — aucun I/O, aucune allocation hors registre.            */
/*                                                                      */
/* ⚠️ Périmètre de mesure : le middleware mesure SON traitement et le   */
/* statut de SA réponse (200 continuation / 307 redirection / 403). Les */
/* 5xx produits en aval par un route handler ne passent pas ici — la    */
/* source complémentaire reste les logs d'accès nginx (cf.              */
/* docs/sre/sli-slo.md).                                                */
/* ------------------------------------------------------------------ */

/** Enregistre la requête courante dans le registre SLI — échec silencieux : */
/** la télémétrie ne doit JAMAIS perturber le trafic (ni latence, ni erreur). */
function noterRequeteSLI(chemin: string, statut: number, debutMs: number): void {
  try {
    enregistrerRequete(classerChemin(chemin), statut, performance.now() - debutMs);
  } catch {
    // Volontairement muet : la perte d'une mesure est acceptable, une
    // perturbation du trafic ne l'est pas.
  }
}

function isClientRoute(pathname: string) {
  return /^\/client\/[^/]+$/.test(pathname);
}

function getClientEntry(request: NextRequest) {
  const value = request.cookies.get(CLIENT_ACCESS_COOKIE)?.value;
  return value?.startsWith("/client/") ? value : undefined;
}

function isPublicClientApi(pathname: string) {
  return pathname === "/api/public" || pathname.startsWith("/api/public/");
}

/* ------------------------------------------------------------------ */
/* LISTE BLANCHE D'ACCÈS UTILISATEUR (demande n°7 — deny-by-default)   */
/*                                                                     */
/* La classification des chemins (public / utilisateur / restreint)    */
/* vit dans lib/security/user-access.ts — source centrale testée.      */
/* Ici : application du contrôle pour TOUTES les requêtes (pages+API), */
/* APRÈS l'isolation portail client (préservée en premier verrou).     */
/*                                                                     */
/*   restreint + ANONYME            → passage (comportement existant : */
/*                                    401 levé par la route API,       */
/*                                    redirection login côté client)   */
/*   restreint + UTILISATEUR        → 403 (JSON API / page HTML)       */
/*   restreint + ADMIN              → passage (accès complet)          */
/*                                                                     */
/* L'admin est reconnu par le custom claim Firebase vérifié (Bearer)   */
/* OU par le rôle plateforme (même annuaire que getPlatformAccess,     */
/* cache mémoire 60 s). Runtime NODE requis : vérification RS256 du    */
/* Bearer + HMAC du cookie de session + annuaire (node:crypto, fetch). */
/* ------------------------------------------------------------------ */

const adminRoleResolver = createCachedAdminResolver(async (uid) => {
  // Même source de vérité que lib/access/platform.ts (app/admin,
  // /api/auth/access) : claims Bearer puis annuaire plateforme.
  const { getPlatformRole } = await import("@/lib/access/platform");
  const role = await getPlatformRole(uid);
  return role === "admin";
});

async function isAdminByPlatformRole(uid: string): Promise<boolean> {
  try {
    // Une panne de l'annuaire n'est JAMAIS mise en cache et ne bloque
    // que la décision courante (fail-closed : traité comme standard —
    // c'est l'écran « espace restreint » actuel des pages admin).
    return await adminRoleResolver(uid);
  } catch {
    return false;
  }
}

function applySecurityHeaders(response: NextResponse, isArtefactPreview: boolean): NextResponse {
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", isArtefactPreview ? "SAMEORIGIN" : "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  // Audit 09-2026 : valeurs IDENTIQUES à next.config.ts (headers()) — deux
  // en-têtes contradictoires (ex. camera=() vs camera=(self)) font que le
  // navigateur applique l'intersection et casse micro/caméra. display-capture
  // accompagne le micro/caméra (Live Voice), geolocation reste refusée.
  response.headers.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
  response.headers.set("Content-Security-Policy", isArtefactPreview ? ARTEFACT_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("X-DNS-Prefetch-Control", "off");

  if (process.env.NODE_ENV === "production") {
    // Audit 09-2026 : HSTS unifié partout (next.config.ts + middleware) —
    // 2 ans, sous-domaines inclus, preload (éligible HSTS preload list).
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return response;
}

const FORBIDDEN_PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>403 — Accès refusé · Gen3ia</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #101014; color: #f2f2f5; font-family: system-ui, sans-serif; }
  main { text-align: center; padding: 2rem; max-width: 34rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .75rem; }
  p { color: #a9a9b8; line-height: 1.6; margin: 0; }
  code { color: #d9d9e3; }
</style>
</head>
<body>
<main>
  <h1>403 — Accès refusé</h1>
  <p>Cette fonctionnalité n'est pas accessible avec votre compte.
     Les espaces disponibles : chat IA, entraînement, connecteurs,
     planifications, équipe, publicité, clients ID, business,
     facturation, paramètres, compte, connaissances, projets, fichiers,
     automatisation, intégrations, observabilité et mémoire permanente.</p>
</main>
</body>
</html>`;

function forbiddenApi(traceId: string, traceparent: string): NextResponse {
  const response = NextResponse.json(
    {
      success: false,
      error: "Accès refusé : cette fonctionnalité n'est pas disponible pour votre compte.",
    },
    { status: 403, headers: { [TRACE_HEADER]: traceId, [TRACEPARENT_HEADER]: traceparent } },
  );
  return applySecurityHeaders(response, false);
}

/**
 * 401 de la GARDE D'AUTH OBLIGATOIRE (P0 — lib/security/api-gate.ts) :
 * mutation d'API non publique sans identité cryptographiquement vérifiée
 * (Bearer RS256 Firebase ou cookie de session HMAC). La requête n'atteint
 * JAMAIS la route — un anonyme ne peut plus écrire sur une seule route
 * métier, y compris une future route oubliée.
 */
function unauthorizedApi(traceId: string, traceparent: string, raison: string): NextResponse {
  const response = NextResponse.json(
    { success: false, error: raison, code: "AUTH_REQUIRED" },
    { status: 401, headers: { [TRACE_HEADER]: traceId, [TRACEPARENT_HEADER]: traceparent } },
  );
  return applySecurityHeaders(response, false);
}

function forbiddenPage(): NextResponse {
  const response = new NextResponse(FORBIDDEN_PAGE_HTML, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  return applySecurityHeaders(response, false);
}

/**
 * Contrôle d'accès deny-by-default. Retourne une réponse 403 si un
 * utilisateur standard (identifié, non admin) tente d'atteindre un chemin
 * hors liste blanche ; `null` sinon (chemin autorisé, ou anonyme — le
 * comportement d'auth existant s'applique alors sans changement).
 */
async function applyAccessControl(
  request: NextRequest,
  pathname: string,
  isApiRoute: boolean,
  traceId: string,
  traceparent: string,
): Promise<NextResponse | null> {
  const decision = isApiRoute ? classifyApiPath(pathname) : classifyPagePath(pathname);
  if (decision.access !== "restreint") return null;

  // 1) Bearer Firebase JWT (RS256 vérifié) — seul chemin qui porte le
  //    custom claim admin (convention requireAdmin).
  const authorization = request.headers.get("authorization");
  let identified = false;
  if (authorization && authorization.toLowerCase().startsWith("bearer ")) {
    try {
      const { verifyFirebaseToken } = await import("@/lib/firebase/auth-server");
      const token = await verifyFirebaseToken(authorization);
      identified = true;
      if (isAdminActor(token as unknown as Record<string, unknown>)) return null;
      if (await isAdminByPlatformRole(token.uid)) return null;
    } catch {
      // Bearer absent/invalide : on tente le cookie de session (même
      // sémantique de repli que requireUser), sinon anonyme.
    }
  }

  // 2) Cookie de session signé gen3ia_session (HMAC serveur). Il ne
  //    transporte jamais de claims : le rôle passe par l'annuaire.
  if (!identified) {
    const { readSessionCookie } = await import("@/lib/server/session-cookie");
    const session = readSessionCookie(request.headers.get("cookie"));
    if (session) {
      identified = true;
      if (await isAdminByPlatformRole(session.uid)) return null;
    }
  }

  // 3) Anonyme : comportement existant strictement inchangé.
  if (!identified) return null;

  return isApiRoute ? forbiddenApi(traceId, traceparent) : forbiddenPage();
}

export async function middleware(request: NextRequest) {
  // SLI : horodatage de début (performance.now() = précision sous-ms).
  const debutMs = performance.now();
  const pathname = request.nextUrl.pathname;
  const hasClientAccess = Boolean(getClientEntry(request));
  const isClientEntry = isClientRoute(pathname);
  const isAllowedClientRequest = isClientEntry || isPublicClientApi(pathname) || pathname.startsWith("/_next/") || pathname === "/favicon.ico";

  // Un lien client ouvre un espace isolé : tant que ce marqueur existe,
  // aucune page de l'application n'est accessible depuis ce navigateur.
  if (hasClientAccess && !isAllowedClientRequest) {
    const redirectionClient = NextResponse.redirect(new URL(getClientEntry(request) ?? "/client", request.url));
    noterRequeteSLI(pathname, redirectionClient.status, debutMs);
    return redirectionClient;
  }

  const isApiRoute = pathname.startsWith("/api/");
  const isArtefactPreview = pathname === "/preview" || pathname.startsWith("/preview/");

  // Corrélation (Task K) : PRIORITÉ x-gen3ia-trace-id entrant > trace-id
  // W3C extrait d'un traceparent entrant > génération. Un trace-id W3C
  // (32 hex) fait toujours un traceId Gen3ia valide ; un traceparent
  // malformé est ignoré. Le traceparent ÉMIS porte la dérivation
  // déterministe du traceId retenu (continuité d'arbre W3C inter-services)
  // avec un NOUVEAU span-id par requête, et préserve les flags entrants.
  const traceparentRecu = traceparentEntrant(request);
  const traceId = traceIdEntrant(request) ?? traceparentRecu?.traceId ?? genererTraceId();
  const traceparent = formaterTraceparent(traceId, { flags: traceparentRecu?.flags ?? "01" });

  // Liste blanche d'accès (demande n°7) : AVANT la détection d'appareil
  // et la propagation de headers — un 403 n'a besoin de rien d'autre
  // (mais porte déjà le couple de corrélation, support production).
  //
  // GARDE D'AUTH OBLIGATOIRE (P0) — AVANT le contrôle de liste blanche :
  // toute MUTATION d'API non publique exige une identité vérifiée
  // cryptographiquement (RS256 Firebase ou cookie HMAC). Anonyme ou
  // identité invalide → 401 immédiat. Les lectures et les chemins publics
  // (webhooks signés, auth, cron…) poursuivent leur chemin existant.
  // Périmètre strictement /api/* : les Server Actions (POST sur une page)
  // et les navigations ne passent PAS par ce verrou — elles ont leur
  // propre modèle de sécurité (routes + liste blanche pages).
  if (isApiRoute) {
    const porte = await deciderMutationApi(request, pathname);
    if (porte.verdict === "refuser") {
      const refusee = unauthorizedApi(traceId, traceparent, porte.raison);
      noterRequeteSLI(pathname, refusee.status, debutMs);
      return refusee;
    }
  }

  const denied = await applyAccessControl(request, pathname, isApiRoute, traceId, traceparent);
  if (denied) {
    noterRequeteSLI(pathname, denied.status, debutMs);
    return denied;
  }

  // Detection automatique d'appareils : le resultat est expose aux pages
  // serveur et aux routes API via les en-tetes x-gen3ia-device-*.
  const device = detectDeviceFromHeaders(request.headers);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-gen3ia-device", device.type);
  requestHeaders.set("x-gen3ia-device-os", device.os);
  requestHeaders.set("x-gen3ia-device-app", device.isDesktopApp ? "desktop-app" : "web");

  if (isApiRoute) {
    requestHeaders.set(TRACE_HEADER, traceId);
    requestHeaders.set(TRACEPARENT_HEADER, traceparent);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  if (isClientEntry) {
    response.cookies.set(CLIENT_ACCESS_COOKIE, pathname, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  }

  // Surface artefact : CSP dédiée (CDN + eval confinés au sandbox à code
  // utilisateur) + X-Frame-Options assoupli pour l'intégration same-origin
  // dans la modale d'aperçu. TOUT le reste de l'application garde la CSP
  // stricte et X-Frame-Options SAMEORIGIN.
  if (isApiRoute) {
    response.headers.set(TRACE_HEADER, traceId);
    response.headers.set(TRACEPARENT_HEADER, traceparent);
  }
  response.headers.set("X-Gen3ia-Device", device.type);
  applySecurityHeaders(response, isArtefactPreview);

  // SLI : la continuation middleware est observée avec le statut de SA
  // réponse (200) — le sort de la requête en aval (route handler) est hors
  // de ce périmètre (limitation documentée dans docs/sre/sli-slo.md).
  noterRequeteSLI(pathname, response.status, debutMs);

  return response;
}

export const config = {
  // Correspond à toutes les routes SAUF les assets statiques Next (qui
  // reçoivent déjà les en-têtes de next.config.ts headers()) et le favicon.
  //
  // Conséquence SLI (Task G) : ces chemins exclus ne sont PAS comptés dans
  // /api/metrics (les assets _next/static ne transitent pas par le
  // middleware) — les classes « static » observées couvrent les autres
  // fichiers publics (icônes, manifest, sw.js…).
  //
  // ⚠️ /api est VOLONTAIREMENT inclus (décision audit 09-2026, point 11) :
  // 1. trace-id x-gen3ia-trace-id posé ET écho sur chaque réponse API
  //    (corrélation logs serveur ↔ client, support production) ; le
  //    standard W3C traceparent l'accompagne partout (Task K) — en aval
  //    (requestHeaders des routes) ET en écho de réponse ;
  // 2. en-têtes de sécurité (CSP, COOP, nosniff…) sur TOUTES les réponses
  //    API — les routes API en déclarent elles-mêmes une partie, le
  //    middleware garantit la couverture des routes qui l'oublieraient ;
  // 3. l'isolation client (cookie gen3ia_client_access) doit pouvoir
  //    intercepter les appels API d'un navigateur client isolé ;
  // 4. détection d'appareil propagée aux routes API (x-gen3ia-device-*) ;
  // 5. liste blanche d'accès utilisateur (demande n°7) : pages + API,
  //    deny-by-default, appliquée AVANT les routes.
  //
  // Runtime NODEJS (demande n°7) : le contrôle d'accès doit vérifier
  // réellement l'identité (JWT RS256 Firebase via node:crypto + fetch des
  // certificats Google, HMAC du cookie de session) et résoudre le rôle
  // admin via l'annuaire plateforme — impossible au runtime Edge. Les
  // chemins publics/allowlistés (l'immense majorité du trafic) ne paient
  // AUCUN de ces coûts : la classification est purement synchrone.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
  runtime: "nodejs",
};
