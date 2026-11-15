import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

/**
 * SPÉCIFICATION OPENAPI (Task 129) — verrou de non-dérive entre la
 * documentation (`docs/api/openapi.json`) et le code réel (`app/api/**`).
 * Contrats :
 *  1. le JSON parse et respecte la structure OpenAPI 3.1 ;
 *  2. chaque chemin documenté correspond à un fichier de route réel ;
 *  3. chaque méthode documentée correspond à un export HTTP du routeur ;
 *  4. le path v1 exige le scheme de sécurité `bearerAuth` ;
 *  5. aucun chemin orphelin (documenté mais inexistant dans le code).
 * La spec ne peut donc pas dériver du code sans faire échouer la CI.
 */

// Test déplacé depuis docs/openapi.test.ts (restructuration Phase 1) :
// les chemins remontent d'un niveau supplémentaire vers la racine du dépôt.
const SPEC_URL = new URL("../../docs/api/openapi.json", import.meta.url);

/** Méthodes HTTP reconnues comme opérations OpenAPI dans un Path Item. */
const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

type HttpMethod = (typeof HTTP_METHODS)[number];

/** Vue typée minimale d'un objet JSON (les autres clés restent inconnues). */
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Valeur inattendue : un objet JSON était attendu.");
  }
  return value;
}

const spec = asObject(JSON.parse(readFileSync(SPEC_URL, "utf8")));
const paths = asObject(spec.paths);
const components = asObject(spec.components);
const securitySchemes = asObject(components.securitySchemes);
const schemas = asObject(components.schemas ?? {});

/** Chemins documentés (source de vérité : les clés de `paths`). */
const documentedPaths = Object.keys(paths);

/**
 * Convertit un chemin API documenté en fichier de route Next.js :
 * `/api/v1/agents/{agentId}/run` → `app/api/v1/agents/[agentId]/run/route.ts`
 * (les paramètres `{x}` d'OpenAPI deviennent les segments dynamiques `[x]`).
 */
function routeFileUrl(apiPath: string): URL {
  const segments = apiPath
    .replace(/^\//, "")
    .replace(/\{/g, "[")
    .replace(/\}/g, "]");
  return new URL(`../../app/${segments}/route.ts`, import.meta.url);
}

/** Méthodes HTTP réellement documentées pour un Path Item. */
function documentedMethods(pathItem: unknown): HttpMethod[] {
  const item = asObject(pathItem);
  return HTTP_METHODS.filter((method) => method in item);
}

/** Vrai si le fichier de route exporte la méthode HTTP donnée (function ou const). */
function routeExportsMethod(source: string, method: string): boolean {
  // Les clés OpenAPI sont en minuscules, les exports Next.js en majuscules.
  const exported = method.toUpperCase();
  return [
    new RegExp(`export\\s+async\\s+function\\s+${exported}\\b`),
    new RegExp(`export\\s+function\\s+${exported}\\b`),
    new RegExp(`export\\s+const\\s+${exported}\\b`),
  ].some((pattern) => pattern.test(source));
}

/** Sécurité effective d'une opération (au niveau opération, sinon path). */
function effectiveSecurity(pathItem: unknown, method: HttpMethod): unknown {
  const item = asObject(pathItem);
  const operation = item[method];
  if (operation !== undefined) {
    const security = asObject(operation).security;
    if (security !== undefined) return security;
  }
  return item.security ?? [];
}

/** Réfère-t-on au scheme de sécurité nommé ? (liste de dicts OpenAPI). */
function referencesScheme(security: unknown, scheme: string): boolean {
  if (!Array.isArray(security)) return false;
  return security.some((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    return scheme in (entry as JsonObject);
  });
}

/** Collecte récursivement toutes les références `$ref` de la spécification. */
function collectRefs(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, found);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as JsonObject)) {
      if (key === "$ref" && typeof child === "string") found.push(child);
      else collectRefs(child, found);
    }
  }
  return found;
}

describe("docs/api/openapi.json — structure OpenAPI 3.1", () => {
  it("déclare la version 3.1.x", () => {
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
  });

  it("porte un bloc info complet (titre, version, description)", () => {
    const info = asObject(spec.info);
    expect(info.title).toBe("Gen3ia API");
    expect(info.version).toBe("1.0.0");
    expect(String(info.description)).toContain("https://gen3ia.online");
  });

  it("documente des serveurs dont la production", () => {
    const servers = spec.servers;
    expect(Array.isArray(servers)).toBe(true);
    const urls = (servers as JsonObject[]).map((server) => server.url);
    expect(urls).toContain("https://gen3ia.online");
  });

  it("documente au moins un chemin", () => {
    expect(documentedPaths.length).toBeGreaterThan(0);
  });

  it("couvre exactement les endpoints publics attendus", () => {
    expect(documentedPaths).toEqual([
      "/api/v1/agents/{agentId}/run",
      "/api/status",
      "/api/health",
    ]);
  });
});

describe("docs/api/openapi.json — cohérence avec le code réel", () => {
  it.each(documentedPaths)("le chemin %s existe dans app/api/", (routePath) => {
    const routeUrl = routeFileUrl(routePath);
    // Aucun chemin orphelin : la spec ne documente que des routes livrées.
    expect(existsSync(routeUrl)).toBe(true);
  });

  it.each(documentedPaths)("chaque méthode de %s est exportée par la route", (routePath) => {
    const pathItem = paths[routePath];
    const methods = documentedMethods(pathItem);
    expect(methods.length).toBeGreaterThan(0);
    const source = readFileSync(routeFileUrl(routePath), "utf8");
    for (const method of methods) {
      expect(routeExportsMethod(source, method)).toBe(true);
    }
  });

  it("documente les méthodes réellement exportées par chaque route (aucune méthode manquante)", () => {
    for (const routePath of documentedPaths) {
      const methods = documentedMethods(paths[routePath]);
      const source = readFileSync(routeFileUrl(routePath), "utf8");
      const exported = HTTP_METHODS.filter((method) => routeExportsMethod(source, method));
      // La spec doit couvrir TOUTES les méthodes exportées par la route :
      // une route qui exporte GET doit être documentée avec GET.
      expect(methods).toEqual(expect.arrayContaining(exported));
    }
  });
});

describe("docs/api/openapi.json — sécurité", () => {
  it("définit les schemes bearerAuth et apiKeyHeader", () => {
    expect(Object.keys(securitySchemes).sort()).toEqual(["apiKeyHeader", "bearerAuth"]);
    expect(asObject(securitySchemes.bearerAuth).scheme).toBe("bearer");
    expect(asObject(securitySchemes.apiKeyHeader).name).toBe("X-API-Key");
  });

  it("applique bearerAuth au path v1 (niveau opération ou path)", () => {
    const security = effectiveSecurity(paths["/api/v1/agents/{agentId}/run"], "post");
    expect(referencesScheme(security, "bearerAuth")).toBe(true);
    expect(referencesScheme(security, "apiKeyHeader")).toBe(true);
  });

  it.each(["/api/status", "/api/health"])("%s est explicitement public (security vide)", (routePath) => {
    const security = effectiveSecurity(paths[routePath], "get");
    expect(security).toEqual([]);
  });
});

describe("docs/api/openapi.json — intégrité des références", () => {
  it("chaque $ref pointe vers un schéma défini dans components", () => {
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/schemas\/[^/]+$/);
      const schemaName = ref.split("/").pop() as string;
      expect(Object.keys(schemas)).toContain(schemaName);
    }
  });
});
