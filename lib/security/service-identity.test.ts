import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { parserTraceparent, w3cTraceIdDepuisGen3ia } from "../observability/trace-w3c";

/**
 * Tests de l'identité de service interne (lib/security/service-identity.ts).
 *
 * Contrats verrouillés : parse robuste du registre, format de signature
 * (sha256= + HMAC-SHA256 hex sur service:méthode:chemin:horodatage:haché
 * du corps), anti-replay par fenêtre glissante, comparaisons timing-safe,
 * allowlist par route et rétrocompatibilité (allowIfUnconfigured).
 * Valeurs de secret 100 % factices (jamais de vrai secret en test).
 */

const TOKENS_TEST = "cron:secret-cron-fake-0000000000000000000000000,worker:secret-worker-fake-00000000000000000";

const URL_ROUTE = "https://gen3ia.local/api/cron/training-sweep";

function requete(
  url: string,
  method: string,
  enTetes: Record<string, string> = {},
): NextRequest {
  return new NextRequest(url, { method, headers: enTetes });
}

beforeEach(() => {
  process.env.GEN3IA_SERVICE_TOKENS = TOKENS_TEST;
});

afterEach(() => {
  delete process.env.GEN3IA_SERVICE_TOKENS;
});

describe("parseServiceTokens", () => {
  it("parse plusieurs entrées nom:secret", async () => {
    const { parseServiceTokens } = await import("./service-identity");
    const tokens = parseServiceTokens(TOKENS_TEST, { silent: true });
    expect(tokens.get("cron")).toBe("secret-cron-fake-0000000000000000000000000");
    expect(tokens.get("worker")).toBe("secret-worker-fake-00000000000000000");
    expect(tokens.size).toBe(2);
  });

  it("ignore les entrées malformées sans lever", async () => {
    const { parseServiceTokens } = await import("./service-identity");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tokens = parseServiceTokens(
      "cron:secret-a,,sans-separateur,worker:secret-b,  :secret-tirets, espace-nom:x",
      { silent: false },
    );
    expect(Array.from(tokens.keys())).toEqual(["cron", "worker"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("en cas de doublon, la première occurrence gagne", async () => {
    const { parseServiceTokens } = await import("./service-identity");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tokens = parseServiceTokens("a:premier,a:second", { silent: false });
    expect(tokens.get("a")).toBe("premier");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("doublon"));
    warn.mockRestore();
  });

  it("registre absent → Map vide + warning UNE seule fois (pas de spam)", async () => {
    const { parseServiceTokens } = await import("./service-identity");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const premier = parseServiceTokens(undefined);
    const second = parseServiceTokens("");
    expect(premier.size).toBe(0);
    expect(second.size).toBe(0);
    const appelsGen3ia = warn.mock.calls.filter((args) => String(args[0]).includes("[service-identity]"));
    expect(appelsGen3ia.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });
});

describe("signServiceRequest / verifyServiceRequest — aller-retour", () => {
  it("signe et vérifie une requête POST avec corps", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const maintenant = 1_800_000_000_000;
    const corps = JSON.stringify({ slotEpoch: 42 });
    const enTetes = signServiceRequest(
      { service: "worker", method: "POST", path: "/api/queue/mission-tick", body: corps },
      { nowMs: maintenant },
    );

    expect(enTetes["X-Gen3ia-Service"]).toBe("worker");
    expect(enTetes["X-Gen3ia-Timestamp"]).toBe("1800000000");
    expect(enTetes["X-Gen3ia-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);

    const verdict = verifyServiceRequest(
      requete("https://gen3ia.local/api/queue/mission-tick", "POST", enTetes),
      { body: corps, nowMs: maintenant },
    );
    expect(verdict).toEqual({ ok: true, service: "worker" });
  });

  it("signe et vérifie une requête GET sans corps", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: maintenant },
    );
    const verdict = verifyServiceRequest(
      requete(URL_ROUTE, "GET", enTetes),
      { nowMs: maintenant },
    );
    expect(verdict).toEqual({ ok: true, service: "cron" });
  });

  it("signServiceRequest lève pour un service inconnu du registre (fail loud émetteur)", async () => {
    const { signServiceRequest } = await import("./service-identity");
    expect(() =>
      signServiceRequest({ service: "intrus", method: "GET", path: "/x" }),
    ).toThrow(/intrus/);
  });
});

describe("verifyServiceRequest — refus documentés", () => {
  it("registre non configuré → raison non_configure", async () => {
    const { verifyServiceRequest } = await import("./service-identity");
    delete process.env.GEN3IA_SERVICE_TOKENS;
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET"));
    expect(verdict).toEqual({ ok: false, reason: "non_configure" });
  });

  it("en-têtes absents → entetes_manquants", async () => {
    const { verifyServiceRequest } = await import("./service-identity");
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET"));
    expect(verdict).toEqual({ ok: false, reason: "entetes_manquants" });
  });

  it("timestamp non numérique → timestamp_invalide", async () => {
    const { verifyServiceRequest } = await import("./service-identity");
    const verdict = verifyServiceRequest(
      requete(URL_ROUTE, "GET", {
        "x-gen3ia-service": "cron",
        "x-gen3ia-timestamp": "pas-un-nombre",
        "x-gen3ia-signature": "sha256=0000",
      }),
    );
    expect(verdict).toEqual({ ok: false, reason: "timestamp_invalide" });
  });

  it("requête trop vieille → timestamp_perime (anti-replay)", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const emission = Date.now() - 400_000; // > 300 s de fenêtre
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: emission },
    );
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET", enTetes));
    expect(verdict).toEqual({ ok: false, reason: "timestamp_perime" });
  });

  it("horodatage trop futur → timestamp_perime (fenêtre symétrique)", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const emission = Date.now() + 400_000;
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: emission },
    );
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET", enTetes));
    expect(verdict).toEqual({ ok: false, reason: "timestamp_perime" });
  });

  it("service absent du registre → service_inconnu", async () => {
    const { verifyServiceRequest } = await import("./service-identity");
    const verdict = verifyServiceRequest(
      requete(URL_ROUTE, "GET", {
        "x-gen3ia-service": "inconnu-du-registre",
        "x-gen3ia-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-gen3ia-signature": "sha256=" + "0".repeat(64),
      }),
    );
    expect(verdict).toEqual({ ok: false, reason: "service_inconnu" });
  });

  it("allowlist de la route : service connu mais non admis → service_non_autorise", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: maintenant },
    );
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET", enTetes), {
      services: ["worker"],
      nowMs: maintenant,
    });
    expect(verdict).toEqual({ ok: false, reason: "service_non_autorise" });
  });

  it("corps altéré → signature_invalide", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "worker", method: "POST", path: "/api/queue/mission-tick", body: '{"slotEpoch":42}' },
      { nowMs: maintenant },
    );
    const verdict = verifyServiceRequest(
      requete("https://gen3ia.local/api/queue/mission-tick", "POST", enTetes),
      { body: '{"slotEpoch":43}', nowMs: maintenant },
    );
    expect(verdict).toEqual({ ok: false, reason: "signature_invalide" });
  });

  it("chemin altéré → signature_invalide (anti-confusion de route)", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: maintenant },
    );
    const verdict = verifyServiceRequest(
      requete("https://gen3ia.local/api/cron/agent-schedules", "GET", enTetes),
      { nowMs: maintenant },
    );
    expect(verdict).toEqual({ ok: false, reason: "signature_invalide" });
  });

  it("méthode altérée → signature_invalide", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: maintenant },
    );
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "POST", enTetes), {
      body: "",
      nowMs: maintenant,
    });
    expect(verdict).toEqual({ ok: false, reason: "signature_invalide" });
  });

  it("secret émis pour un autre service → signature_invalide (pas de confusion de clé)", async () => {
    const { verifyServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    // Signature calculée avec le secret de « worker » mais revendiquée au
    // nom de « cron » : le HMAC attendu utilise le secret de cron → refus.
    const faux = await (async () => {
      const { createHmac, createHash } = await import("crypto");
      const ts = String(Math.floor(maintenant / 1000));
      const message = `cron:GET:/api/cron/training-sweep:${ts}:${createHash("sha256").update("", "utf8").digest("hex")}`;
      return {
        "X-Gen3ia-Service": "cron",
        "X-Gen3ia-Timestamp": ts,
        "X-Gen3ia-Signature": `sha256=${createHmac("sha256", "secret-worker-fake-00000000000000000").update(message, "utf8").digest("hex")}`,
      };
    })();
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET", faux), { nowMs: maintenant });
    expect(verdict).toEqual({ ok: false, reason: "signature_invalide" });
  });
});

