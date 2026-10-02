import { afterEach, describe, expect, it } from "vitest";
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
