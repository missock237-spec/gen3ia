import { NextRequest } from "next/server";

import {
  forbidden,
  HttpError,
} from "./http-errors";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

const BLOCKED_HEADERS = [
  "x-forwarded-host",
];

/**
 * Méthodes qui modifient l'état serveur : seules celles-ci sont soumises à
 * la vérification d'origine. Les requêtes GET (lecture) restent ouvertes aux
 * navigations entrantes légitimes.
 */
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Défense CSRF en profondeur pour l'authentification par cookie de session.
 *
 * Le cookie `gen3ia_session` est SameSite=Lax (les POST cross-site ne le
 * transportent pas sur les navigateurs modernes) MAIS cette protection reste
 * nécessaire pour : les navigateurs anciens, les attaques same-site via un
 * sous-domaine compromis, et tout futur changement d'attribut du cookie.
 *
 * Règle : sur une requête modifiant l'état, si le navigateur a transmis un
 * en-tête Origin ou Referer, son hôte DOIT correspondre à l'hôte de la
 * requête. Absence des deux en-têtes = autorisé (clients non-navigateurs :
 * appels serveur à serveur, SDK, webhooks — qui s'authentifient par Bearer
 * ou par signature et ne sont donc pas concernés par le CSRF).
 *
 * L'authentification Bearer Firebase est structurellement immunisée au CSRF
 * (un attaquant ne peut pas définir le header Authorization cross-origin) :
 * la vérification est une couche de défense supplémentaire, jamais un
 * frein pour les clients légitimes de l'application (même origine).
 */
function verifierOrigine(request: NextRequest): void {
  if (!STATE_CHANGING_METHODS.has(request.method)) return;

  const host = request.headers.get("host")?.toLowerCase();
  if (!host) return;

  const origin = request.headers.get("origin")?.trim();
  if (origin) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost !== host) {
        throw forbidden("Requête cross-origin refusée pour cette action.");
      }
      return; // Origin présent et valide : source d'information la plus fiable.
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Origin malformé : on tente le Referer avant de conclure.
    }
  }

  const referer = request.headers.get("referer")?.trim();
  if (referer) {
    try {
      const refererHost = new URL(referer).host.toLowerCase();
      if (refererHost !== host) {
        throw forbidden("Requête cross-origin refusée pour cette action.");
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // Referer malformé : ignoré (Origin absent + Referer invalide = neutre).
    }
  }
}

export function validateRequest(
  request: NextRequest,
): void {
  verifierOrigine(request);

  const contentLength =
    request.headers.get("content-length");

  if (contentLength) {
    const size = Number(contentLength);

    if (
      Number.isFinite(size) &&
      size > MAX_BODY_BYTES
    ) {
      throw new Error(
        "Request body too large",
      );
    }
  }

  for (
    const header of BLOCKED_HEADERS
  ) {
    // Cas particulier : derriere un reverse proxy de confiance (Vercel),
    // `x-forwarded-host` est ajoute par la plateforme a CHAQUE requete.
    // On ne le refuse que s'il entre en conflit avec le Host reel de la
    // requete (tentative de spoofing), sinon toute l'API serait bloquee
    // en production. Hors proxy, le blocage strict reste actif.
    if (header === "x-forwarded-host") {
      const forwarded =
        request.headers.get(header);

      const forwardedHost = forwarded
        ?.split(",")[0]
        ?.trim();

      const host =
        request.headers.get("host");

      if (
        forwardedHost &&
        host &&
        forwardedHost !== host
      ) {
        throw new Error(
          `Blocked request header: ${header}`,
        );
      }

      continue;
    }

    if (request.headers.has(header)) {
      throw new Error(
        `Blocked request header: ${header}`,
      );
    }
  }
}

export function securityHeaders(
  headers = new Headers(),
): Headers {
  headers.set(
    "X-Content-Type-Options",
    "nosniff",
  );

  headers.set(
    "X-Frame-Options",
    "DENY",
  );

  headers.set(
    "Referrer-Policy",
    "strict-origin-when-cross-origin",
  );

  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );

  // Alignées sur next.config.ts : isolation cross-origin des réponses API.
  headers.set(
    "Cross-Origin-Opener-Policy",
    "same-origin-allow-popups",
  );

  headers.set(
    "Cross-Origin-Resource-Policy",
    "same-origin",
  );

  headers.set(
    "X-DNS-Prefetch-Control",
    "off",
  );

  headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "font-src 'self' https: data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' https:",
      "frame-ancestors 'none'",
    ].join("; "),
  );

  return headers;
}
