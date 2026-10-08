import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "@/lib/security/http-errors";

/**
 * Task 96-d — cache-aside Redis sur GET /api/extensions (catalogue approuvé).
 *
 * Le payload catalogue est identique pour tous les utilisateurs authentifiés
 * (favoris/installations/achats = routes séparées) : il est mis en cache 90 s
 * pour éviter jusqu'à 200 lectures Firestore + un tri mémoire par requête.
 *
 * Briques externes mockées (auth Firebase, repository Firestore, cache) : on
 * teste le COMPORTEMENT de la route — auth AVANT cache, forme de la clé (sans
 * donnée personnelle), TTL 90 s, hit qui évite le loader, dégradation
 * gracieuse. Le contrat réel de cacheWrap est déjà couvert par
 * lib/cache/redis.test.ts — la copie locale ci-dessous n'existe que pour
 * découpler ce test de la couche cache.
 */

const verifyFirebaseAuthMock = vi.fn();
const cacheGetMock = vi.fn();
const cacheSetMock = vi.fn();
const listApprovedCatalogPageMock = vi.fn();

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: (...args: unknown[]) => verifyFirebaseAuthMock(...args),
}));

vi.mock("@/lib/cache/redis", () => ({
  cacheGet: (...args: unknown[]) => cacheGetMock(...args),
  cacheSet: (...args: unknown[]) => cacheSetMock(...args),
  // Copie fidèle du contrat cache-aside de lib/cache/redis.ts (cacheGet null
  // → loader → cacheSet sauf null/undefined).
  cacheWrap: async (key: string, ttlSeconds: number, loader: () => Promise<unknown>) => {
    const cached = await cacheGetMock(key);
    if (cached !== null) return { value: cached, hit: true };
    const value = await loader();
    if (value !== null && value !== undefined) await cacheSetMock(key, value, ttlSeconds);
    return { value, hit: false };
  },
}));

vi.mock("@/lib/extensions/repository", () => ({
  createExtension: vi.fn(),
  getExtension: vi.fn(),
  listApprovedCatalogPage: (...args: unknown[]) => listApprovedCatalogPageMock(...args),
  verifyDeveloperProjectAccess: vi.fn(),
}));

import { GET } from "./route";

