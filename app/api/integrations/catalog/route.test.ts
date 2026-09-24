import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Tests de la logique de cache de GET /api/integrations/catalog (Task 25-g).
 *
 * Les dépendances réseau/auth sont mockées (route-guard, Redis, Composio,
 * logger) : on teste le COMPORTEMENT de la route — hit mémoire de
 * l'enveloppe sérialisée, 304 via If-None-Match, payload slim, repli
 * dégradé non mis en cache — pas les briques externes.
 */

const protectRouteMock = vi.fn();
const cacheGetMock = vi.fn();
const cacheSetMock = vi.fn();
const listComposioToolkitsMock = vi.fn();
const loggerMock = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: (...args: unknown[]) => protectRouteMock(...args),
}));

vi.mock("@/lib/cache/redis", () => ({
  cacheGet: (...args: unknown[]) => cacheGetMock(...args),
  cacheSet: (...args: unknown[]) => cacheSetMock(...args),
}));

vi.mock("@/lib/integrations/composio/connections", () => ({
  CONNECTION_CATEGORIES: [
    "messaging",
    "social",
    "email_calendar",
    "crm",
    "ecommerce",
    "developer",
    "knowledge",
    "data",
  ],
  CONNECTIONS_CATALOG: [
    {
      toolkit: "github",
      label: "GitHub",
      description: "Repositories, issues and pull requests.",
      category: "developer",
      auth: "oauth",
    },
    {
      toolkit: "slack",
      label: "Slack",
      description: "Messages, channels and notifications.",
      category: "messaging",
      auth: "oauth",
    },
  ],
  listComposioToolkits: (...args: unknown[]) => listComposioToolkitsMock(...args),
}));

vi.mock("@/lib/observability/logger", () => ({
  logger: loggerMock,
}));

/** Import isolé par test : la route porte des caches au niveau du module. */
async function importerRoute() {
  vi.resetModules();
  return import("./route");
}

function requeteCatalogue(query = "?limit=1000", entetes: Record<string, string> = {}) {
  const requete = new NextRequest(`http://localhost:3000/api/integrations/catalog${query}`, { headers: entetes });
  // Quirk de harnais de test : après vi.resetModules(), le test et la route
  // chargent chacune leur instance de next/server et l'entête if-none-match
  // n'est visible du gestionnaire qu'après une première lecture côté test.
  // En production, Next construit la requête entrante lui-même — ce contournement
  // ne concerne QUE ce fichier.
  for (const nom of Object.keys(entetes)) requete.headers.get(nom);
  return requete;
}

/** 1559 toolkits simulés, comme en production (2 pages Composio).
 * Forme MAPPÉE : listComposioToolkits applique déjà mapRawToolkitItem en interne. */
function toolkitsFactices() {
  return {
    items: Array.from({ length: 1559 }, (_, index) => ({
      toolkit: `toolkit_${index}`,
      label: `Application ${index}`,
      description: `Automatise vos flux avec l'application ${index}. ${"Description longue. ".repeat(12)}`,
      logo: `https://cdn.example.com/${index}.png`,
      categories: ["crm"],
      authSchemes: ["OAUTH2"],
      managedBy: "composio",
      noAuth: false,
    })),
    nextCursor: null,
    totalItems: 1559,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  protectRouteMock.mockResolvedValue({ ok: true, context: { userId: "u1", traceId: "trace" } });
  cacheGetMock.mockResolvedValue(null);
  cacheSetMock.mockResolvedValue(true);
  listComposioToolkitsMock.mockResolvedValue(toolkitsFactices());
});

