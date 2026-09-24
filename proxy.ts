import { NextRequest, NextResponse } from "next/server";

import { detectDeviceFromHeaders } from "@/lib/device/detect";
import { crossSiteMutationVerdict, trustedOriginsFromEnv } from "@/lib/security/edge-guards";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://*.firebaseio.com",
  "worker-src 'self' blob:",
  "upgrade-insecure-requests",
].join('; ');

// Politique cible, plus stricte, déployée en mode « Report-Only » : le
// navigateur N'APPLIQUE PAS ces règles mais signale chaque violation à
// /api/security/csp-report. Objectif : mesurer en production si
// 'unsafe-eval' peut être retiré sans rien casser avant de l'imposer.
const CONTENT_SECURITY_POLICY_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://*.firebaseio.com",
  "worker-src 'self' blob:",
  "report-uri /api/security/csp-report",
].join("; ");

const TRUSTED_ORIGINS = trustedOriginsFromEnv(process.env);

const CLIENT_ACCESS_COOKIE = "gen3ia_client_access";

// Identifiant de corrélation de bout en bout (audit 25-a : les réponses
// /api/* ne portaient aucun trace-id, impossible de relier un log serveur
// à une requête client). Même grammaire que lib/observability/logger.ts
// (requestTraceId) mais en logique autonome : le module logger importe
// "server-only", interdit dans le runtime Edge du proxy.
const TRACE_HEADER = "x-gen3ia-trace-id";
const TRACE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/** Id entrant réutilisé s'il est sain (anti-injection dans les logs), sinon remplacé. */
function traceIdEntrant(request: NextRequest): string | undefined {
  const value = request.headers.get(TRACE_HEADER)?.trim();
  return value && TRACE_ID_RE.test(value) ? value : undefined;
}

/** Id court unique, même format que requestTraceId (logger serveur). */
function genererTraceId(): string {
  return `trc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
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

export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const hasClientAccess = Boolean(getClientEntry(request));
  const isClientEntry = isClientRoute(pathname);
  const isAllowedClientRequest = isClientEntry || isPublicClientApi(pathname) || pathname.startsWith("/_next/") || pathname === "/favicon.ico";

  // Un lien client ouvre un espace isolé : tant que ce marqueur existe,
  // aucune page de l'application n'est accessible depuis ce navigateur.
  if (hasClientAccess && !isAllowedClientRequest) {
    return NextResponse.redirect(new URL(getClientEntry(request) ?? "/client", request.url));
  }

  // Barrière CSRF centrale : aucune mutation /api/* cross-site ne franchit
  // le proxy, quel que soit le mode d'authentification de la route
  // (Bearer, cookie de session, signature).
  const csrf = crossSiteMutationVerdict(
    {
      method: request.method,
      pathname,
      host: request.headers.get("host"),
      origin: request.headers.get("origin"),
      secFetchSite: request.headers.get("sec-fetch-site"),
    },
    TRUSTED_ORIGINS,
  );
  if (!csrf.allowed) {
    return NextResponse.json(
      { error: "Requête cross-origin refusée pour cette action.", code: "forbidden" },
      { status: 403, headers: { "cache-control": "no-store", "x-gen3ia-block-reason": csrf.reason } },
    );
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

  if (isApiRoute) {
    response.headers.set(TRACE_HEADER, traceId);
  }
  response.headers.set("X-Gen3ia-Device", device.type);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
  response.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("Content-Security-Policy-Report-Only", CONTENT_SECURITY_POLICY_REPORT_ONLY);
  response.headers.set("X-DNS-Prefetch-Control", "off");
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");

  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
