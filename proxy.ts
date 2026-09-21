import { NextRequest, NextResponse } from "next/server";

import { detectDeviceFromHeaders } from "@/lib/device/detect";

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

const CLIENT_ACCESS_COOKIE = "gen3ia_client_access";

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

  // Detection automatique d'appareils : le resultat est expose aux pages
  // serveur et aux routes API via les en-tetes x-gen3ia-device-*.
  const device = detectDeviceFromHeaders(request.headers);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-gen3ia-device", device.type);
  requestHeaders.set("x-gen3ia-device-os", device.os);
  requestHeaders.set("x-gen3ia-device-app", device.isDesktopApp ? "desktop-app" : "web");

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  if (isClientEntry) {
    response.cookies.set(CLIENT_ACCESS_COOKIE, pathname, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  }

  response.headers.set("X-Gen3ia-Device", device.type);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self), geolocation=()");
  response.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  response.headers.set("X-DNS-Prefetch-Control", "off");

  if (process.env.NODE_ENV === "production") {
    response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