describe("GET /api/integrations/catalog — cache enveloppe (Task 25-g)", () => {
  it("sert un payload SLIM (champs réellement consommés par le front) avec ETag fort", async () => {
    const { GET } = await importerRoute();
    const response = await GET(requeteCatalogue());

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    expect(response.headers.get("cache-control")).toBe("private, max-age=60, stale-while-revalidate=300");

    const body = await response.json();
    expect(body.items.length).toBe(1000);
    expect(body.totalItems).toBe(1559); // correspondances AVANT limite (contrat préservé)
    expect(body.source).toBe("composio");
    expect(body.nextCursor).toBeNull();

    const premier = body.items[0] as Record<string, unknown>;
    expect(Object.keys(premier).sort()).toEqual(["auth", "category", "description", "label", "logo", "toolkit"]);
    // Description tronquée à ~140 caractères malgré l'entrée Composio verbeuse.
    expect(String(premier.description).length).toBeLessThanOrEqual(140);
  });

  it("réutilise l'enveloppe sérialisée : agrégation unique, écritures Redis uniquement au froid", async () => {
    const { GET } = await importerRoute();
    await GET(requeteCatalogue("?limit=1000"));
    const deuxieme = await GET(requeteCatalogue("?limit=1000"));

    expect(listComposioToolkitsMock).toHaveBeenCalledTimes(1);
    // Deux écritures Redis au froid : la liste complète (étage 2) +
    // l'enveloppe sérialisée de la variante (étage 1). Le hit mémoire
    // suivant ne réécrit RIEN — c'est l'engagement du cache-aside.
    expect(cacheSetMock.mock.calls.map(([key]) => key).sort()).toEqual([
      "catalog:v3:1000:all:none",
      "integrations:catalog:v3",
    ]);
    expect(deuxieme.headers.get("x-gen3ia-catalog-cache")).toBe("MEMORY-HIT");
    expect(await deuxieme.json()).toEqual(await (await GET(requeteCatalogue("?limit=1000&_=x"))).json());
  });

  it("répond 304 (zéro octet de payload) quand If-None-Match correspond à l'ETag servi", async () => {
    const { GET } = await importerRoute();
    const premiere = await GET(requeteCatalogue("?limit=1000"));
    const etag = premiere.headers.get("etag") as string;

    const revalidation = await GET(requeteCatalogue("?limit=1000", { "if-none-match": etag }));
    expect(revalidation.status).toBe(304);
    expect(await revalidation.text()).toBe("");
    expect(revalidation.headers.get("etag")).toBe(etag);
    expect(revalidation.headers.get("cache-control")).toBe("private, max-age=60, stale-while-revalidate=300");
  });

  it("repart d'un 200 si le client renvoie un ETag obsolète", async () => {
    const { GET } = await importerRoute();
    const revalidation = await GET(requeteCatalogue("?limit=1000", { "if-none-match": `"${"0".repeat(64)}"` }));
    expect(revalidation.status).toBe(200);
    expect(revalidation.headers.get("x-gen3ia-catalog-cache")).toBe("MISS");
  });

  it("isole les variantes : une autre recherche construit sa propre enveloppe (matière première partagée)", async () => {
    const { GET } = await importerRoute();
    await GET(requeteCatalogue("?limit=1000"));
    const recherche = await GET(requeteCatalogue("?limit=1000&search=toolkit_1"));

    expect(listComposioToolkitsMock).toHaveBeenCalledTimes(1); // l'étage 2 a servi les deux variantes
    expect(recherche.headers.get("x-gen3ia-catalog-cache")).toBe("MISS");
    const body = await recherche.json();
    const items = body.items as Array<{ toolkit: string }>;
    // La recherche serveur est un « includes » : toolkit_1, toolkit_10,
    // toolkit_100… correspondent — mais la première lettre reste stable
    // (tri alphabétique Composio) et le total reflète les correspondances.
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].toolkit).toBe("toolkit_1");
    expect(items.every((item) => item.toolkit.includes("toolkit_1"))).toBe(true);
    expect(body.totalItems).toBe(
      toolkitsFactices().items.filter((item) => item.toolkit.includes("toolkit_1")).length,
    );
  });

  it("en cas d'échec Composio : repli statique avec bannière dégradée et AUCUNE mise en cache", async () => {
    listComposioToolkitsMock.mockRejectedValue(new Error("Composio indisponible"));
    const { GET } = await importerRoute();
    const response = await GET(requeteCatalogue("?limit=1000"));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.source).toBe("catalogue-integre");
    expect(body.degraded).toBe(true);
    expect(body.items.length).toBe(2); // catalogue intégré, jamais vide
    // Le corps dégradé ne doit pas empoisonner la clé de cache 5 minutes.
    expect(cacheSetMock).not.toHaveBeenCalled();
  });

  it("délègue l'authentification en premier : 401 du garde-fou renvoyé tel quel", async () => {
    const unauthorized = new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), { status: 401 });
    protectRouteMock.mockResolvedValue({ ok: false, response: unauthorized });
    const { GET } = await importerRoute();
    const response = await GET(requeteCatalogue());
    expect(response.status).toBe(401);
    expect(listComposioToolkitsMock).not.toHaveBeenCalled();
  });
});
