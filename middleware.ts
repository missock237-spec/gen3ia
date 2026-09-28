import { NextRequest, NextResponse } from "next/server";

import { detectDeviceFromHeaders } from "@/lib/device/detect";

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
  "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com https://www.googleapis.com https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.googleadservices.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss:",
  // Google AdSense (Task 40) : les annonces se rendent dans des iframes
  // servies par googleads.g.doubleclick.net et tpc.googlesyndication.com.
  "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://*.firebaseio.com https://content.googleapis.com https://googleads.g.doubleclick.net https://*.googlesyndication.com https://*.doubleclick.net",
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
const TRACE_HEADER = "x-gen3ia-trace-id";
const TRACE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/** Id entrant réutilisé s'il est sain (anti-injection dans les logs), sinon remplacé. */
function traceIdEntrant(request: NextRequest): string | undefined {
  const value = request.headers.get(TRACE_HEADER)?.trim();
  return value && TRACE_ID_RE.test(value) ? value : undefined;
}

/** Id court unique et cryptographiquement sûr (audit 09-2026 : crypto.randomUUID
 *  remplace Math.random(), non cryptographique). Disponible nativement dans le
 *  runtime Edge. Format trc_<uuid> = 40 caractères, conforme à TRACE_ID_RE. */
function genererTraceId(): string {
  return `trc_${crypto.randomUUID()}`;
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

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const hasClientAccess = Boolean(getClientEntry(request));
  const isClientEntry = isClientRoute(pathname);
  const isAllowedClientRequest = isClientEntry || isPublicClientApi(pathname) || pathname.startsWith("/_next/") || pathname === "/favicon.ico";

  // Un lien client ouvre un espace isolé : tant que ce marqueur existe,
  // aucune page de l'application n'est accessible depuis ce navigateur.
  if (hasClientAccess && !isAllowedClientRequest) {
    return NextResponse.redirect(new URL(getClientEntry(request) ?? "/client", request.url));
  }

  // Detection automatique d'appareils : le resultat est expose aux pages
  // serveur et aux routes API via les en-tetes x-gen3ia-device-*.
  const device = detectDeviceFromHeaders(request.headers);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-gen3ia-device", device.type);
  requestHeaders.set("x-gen3ia-device-os", device.os);
  requestHeaders.set("x-gen3ia-device-app", device.isDesktopApp ? "desktop-app" : "web");

  // Corrélation : on réutilise l'id de l'appelant s'il est sain, sinon on
  // en génère un. Propagé aux routes API via les request headers ET écho
  // sur TOUTES les réponses /api/* (surveillance externe + support).
  const isApiRoute = pathname.startsWith("/api/");
  const traceId = traceIdEntrant(request) ?? genererTraceId();
  if (isApiRoute) {
    requestHeaders.set(TRACE_HEADER, traceId);
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
  const isArtefactPreview = pathname === "/preview" || pathname.startsWith("/preview/");

  if (isApiRoute) {
    response.headers.set(TRACE_HEADER, traceId);
  }
  response.headers.set("X-Gen3ia-Device", device.type);
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

export const config = {
  // Correspond à toutes les routes SAUF les assets statiques Next (qui
  // reçoivent déjà les en-têtes de next.config.ts headers()) et le favicon.
  //
  // ⚠️ /api est VOLONTAIREMENT inclus (décision audit 09-2026, point 11) :
  // 1. trace-id x-gen3ia-trace-id posé ET écho sur chaque réponse API
  //    (corrélation logs serveur ↔ client, support production) ;
  // 2. en-têtes de sécurité (CSP, COOP, nosniff…) sur TOUTES les réponses
  //    API — les routes API en déclarent elles-mêmes une partie, le
  //    middleware garantit la couverture des routes qui l'oublieraient ;
  // 3. l'isolation client (cookie gen3ia_client_access) doit pouvoir
  //    intercepter les appels API d'un navigateur client isolé ;
  // 4. détection d'appareil propagée aux routes API (x-gen3ia-device-*).
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
