import { describe, expect, it } from "vitest";

import { crossSiteMutationVerdict, timingSafeEqualString, trustedOriginsFromEnv } from "./edge-guards";

const base = { host: "gen3ia.online", origin: null, secFetchSite: null } as const;

describe("crossSiteMutationVerdict", () => {
  it("laisse passer les lectures (GET) même cross-site", () => {
    expect(crossSiteMutationVerdict({ ...base, method: "GET", pathname: "/api/billing/wallet", secFetchSite: "cross-site" }).allowed).toBe(true);
  });

  it("laisse passer une mutation same-origin", () => {
    expect(crossSiteMutationVerdict({ ...base, method: "POST", pathname: "/api/security/emergency-stop", origin: "https://gen3ia.online", secFetchSite: "same-origin" }).allowed).toBe(true);
  });

  it("refuse une mutation émise depuis un site tiers (Sec-Fetch-Site)", () => {
    expect(crossSiteMutationVerdict({ ...base, method: "POST", pathname: "/api/orchestrator/actions/a1/execute", secFetchSite: "cross-site" })).toEqual({ allowed: false, reason: "cross-site-fetch" });
  });

  it("refuse une mutation dont l'Origin ne correspond pas à l'hôte", () => {
    expect(crossSiteMutationVerdict({ ...base, method: "DELETE", pathname: "/api/agents/x", origin: "https://evil.example" })).toEqual({ allowed: false, reason: "origin-mismatch" });
  });

  it("traite Origin: null comme étranger", () => {
    expect(crossSiteMutationVerdict({ ...base, method: "POST", pathname: "/api/agents", origin: "null" }).allowed).toBe(false);
  });

  it("autorise les appels serveur à serveur sans Origin (webhooks, SDK)", () => {
    expect(crossSiteMutationVerdict({ ...base, method: "POST", pathname: "/api/agents/run" }).allowed).toBe(true);
  });

  it("exempte les webhooks, la voix et l'API publique", () => {
    for (const pathname of ["/api/webhooks/chariow", "/api/voice/twilio/turn", "/api/public/agents/a1"]) {
      expect(crossSiteMutationVerdict({ ...base, method: "POST", pathname, origin: "https://client.example", secFetchSite: "cross-site" }).allowed).toBe(true);
    }
  });

  it("accepte une origine de confiance explicite", () => {
    expect(crossSiteMutationVerdict({ ...base, host: "gen3ia-git-x.vercel.app", method: "POST", pathname: "/api/agents", origin: "https://gen3ia.online" }, ["https://gen3ia.online"]).allowed).toBe(true);
  });
});

describe("timingSafeEqualString", () => {
  it("compare correctement", () => {
    expect(timingSafeEqualString("s3cret-value", "s3cret-value")).toBe(true);
    expect(timingSafeEqualString("s3cret-valuX", "s3cret-value")).toBe(false);
    expect(timingSafeEqualString("s3cret", "s3cret-value")).toBe(false);
  });

  it("refuse les valeurs absentes ou un secret attendu vide", () => {
    expect(timingSafeEqualString(null, "x")).toBe(false);
    expect(timingSafeEqualString("", "")).toBe(false);
    expect(timingSafeEqualString("x", undefined)).toBe(false);
  });
});

describe("trustedOriginsFromEnv", () => {
  it("ne garde que les valeurs définies", () => {
    expect(trustedOriginsFromEnv({ NEXT_PUBLIC_SITE_URL: "https://gen3ia.online", NEXT_PUBLIC_APP_URL: "" })).toEqual(["https://gen3ia.online"]);
  });
});
