import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  computeUpstashSignature,
  missionQueueConfigured,
  missionTickUrl,
  parseUpstashSignature,
  qstashConfig,
  verifyUpstashSignature,
} from "./qstash";

/**
 * File d'attente QStash (recommandation A de l'audit) — le receiver n'a
 * AUCUNE session utilisateur : la signature HMAC EST l'authentification.
 * Ces tests verrouillent le schéma officiel QStash (HMAC-SHA256 de
 * `clé\ncorps`), la rotation de clés, la comparaison temps constant et les
 * gardes de configuration.
 */

const CURRENT_KEY = "signkey_current_111";
const NEXT_KEY = "signkey_next_222";
const BODY = JSON.stringify({ runId: "0f0e0d0c-1111-2222-3333-444455556666" });

function withEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  withEnv({ QSTASH_TOKEN: undefined, QSTASH_CURRENT_SIGNING_KEY: undefined, QSTASH_NEXT_SIGNING_KEY: undefined });
});

describe("configuration de la file", () => {
  it("non configurée quand une seule des trois variables manque", () => {
    withEnv({ QSTASH_TOKEN: "tok", QSTASH_CURRENT_SIGNING_KEY: CURRENT_KEY, QSTASH_NEXT_SIGNING_KEY: undefined });
    expect(missionQueueConfigured()).toBe(false);
    withEnv({ QSTASH_TOKEN: "tok", QSTASH_CURRENT_SIGNING_KEY: undefined, QSTASH_NEXT_SIGNING_KEY: NEXT_KEY });
    expect(qstashConfig()).toBeNull();
    withEnv({ QSTASH_TOKEN: undefined, QSTASH_CURRENT_SIGNING_KEY: CURRENT_KEY, QSTASH_NEXT_SIGNING_KEY: NEXT_KEY });
    expect(qstashConfig()).toBeNull();
  });

  it("configurée quand les trois variables sont présentes (lecture à l'appel)", () => {
    withEnv({ QSTASH_TOKEN: "tok", QSTASH_CURRENT_SIGNING_KEY: CURRENT_KEY, QSTASH_NEXT_SIGNING_KEY: NEXT_KEY });
    expect(qstashConfig()).toEqual({ token: "tok", currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY });
    expect(missionQueueConfigured()).toBe(true);
  });

  it("les valeurs blanches sont traitées comme absentes", () => {
    withEnv({ QSTASH_TOKEN: "   ", QSTASH_CURRENT_SIGNING_KEY: CURRENT_KEY, QSTASH_NEXT_SIGNING_KEY: NEXT_KEY });
    expect(missionQueueConfigured()).toBe(false);
  });

  it("l'URL du receiver est absolue, sans slash double", () => {
    expect(missionTickUrl("https://gen3ia.online")).toBe("https://gen3ia.online/api/queue/mission-tick");
    expect(missionTickUrl("https://gen3ia.online/")).toBe("https://gen3ia.online/api/queue/mission-tick");
  });
});

describe("schéma de signature Upstash", () => {
  it("le HMAC couvre clé + corps (détection de tout réencodage)", () => {
    const sig = computeUpstashSignature(CURRENT_KEY, BODY);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const tamperedBody = BODY.replace("0f0e", "0f0a");
    expect(computeUpstashSignature(CURRENT_KEY, tamperedBody)).not.toBe(sig);
    // Le corps modifié puis re-JSON.stringify doit être détecté même si la
    // sémantique est identique (la signature porte sur les OCTETS).
    expect(computeUpstashSignature(CURRENT_KEY, JSON.stringify({ runId: "x" }) + " ")).not.toBe(
      computeUpstashSignature(CURRENT_KEY, JSON.stringify({ runId: "x" })),
    );
  });

  it("accepte la signature de la clé courante OU de la clé suivante (rotation)", () => {
    const config = { token: "tok", currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY };
    const currentSig = computeUpstashSignature(CURRENT_KEY, BODY);
    const nextSig = computeUpstashSignature(NEXT_KEY, BODY);
    expect(verifyUpstashSignature(config, BODY, `v1,${currentSig}`)).toBe(true);
    expect(verifyUpstashSignature(config, BODY, `v1,${nextSig}`)).toBe(true);
    expect(verifyUpstashSignature(config, BODY, `v1,${"f".repeat(64)}`)).toBe(false);
  });

  it("accepte plusieurs signatures dans le même header (rotation réelle)", () => {
    const config = { token: "tok", currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY };
    const nextSig = computeUpstashSignature(NEXT_KEY, BODY);
    expect(verifyUpstashSignature(config, BODY, `v1,${"e".repeat(64)},v1,${nextSig}`)).toBe(true);
  });

  it("rejette un corps modifié, une clé inconnue, une version non v1", () => {
    const config = { token: "tok", currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY };
    const sig = computeUpstashSignature(CURRENT_KEY, BODY);
    expect(verifyUpstashSignature(config, BODY + " ", `v1,${sig}`)).toBe(false);
    expect(verifyUpstashSignature({ token: "tok", currentSigningKey: "autre", nextSigningKey: "autre2" }, BODY, `v1,${sig}`)).toBe(false);
    expect(verifyUpstashSignature(config, BODY, `v0,${sig}`)).toBe(false);
  });

  it("rejette les headers absents, malformés ou à hexadécimal invalide", () => {
    const config = { token: "tok", currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY };
    expect(verifyUpstashSignature(config, BODY, null)).toBe(false);
    expect(verifyUpstashSignature(config, BODY, "")).toBe(false);
    expect(verifyUpstashSignature(config, BODY, "v1,not-hex!")).toBe(false);
    expect(verifyUpstashSignature(config, BODY, "v1,")).toBe(false);
    expect(verifyUpstashSignature(config, BODY, "just-one-part")).toBe(false);
  });
});

