import "server-only";

import pino, { type Logger } from "pino";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "authorization",
  "cookie",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "secret",
  "privateKey",
  "clientSecret",
  "arguments.password",
  "arguments.token",
  "arguments.apiKey",
  "arguments.secret",
];

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: {
    service: "gen3ia-ai-studio",
    environment: process.env.NODE_ENV ?? "development",
  },
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
  serializers: {
    err: pino.stdSerializers.err,
  },
});

export function executionLogger(context: {
  requestId?: string;
  executionId?: string;
  userId?: string;
  agentId?: string;
  stepId?: string;
  toolName?: string;
}): Logger {
  return logger.child(context);
}

const TRACE_HEADER_CANDIDATES = ["x-gen3ia-trace-id", "x-request-id", "x-trace-id"];
const TRACE_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

/**
 * Identifiant de corrélation par requête : réutilise celui de l'appelant
 * (passerelle, client SDK) s'il est sain, sinon en génère un. À propager
 * dans tous les logs de la requête et dans les réponses (header renvoyé).
 */
export function requestTraceId(request: Request): string {
  for (const header of TRACE_HEADER_CANDIDATES) {
    const value = request.headers.get(header);
    if (value && TRACE_ID_RE.test(value)) return value;
  }
  return `trc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Logger enfant avec corrélation traceId + identité tenant/utilisateur. */
export function traceLogger(traceId: string, context: { userId?: string; orgId?: string; route?: string } = {}): Logger {
  return logger.child({ traceId, ...context });
}

export function safeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(process.env.NODE_ENV !== "production" && error.stack
        ? { stack: error.stack }
        : {}),
    };
  }

  return { name: "UnknownError", message: String(error) };
}