/** Même FNV-1a/base36 que la route — utilisé pour calculer les clés attendues. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function catalogueFactice() {
  return {
    docs: [
      {
        id: "ext-1",
        name: "Facturation Pro",
        description: "Génère factures et devis.",
        category: "finance",
        tags: ["factures"],
        developerName: "Dev Inc.",
        latestVersion: "1.2.0",
        approvedVersion: "1.2.0",
        pricing: { model: "one_time", amountMinor: 5_000, currency: "XAF" },
        stats: { installs: 42, ratingSum: 18, ratingCount: 4, executions: 100 },
      },
    ],
    nextCursor: "Y3Vyc29y",
    truncated: false,
    sort: "popular" as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyFirebaseAuthMock.mockResolvedValue({ uid: "user-1" });
  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(true);
  listApprovedCatalogPageMock.mockResolvedValue(catalogueFactice());
});

describe("GET /api/extensions — cache-aside catalogue (Task 96-d)", () => {
  it("authentifie AVANT tout accès au cache : 401 → ni loader ni écriture Redis", async () => {
    verifyFirebaseAuthMock.mockRejectedValue(new HttpError(401, "Session requise."));
    const response = await GET(new Request("http://localhost:3000/api/extensions?limit=100"));

    expect(response.status).toBe(401);
    expect(listApprovedCatalogPageMock).not.toHaveBeenCalled();
    expect(cacheSetMock).not.toHaveBeenCalled();
    expect(cacheGetMock).not.toHaveBeenCalled();
  });

  it("chemin froid : sert le payload mappé et écrit la clé canonique avec TTL 90 s", async () => {
    const response = await GET(new Request("http://localhost:3000/api/extensions?limit=100"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.sort).toBe("popular");
    expect(body.nextCursor).toBe("Y3Vyc29y");
    expect(body.truncated).toBe(false);
    expect(body.extensions[0]).toMatchObject({
      id: "ext-1",
      name: "Facturation Pro",
      stats: { installs: 42, ratingCount: 4, rating: 4.5 },
    });

    const cleAttendue = `ext:cat:popular:-:${shortHash("")}:${shortHash("")}:100`;
    expect(listApprovedCatalogPageMock).toHaveBeenCalledWith({
      q: undefined, category: undefined, limit: 100, sort: "popular", cursor: undefined,
    });
    expect(cacheSetMock).toHaveBeenCalledTimes(1);
    expect(cacheSetMock).toHaveBeenCalledWith(cleAttendue, expect.objectContaining({ sort: "popular" }), 90);
  });

  it("clé de cache sensible aux paramètres : sort/category/q/cursor/limit distinguent les variantes", async () => {
    await GET(new Request("http://localhost:3000/api/extensions?limit=100"));
    await GET(new Request("http://localhost:3000/api/extensions?limit=100&sort=newest&category=finance&q=facture"));

    const cles = cacheSetMock.mock.calls.map(([key]) => key as string);
    expect(cles).toHaveLength(2);
    const populaire = cles.find((key) => key.includes(":popular:"));
    const recente = cles.find((key) => key.includes(":newest:"));
    expect(populaire).toBe(`ext:cat:popular:-:${shortHash("")}:${shortHash("")}:100`);
    expect(recente).toBe(
      `ext:cat:newest:${encodeURIComponent("finance")}:${shortHash("facture")}:${shortHash("")}:100`,
    );
    // Le loader est appelé deux fois : chaque variante construit sa propre entrée.
    expect(listApprovedCatalogPageMock).toHaveBeenCalledTimes(2);
  });

  it("clé SANS donnée personnelle : uid vérifié absent de toutes les clés", async () => {
    await GET(new Request("http://localhost:3000/api/extensions?limit=48"));
    for (const [key] of cacheSetMock.mock.calls) {
      expect(String(key)).toMatch(/^ext:cat:[a-z_]+:[^:]*:[0-9a-z]+:[0-9a-z]+:\d+$/);
      expect(String(key)).not.toContain("user-1");
    }
  });

  it("chemin chaud : un hit Redis évite totalement le loader Firestore", async () => {
    const payload = { sort: "popular", nextCursor: null, truncated: false, extensions: [{ id: "ext-cache" }] };
    cacheGetMock.mockResolvedValue(payload);

    const response = await GET(new Request("http://localhost:3000/api/extensions?limit=100"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(listApprovedCatalogPageMock).not.toHaveBeenCalled();
    expect(cacheSetMock).not.toHaveBeenCalled();
  });

  it("dégradation gracieuse : Redis absent/indisponible → le catalogue reste servi", async () => {
    // Comportement réel du client : cacheGet résout null, cacheSet échoue
    // silencieusement (false) — cacheWrap enchaîne alors le loader à chaque
    // requête, sans jamais casser la route.
    cacheGetMock.mockResolvedValue(null);
    cacheSetMock.mockResolvedValue(false);

    const response = await GET(new Request("http://localhost:3000/api/extensions?limit=100"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.extensions).toHaveLength(1);
    expect(listApprovedCatalogPageMock).toHaveBeenCalledTimes(1);
  });

  it("normalisation : q/category trimmés et limit hors bornes repliés avant la clé et le loader", async () => {
    await GET(new Request("http://localhost:3000/api/extensions?limit=99999&q=%20facture%20&category=%20finance%20"));
    expect(listApprovedCatalogPageMock).toHaveBeenCalledWith({
      q: "facture", category: "finance", limit: 100, sort: "popular", cursor: undefined,
    });
  });
});