describe("requireService — garde de route", () => {
  it("signature valide du service demandé → ok avec le nom du service", async () => {
    const { requireService, signServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: maintenant },
    );
    const verdict = requireService(requete(URL_ROUTE, "GET", enTetes), "cron");
    expect(verdict).toEqual({ ok: true, service: "cron" });
  });

  it("sans en-têtes → 401 JSON avec error (réponse prête)", async () => {
    const { requireService } = await import("./service-identity");
    const verdict = requireService(requete(URL_ROUTE, "GET"), "cron");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.response.status).toBe(401);
      const body = (await verdict.response.json()) as { error?: string };
      expect(body.error).toContain("Identité de service requise");
    }
  });

  it("signature valide d'un service hors allowlist → 401", async () => {
    const { requireService, signServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "worker", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: maintenant },
    );
    const verdict = requireService(requete(URL_ROUTE, "GET", enTetes), "cron");
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.response.status).toBe(401);
  });
});

describe("allowIfUnconfigured — rétrocompatibilité explicite", () => {
  it("registre configuré → false (l'identité de service s'applique)", async () => {
    const { allowIfUnconfigured } = await import("./service-identity");
    expect(allowIfUnconfigured()).toBe(false);
  });

  it("registre absent → true avec warning (une seule fois par instance)", async () => {
    const { allowIfUnconfigured } = await import("./service-identity");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    delete process.env.GEN3IA_SERVICE_TOKENS;
    try {
      expect(allowIfUnconfigured()).toBe(true);
      expect(allowIfUnconfigured()).toBe(true); // même verdict, warning UNIQUE
      const appelsGen3ia = warn.mock.calls.filter((args) => String(args[0]).includes("[service-identity]"));
      expect(appelsGen3ia.length).toBeLessThanOrEqual(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("propagation W3C traceparent (Task K)", () => {
  it("signServiceRequest avec traceId sain → en-tête traceparent valide (dérivation déterministe)", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep", traceId: "trc_cron-42" },
      { nowMs: maintenant },
    );
    expect(enTetes.traceparent).toBeDefined();
    const parse = parserTraceparent(enTetes.traceparent);
    expect(parse).toBeDefined();
    expect(parse?.traceId).toBe(w3cTraceIdDepuisGen3ia("trc_cron-42"));
    expect(parse?.spanId).toMatch(/^[0-9a-f]{16}$/);

    // La signature reste VALIDE : le traceparent ne fait PAS partie du HMAC.
    const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET", enTetes), { nowMs: maintenant });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.service).toBe("cron");
      expect(verdict.traceparent).toBe(enTetes.traceparent);
    }
  });

  it("signServiceRequest SANS traceId → aucun en-tête traceparent (comportement historique)", async () => {
    const { signServiceRequest } = await import("./service-identity");
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
    );
    expect(enTetes.traceparent).toBeUndefined();
    expect(Object.keys(enTetes).sort()).toEqual([
      "X-Gen3ia-Service",
      "X-Gen3ia-Signature",
      "X-Gen3ia-Timestamp",
    ]);
  });

  it("traceId non sain (injection potentielle) → pas de traceparent, pas de levée", async () => {
    const { signServiceRequest } = await import("./service-identity");
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep", traceId: "injection\nlog()" },
    );
    expect(enTetes.traceparent).toBeUndefined();
  });

  it("verifyServiceRequest LOGGE le traceparent W3C entrant valide", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep", traceId: "trc_log-1" },
      { nowMs: maintenant },
    );
    try {
      const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET", enTetes), { nowMs: maintenant });
      expect(verdict.ok).toBe(true);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("[service-identity] traceparent"));
      expect(info).toHaveBeenCalledWith(expect.stringContaining(enTetes.traceparent!));
    } finally {
      info.mockRestore();
    }
  });

  it("traceparent ENTRANT malformé → ni loggé ni exposé (parse strict, anti-injection)", async () => {
    const { signServiceRequest, verifyServiceRequest } = await import("./service-identity");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const maintenant = Date.now();
    const enTetes = signServiceRequest(
      { service: "cron", method: "GET", path: "/api/cron/training-sweep" },
      { nowMs: maintenant },
    );
    try {
      const verdict = verifyServiceRequest(requete(URL_ROUTE, "GET", {
        ...enTetes,
        traceparent: "00-xxxx-garbage-01",
      }), { nowMs: maintenant });
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.traceparent).toBeUndefined();
      expect(info).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
    }
  });
});
