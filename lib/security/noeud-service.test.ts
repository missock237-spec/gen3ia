import { beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

// requireUser est simulé : la résolution d'identité est testée de façon
// isolée (voie machine Colab / voie utilisateur Firebase en repli).
vi.mock("./authenticated-request", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/access/platform", () => ({
  getPlatformRole: vi.fn(),
}));

import { getPlatformRole } from "@/lib/access/platform";

import { requireUser } from "./authenticated-request";
import {
  UTILISATEUR_NOEUD_SERVICE,
  jetonServiceValide,
  résoudreIdentitéNœud,
} from "./noeud-service";

const mockedRequireUser = vi.mocked(requireUser);
const mockedGetPlatformRole = vi.mocked(getPlatformRole);

const JETON = "jeton-essaim-colab-tres-long-et-secret-0123456789abcdef";

function requête(
  pathname: string,
  init?: { jeton?: string; ip?: string },
): NextRequest {
  const headers = new Headers();
  if (init?.jeton) headers.set("authorization", `Bearer ${init.jeton}`);
  if (init?.ip) headers.set("x-forwarded-for", init.ip);
  return new NextRequest(`https://gen3ia.local${pathname}`, {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("résoudreIdentitéNœud — une garde, deux credentials", () => {
  it("voie machine désactivée sans ESSAIM_NOEUD_TOKEN (fail-closed → Firebase)", async () => {
    vi.stubEnv("ESSAIM_NOEUD_TOKEN", "");
    mockedRequireUser.mockResolvedValue({
      uid: "user-firebase",
      claims: {},
    } as never);
    // La garde complète vérifie la liste blanche : le rôle plateforme
    // admin laisse passer n'importe quel chemin d'API.
    mockedGetPlatformRole.mockResolvedValue("admin");
    const r = await résoudreIdentitéNœud(requête("/api/essaim/ondes", { jeton: JETON }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.context.userId).toBe("user-firebase");
    expect(mockedRequireUser).toHaveBeenCalledOnce();
  });

  it("jeton de service VALIDE → identité de service fixe, sans appel Firebase", async () => {
    vi.stubEnv("ESSAIM_NOEUD_TOKEN", JETON);
    mockedRequireUser.mockRejectedValue(new Error("ne doit PAS être appelé"));
    const r = await résoudreIdentitéNœud(requête("/api/essaim/ondes", { jeton: JETON }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.context.userId).toBe(UTILISATEUR_NOEUD_SERVICE);
      expect(r.context.traceId).toMatch(/^noeud-/);
    }
    expect(mockedRequireUser).not.toHaveBeenCalled();
  });

  it("jeton INVALIDE → repli Firebase (refus 401 si identité absente)", async () => {
    vi.stubEnv("ESSAIM_NOEUD_TOKEN", JETON);
    mockedRequireUser.mockRejectedValue(new Error("Unauthorized"));
    const r = await résoudreIdentitéNœud(
      requête("/api/essaim/ondes", { jeton: "mauvais-jeton-entièrement-différent-000000" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("sans en-tête Authorization → voie Firebase classique", async () => {
    vi.stubEnv("ESSAIM_NOEUD_TOKEN", JETON);
    mockedRequireUser.mockRejectedValue(new Error("Unauthorized"));
    const r = await résoudreIdentitéNœud(requête("/api/essaim/ondes"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(401);
  });

  it("rate limit machine : 601 battements sur la même IP → 429", async () => {
    vi.stubEnv("ESSAIM_NOEUD_TOKEN", JETON);
    const ip = "203.0.113.77";
    let dernière: Awaited<ReturnType<typeof résoudreIdentitéNœud>> | null = null;
    for (let i = 0; i < 601; i++) {
      dernière = await résoudreIdentitéNœud(requête("/api/essaim/ondes", { jeton: JETON, ip }));
    }
    expect(dernière!.ok).toBe(false);
    if (!dernière!.ok) expect(dernière!.response.status).toBe(429);
  });
});

describe("jetonServiceValide — comparaison timing-safe", () => {
  it("accepte le bon jeton, refuse un préfixe ou une extension", () => {
    vi.stubEnv("ESSAIM_NOEUD_TOKEN", JETON);
    expect(jetonServiceValide(JETON)).toBe(true);
    expect(jetonServiceValide(JETON.slice(0, 10))).toBe(false);
    expect(jetonServiceValide(`${JETON}x`)).toBe(false);
    expect(jetonServiceValide("")).toBe(false);
  });

  it("refuse tout si le jeton configuré est un placeholder trop court", () => {
    vi.stubEnv("ESSAIM_NOEUD_TOKEN", "court");
    expect(jetonServiceValide("court")).toBe(false);
  });
});
