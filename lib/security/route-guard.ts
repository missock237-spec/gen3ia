import {
  NextRequest,
  NextResponse,
} from "next/server";

import {
  requireUser,
} from "./authenticated-request";

import {
  rateLimit,
} from "./rate-limit";

import {
  rateLimitDistributed,
} from "@/lib/cache/redis";

import {
  securityHeaders,
} from "./request-security";

import {
  requestTraceId,
  traceLogger,
} from "@/lib/observability/logger";

import {
  classifyApiPath,
  createCachedAdminResolver,
  isAdminActor,
} from "./user-access";

/**
 * Liste blanche d'accès utilisateur (demande n°7) — SECONDE BARRIÈRE.
 *
 * Le middleware (middleware.ts) applique le contrôle deny-by-default sur
 * TOUTES les requêtes ; protectRoute le ré-applique au niveau de la route
 * (défense en profondeur : un contournement du middleware ne suffit pas).
 * Même source de vérité : lib/security/user-access.ts.
 *
 * L'admin est reconnu par le custom claim `admin: true` (porté par le
 * Bearer Firebase vérifié) ou, à défaut, par le rôle plateforme résolu
 * via l'annuaire (même source que getPlatformAccess) avec un cache
 * mémoire court — les erreurs d'annuaire ne sont jamais cachées et
 * aboutissent à un refus (fail-closed, cohérent avec l'écran admin
 * « espace restreint »).
 */
const adminByPlatformRole = createCachedAdminResolver(async (uid) => {
  const { getPlatformRole } = await import("@/lib/access/platform");
  const role = await getPlatformRole(uid);
  return role === "admin";
});

async function isAccessAllowlisted(
  pathname: string,
  user: AuthenticatedUserLike,
): Promise<boolean> {
  const decision = classifyApiPath(pathname);
  if (decision.access !== "restreint") return true;

  if (isAdminActor(user.claims)) return true;
  try {
    return await adminByPlatformRole(user.uid);
  } catch {
    return false;
  }
}

/** Sous-ensemble d'AuthenticatedUser utilisé par la liste blanche. */
interface AuthenticatedUserLike {
  uid: string;

  claims?: Record<
    string,
    unknown
  >;
}

function accessForbidden(traceId: string): NextResponse {
  const response =
    NextResponse.json(
      {
        success: false,

        error:
          "Accès refusé : cette fonctionnalité n'est pas disponible pour votre compte.",
      },
      {
        status: 403,
        headers: { "x-gen3ia-trace-id": traceId },
      },
    );

  securityHeaders(
    response.headers,
  );

  return response;
}

export interface RouteContext {
  userId: string;

  email?: string;

  claims?: Record<
    string,
    unknown
  >;

  /** Identifiant de corrélation de la requête (logs + header réponse). */
  traceId: string;
}

export interface RouteGuardOptions {
  /** Cle de limitation (defaut : chemin de la route). */
  key?: string;

  /** Limitation de debit par utilisateur (defaut : 240 req / 5 min). */
  rateLimit?: {
    limit: number;

    windowMs: number;
  };
}

function tooManyRequests(retryAfterMs: number): NextResponse {
  const response = NextResponse.json(
    {
      success: false,

      error: "Trop de requetes. Reessayez un peu plus tard.",
    },
    {
      status: 429,
      headers: {
        "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
      },
    },
  );

  securityHeaders(
    response.headers,
  );

  return response;
}

export async function protectRoute(
  request: NextRequest,
  options: RouteGuardOptions = {},
): Promise<
  | {
      ok: true;
      context: RouteContext;
    }
  | {
      ok: false;
      response: NextResponse;
    }
> {
  try {
    const user =
      await requireUser(
        request,
      );

    const routeKey = options.key ?? new URL(request.url).pathname;
    const traceId = requestTraceId(request);

    // Barrière n°2 — liste blanche utilisateur (demande n°7) : un
    // utilisateur standard (non admin) ne peut atteindre que les familles
    // autorisées ; le contrôle est AVANT le compteur de débit (un refus
    // 403 ne consomme pas de quota).
    const allowlisted = await isAccessAllowlisted(
      new URL(request.url).pathname,
      user,
    );

    if (!allowlisted) {
      traceLogger(traceId, { userId: user.uid, route: routeKey }).warn({ event: "request.access_denied" }, "Chemin hors liste blanche utilisateur");
      return {
        ok: false,
        response: accessForbidden(traceId),
      };
    }
    const limitKey = `${routeKey}:${user.uid}`;
    const limitConfig = options.rateLimit ?? { limit: 240, windowMs: 5 * 60 * 1000 };

    // Couche 1 — locale (instantanée, protège l'instance courante).
    const limit = rateLimit(limitKey, limitConfig);

    // Couche 2 — rate limit process-local par clé (fenêtre fixe, même
    // API conservée). Task 108 : le service externe Redis a été supprimé ;
    // la protection reste réelle par instance (jamais de blocage pour
    // autant).
    const distributed = await rateLimitDistributed(limitKey, limitConfig);

    const allowed = limit.allowed && distributed.allowed;
    const retryAfterMs = limit.allowed ? distributed.retryAfterMs : limit.retryAfterMs;

    if (!allowed) {
      traceLogger(traceId, { userId: user.uid, route: routeKey }).warn({ event: "request.rate_limited", distributed: distributed.distributed }, "Rate limit atteint");
      return {
        ok: false,
        response: tooManyRequests(retryAfterMs),
      };
    }

    traceLogger(traceId, { userId: user.uid, route: routeKey }).info({ event: "request.authorized" }, "Accès autorisé");

    return {
      ok: true,

      context: {
        userId: user.uid,

        email: user.email,

        claims: user.claims,

        traceId,
      },
    };
  } catch (error) {
    const response =
      NextResponse.json(
        {
          success: false,

          error:
            error instanceof Error
              ? error.message
              : "Unauthorized",
        },
        {
          status: 401,
          headers: { "x-gen3ia-trace-id": requestTraceId(request) },
        },
      );

    securityHeaders(
      response.headers,
    );

    return {
      ok: false,
      response,
    };
  }
}