describe("parse du header Upstash-Signature", () => {
  it("gère les entrées multiples et tolère les espaces", () => {
    const parsed = parseUpstashSignature("v1, AAAA , v1,BBBB");
    expect(parsed).toEqual([
      { version: "v1", hex: "aaaa" },
      { version: "v1", hex: "bbbb" },
    ]);
  });

  it("ignore les orphelins et normalise la casse", () => {
    expect(parseUpstashSignature("v1,AB12,")).toEqual([{ version: "v1", hex: "ab12" }]);
    expect(parseUpstashSignature("v2,abcd")).toEqual([{ version: "v2", hex: "abcd" }]);
  });

  it("retourne un tableau vide sur null/chaîne vide", () => {
    expect(parseUpstashSignature(null)).toEqual([]);
    expect(parseUpstashSignature("")).toEqual([]);
  });
});

describe("schéma de signature JWT (2026)", () => {
  const config = { token: "tok", currentSigningKey: CURRENT_KEY, nextSigningKey: NEXT_KEY };

  function construireJwt(key: string, body: string, opts?: { alg?: string; tamperBodyClaim?: boolean }): string {
    const header = Buffer.from(JSON.stringify({ alg: opts?.alg ?? "HS256", typ: "JWT" })).toString("base64url");
    const digest = createHmac("sha256", key).update(body, "utf8").digest();
    const payloadObj: Record<string, unknown> = { aud: "", body: digest.toString("base64url") };
    if (opts?.tamperBodyClaim) payloadObj.body = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
    const sig = createHmac("sha256", key).update(`${header}.${payload}`, "utf8").digest("base64url");
    return `${header}.${payload}.${sig}`;
  }

  it("un JWT signé avec la clé courante est accepté (corps réel)", () => {
    const jwt = construireJwt(CURRENT_KEY, BODY);
    expect(verifyUpstashSignature(config, BODY, jwt)).toBe(true);
  });

  it("un JWT signé avec la clé SUIVANTE est accepté (rotation)", () => {
    const jwt = construireJwt(NEXT_KEY, BODY);
    expect(verifyUpstashSignature(config, BODY, jwt)).toBe(true);
  });

  it("la claim body falsifiée est rejetée (JWT non rejouable avec un autre corps)", () => {
    const jwt = construireJwt(CURRENT_KEY, BODY, { tamperBodyClaim: true });
    expect(verifyUpstashSignature(config, BODY, jwt)).toBe(false);
  });

  it("un JWT signé par une clé INCONNUE est rejeté", () => {
    const jwt = construireJwt("signkey_attacker", BODY);
    expect(verifyUpstashSignature(config, BODY, jwt)).toBe(false);
  });

  it("alg !== HS256 est rejeté (jamais « none »)", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ aud: "", body: "x" })).toString("base64url");
    expect(verifyUpstashSignature(config, BODY, `${header}.${payload}.abc`)).toBe(false);
  });

  it("un JWT avec une claim body ABSENTE est rejeté", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ aud: "" })).toString("base64url");
    const sig = createHmac("sha256", CURRENT_KEY).update(`${header}.${payload}`, "utf8").digest("base64url");
    expect(verifyUpstashSignature(config, BODY, `${header}.${payload}.${sig}`)).toBe(false);
  });

  it("le schéma historique v1,<hex> reste accepté (compatibilité)", () => {
    const legacy = `v1,${computeUpstashSignature(CURRENT_KEY, BODY)}`;
    expect(verifyUpstashSignature(config, BODY, legacy)).toBe(true);
  });
});
