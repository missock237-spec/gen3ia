import { createHmac, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXECUTE_RATE_LIMIT, buildApp } from "./app";
import type { FastifyInstance } from "fastify";

// Le secret est lu à CHAQUE appel (getSharedSecret), donc le définir avant les
// requêtes suffit — aucun souci d'ordre d'import.
const SHARED_SECRET = "test-shared-secret-0123456789abcdefghijklmnopqrstuv";

let app: FastifyInstance;

/** Instance DÉDIÉE aux tests de quota — le store du limiteur est par-app. */
let rateApp: FastifyInstance;
/** Instance DÉDIÉE à l'exécution signée — quota intact, docker absent. */
let execApp: FastifyInstance;

beforeAll(async () => {
  process.env.SANDBOX_SHARED_SECRET = SHARED_SECRET;
  app = await buildApp();
  rateApp = await buildApp();
  execApp = await buildApp();
});

afterAll(async () => {
  await app.close();
  await rateApp.close();
  await execApp.close();
});

/** Fabrique des en-têtes d'authentification sandbox VALIDES (HMAC réel). */
function signedHeaders(body: unknown, requestId = randomUUID()) {
  const timestamp = String(Date.now());
  const payload = JSON.stringify(body);
  const signature = createHmac("sha256", SHARED_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return {
    "content-type": "application/json",
    "x-gen3ia-timestamp": timestamp,
    "x-gen3ia-signature": signature,
    "x-gen3ia-request-id": requestId,
  };
}

const VALID_JOB = {
  executionId: "exec-test-1",
  userId: "user-1",
  runtime: "node",
  code: "console.log('ok');",
  limits: { timeoutMs: 5_000, memoryMb: 256, cpu: 0.5, maxOutputBytes: 1_048_576 },
  network: "none",
};

describe("sandbox /health", () => {
  it("répond 200 avec l'identité du service", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, service: "gen3ia-sandbox" });
  });
});

describe("sandbox /execute — authentification", () => {
  it("401 sans en-têtes d'authentification", async () => {
    const response = await app.inject({ method: "POST", url: "/execute", payload: VALID_JOB });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("Missing authentication headers");
  });

  it("401 avec signature invalide (secret différent)", async () => {
    const timestamp = String(Date.now());
    const payload = JSON.stringify(VALID_JOB);
    const badSignature = createHmac("sha256", "autre-secret-0123456789abcdefghijklmnop").update(`${timestamp}.${payload}`).digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/execute",
      payload: VALID_JOB,
      headers: {
        "content-type": "application/json",
        "x-gen3ia-timestamp": timestamp,
        "x-gen3ia-signature": badSignature,
        "x-gen3ia-request-id": randomUUID(),
      },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("Invalid or replayed request");
  });

  it("401 sur rejeu EXACT de la même requête (anti-rejeu conservé)", async () => {
    const headers = signedHeaders(VALID_JOB, "replay-test-0001");
    const first = await app.inject({ method: "POST", url: "/execute", payload: VALID_JOB, headers });
    const second = await app.inject({ method: "POST", url: "/execute", payload: VALID_JOB, headers });
    // Le 1er appel franchit l'auth (docker absent -> exécution échouée mais signée),
    // le 2e est rejeté par la garde anti-rejeu.
    expect(second.statusCode).toBe(401);
    expect(second.json().error).toBe("Invalid or replayed request");
    expect(first.statusCode).not.toBe(401);
  });

  it("400 sur job valide signé mais schéma invalide", async () => {
    const invalidJob = { ...VALID_JOB, runtime: "fortran" };
    const response = await app.inject({
      method: "POST",
      url: "/execute",
      payload: invalidJob,
      headers: signedHeaders(invalidJob, "schema-test-0001"),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("Invalid sandbox job");
  });
});

describe("sandbox /execute — limite de débit (correction SAST missing-rate-limiting)", () => {
  it("renvoie 429 avec Retry-After au-delà du quota /execute, AVANT l'authentification", async () => {
    // Les requêtes sans en-têtes coûtent quasi rien : le quota doit quand
    // même les compter (le plugin s'exécute avant le handler).
    let sawUnauthorized = 0;
    let rateLimited = false;
    for (let i = 0; i < EXECUTE_RATE_LIMIT.max + 5; i += 1) {
      const response = await rateApp.inject({ method: "POST", url: "/execute", payload: { probe: i } });
      if (response.statusCode === 401) sawUnauthorized += 1;
      if (response.statusCode === 429) {
        rateLimited = true;
        expect(response.headers["retry-after"]).toBeDefined();
        break;
      }
    }
    expect(rateLimited).toBe(true);
    expect(sawUnauthorized).toBe(EXECUTE_RATE_LIMIT.max);
  });

  it("expose les en-têtes de quota sur une réponse normale", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(Number(response.headers["x-ratelimit-limit"])).toBeGreaterThan(0);
  });
});

describe("sandbox /execute — exécution signée réelle (docker indisponible → échec encadré)", () => {
  it("200 avec result.success=false quand l'exécution échoue (contrat d'erreur)", async () => {
    const response = await execApp.inject({
      method: "POST",
      url: "/execute",
      payload: VALID_JOB,
      headers: signedHeaders(VALID_JOB, "docker-missing-0001"),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(false);
    expect(typeof body.stderr).toBe("string");
    expect(body.exitCode).toBeNull();
  });
});
