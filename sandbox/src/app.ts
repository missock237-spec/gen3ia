/**
 * Application Fastify du bac à sable — extraite de server.ts pour être
 * testable par injection (buildApp ne lie PAS de port).
 *
 * CORRECTION SAST #13 (js/missing-rate-limiting) : la route /execute
 * authentifiait chaque requête (HMAC + anti-rejeu) mais n'appliquait AUCUNE
 * limite de débit — un déluge de requêtes non signées brûlait du CPU côté
 * vérification et un déluge signé lançait des exécutions Docker sans garde.
 * Le plugin officiel @fastify/rate-limit est enregistré GLOBALEMENT (filet de
 * sécurité toutes routes) avec des quotas par route : /execute 30/min et
 * /health 60/min par IP ; un dépassement répond 429 avec Retry-After AVANT
 * toute vérification de signature (rejet à coût quasi nul).
 */

import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

import { SandboxJobSchema } from "./job-schema.js";
import { verifySignature } from "./security.js";
import { runSandbox } from "./runner.js";

/** Quota métier : 30 exécutions/minute/IP (le bac à sable lance des conteneurs). */
export const EXECUTE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" } as const;
/** Sonde de vie : 60/min/IP (largement au-dessus d'un orchestrateur sain). */
export const HEALTH_RATE_LIMIT = { max: 60, timeWindow: "1 minute" } as const;
/** Filet global toutes routes confondues : 120/min/IP. */
export const GLOBAL_RATE_LIMIT = { max: 120, timeWindow: "1 minute" } as const;

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    bodyLimit: 600_000,
  });

  await app.register(rateLimit, {
    global: true,
    max: GLOBAL_RATE_LIMIT.max,
    timeWindow: GLOBAL_RATE_LIMIT.timeWindow,
  });

  app.get(
    "/health",
    {
      config: {
        rateLimit: { max: HEALTH_RATE_LIMIT.max, timeWindow: HEALTH_RATE_LIMIT.timeWindow },
      },
    },
    async () => ({
      ok: true,
      service: "gen3ia-sandbox",
    }),
  );

  app.post(
    "/execute",
    {
      config: {
        rateLimit: { max: EXECUTE_RATE_LIMIT.max, timeWindow: EXECUTE_RATE_LIMIT.timeWindow },
      },
    },
    async (request, reply) => {
      const timestamp = request.headers["x-gen3ia-timestamp"];
      const signature = request.headers["x-gen3ia-signature"];
      const requestId = request.headers["x-gen3ia-request-id"];

      if (
        typeof timestamp !== "string" ||
        typeof signature !== "string" ||
        typeof requestId !== "string"
      ) {
        return reply.code(401).send({ error: "Missing authentication headers" });
      }

      const rawBody = JSON.stringify(request.body);
      if (!verifySignature(rawBody, timestamp, signature, requestId)) {
        return reply.code(401).send({ error: "Invalid or replayed request" });
      }

      const parsed = SandboxJobSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid sandbox job",
          details: parsed.error.issues,
        });
      }

      try {
        const result = await runSandbox(parsed.data);
        return reply.send(result);
      } catch (error) {
        request.log.error(error);
        return reply.code(500).send({ error: "Sandbox execution failed" });
      }
    },
  );

  return app;
}
