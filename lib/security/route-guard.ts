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
    const limitKey = `${routeKey}:${user.uid}`;
    const limitConfig = options.rateLimit ?? { limit: 240, windowMs: 5 * 60 * 1000 };

    // Couche 1 — locale (instantanée, protège l'instance courante).
    const limit = rateLimit(limitKey, limitConfig);

    // Couche 2 — distribuée (Redis Upstash, partagée par toutes les
    // instances serverless). Absente/indisponible = repli transparent
    // sur la décision locale uniquement (jamais de blocage pour autant).
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
