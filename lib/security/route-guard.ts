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
  securityHeaders,
} from "./request-security";

export interface RouteContext {
  userId: string;

  email?: string;

  claims?: Record<
    string,
    unknown
  >;
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
    const limit = rateLimit(
      `${routeKey}:${user.uid}`,
      options.rateLimit ?? { limit: 240, windowMs: 5 * 60 * 1000 },
    );

    if (!limit.allowed) {
      return {
        ok: false,
        response: tooManyRequests(limit.retryAfterMs),
      };
    }

    return {
      ok: true,

      context: {
        userId: user.uid,

        email: user.email,

        claims: user.claims,
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
