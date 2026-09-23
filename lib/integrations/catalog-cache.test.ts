import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildCatalogCacheKey,
  CATALOG_CACHE_TTL_SECONDS,
  CATALOG_CACHE_VERSION,
  CATALOG_DESCRIPTION_MAX_CHARS,
  etagMatches,
  strongEtag,
  truncateDescription,
  type CatalogResponseEnvelope,
} from "./catalog-cache";

describe("buildCatalogCacheKey (clé versionnée du catalogue)", () => {
  it("embedde la version, la limite et la catégorie (défaut : all / none)", () => {
    const key = buildCatalogCacheKey({ limit: 1000 });
    expect(key).toBe(`catalog:${CATALOG_CACHE_VERSION}:1000:all:none`);
  });

  it("est déterministe : mêmes paramètres → même clé (prérequis cache-aside)", () => {
    const a = buildCatalogCacheKey({ limit: 500, category: "crm", search: "hubspot" });
    const b = buildCatalogCacheKey({ limit: 500, category: "crm", search: "hubspot" });
    expect(a).toBe(b);
  });

  it("sépare les variantes : limites, catégories et recherches différentes → clés distinctes", () => {
    const base = buildCatalogCacheKey({ limit: 1000 });
    expect(buildCatalogCacheKey({ limit: 5000 })).not.toBe(base);
    expect(buildCatalogCacheKey({ limit: 1000, category: "crm" })).not.toBe(base);
    expect(buildCatalogCacheKey({ limit: 1000, search: "slack" })).not.toBe(base);
  });

  it("normalise la recherche (trim + minuscules) : « GitHub » et «  github » partagent la même entrée", () => {
    // La route filtre elle-même en minuscules : ces deux requêtes produisent
    // le même corps et DOIVENT partager une seule entrée de cache.
    expect(buildCatalogCacheKey({ limit: 1000, search: "GitHub" })).toBe(
      buildCatalogCacheKey({ limit: 1000, search: "  github " }),
    );
  });

  it("ne normalise PAS la casse de la catégorie (le filtre serveur est sensible à la casse)", () => {
    // Compatibilité : « CRM » ne matche aucune item côté filtre, « crm » oui —
    // les deux ne doivent donc jamais partager une entrée de cache.
    expect(buildCatalogCacheKey({ limit: 1000, category: "CRM" })).not.toBe(
      buildCatalogCacheKey({ limit: 1000, category: "crm" }),
    );
  });

  it("repli défensif sur la limite par défaut (1000) si la valeur est invalide", () => {
    const defaut = buildCatalogCacheKey({ limit: 1000 });
    expect(buildCatalogCacheKey({ limit: Number.NaN })).toBe(defaut);
    expect(buildCatalogCacheKey({ limit: 0 })).toBe(defaut);
    expect(buildCatalogCacheKey({ limit: -5 })).toBe(defaut);
    expect(buildCatalogCacheKey({ limit: 100.9 })).toBe(buildCatalogCacheKey({ limit: 100 }));
  });
});

describe("truncateDescription (payload maîtrisé)", () => {
  it("retourne une chaîne vide pour une entrée non textuelle ou vide", () => {
    expect(truncateDescription(null)).toBe("");
    expect(truncateDescription(undefined)).toBe("");
    expect(truncateDescription(42)).toBe("");
    expect(truncateDescription("   ")).toBe("");
  });

  it("supprime les espaces superflus et laisse intacte une description courte", () => {
    expect(truncateDescription("  CRM et automatisation commerciale.  ")).toBe(
      "CRM et automatisation commerciale.",
    );
  });

  it("préserve une description exactement à la limite", () => {
    const exact = "a".repeat(CATALOG_DESCRIPTION_MAX_CHARS);
    expect(truncateDescription(exact)).toBe(exact);
  });

  it("tronque à ~140 caractères avec un suffixe « … » inclus dans le plafond", () => {
    const longue = `Logging ${"x".repeat(400)}`;
    const tronquee = truncateDescription(longue);
    expect(tronquee.length).toBe(CATALOG_DESCRIPTION_MAX_CHARS);
    expect(tronquee.endsWith("…")).toBe(true);
    expect(tronquee.startsWith("Logging")).toBe(true);
  });

  it("accepte un plafond personnalisé et borné (minimum 1 caractère)", () => {
    expect(truncateDescription("abcdef", 4)).toBe("abc…");
    expect(truncateDescription("abcdef", 0)).toBe("…");
  });
});

describe("strongEtag (ETag fort RFC 7232)", () => {
  const corps = JSON.stringify({ items: [{ toolkit: "slack" }], totalItems: 1 });

  it("produit un ETag fort : guillemets doubles + SHA-256 hexadécimal (64 car.)", () => {
    const etag = strongEtag(corps);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(etag).toBe(`"${createHash("sha256").update(corps, "utf8").digest("hex")}"`);
  });

  it("est stable pour un corps identique et sensible au moindre changement d'octet", () => {
    expect(strongEtag(corps)).toBe(strongEtag(corps));
    expect(strongEtag(corps)).not.toBe(strongEtag(`${corps} `));
  });

  it("reste stable après un aller-retour JSON (sémantique Upstash cacheSet→cacheGet)", () => {
    // L'enveloppe stockée dans Redis est relue via JSON.parse : le corps
    // (chaîne) doit ressortir identique pour que l'ETag corresponde encore.
    const envelope: CatalogResponseEnvelope = { etag: strongEtag(corps), body: corps };
    const relu = JSON.parse(JSON.stringify(envelope)) as CatalogResponseEnvelope;
    expect(relu.body).toBe(corps);
    expect(relu.etag).toBe(envelope.etag);
  });
});

describe("etagMatches (validation If-None-Match)", () => {
  const etag = strongEtag("corps-de-reponse");

  it("ne renvoie jamais de 304 sans entête If-None-Match", () => {
    expect(etagMatches(null, etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches("", etag)).toBe(false);
  });

  it("traite « * » comme « n'importe quelle version » (RFC 9110)", () => {
    expect(etagMatches("*", etag)).toBe(true);
  });

  it("correspond à l'ETag exact, avec tolérance des espaces et des listes", () => {
    expect(etagMatches(etag, etag)).toBe(true);
    expect(etagMatches(`  ${etag}  `, etag)).toBe(true);
    expect(etagMatches(`"autre", ${etag}`, etag)).toBe(true);
  });

  it("applique la comparaison FAIBLE : W/\"…\" correspond à l'ETag fort équivalent", () => {
    expect(etagMatches(`W/${etag}`, etag)).toBe(true);
  });

  it("ne correspond pas à un ETag différent", () => {
    expect(etagMatches(`"${"0".repeat(64)}"`, etag)).toBe(false);
    expect(etagMatches(`W/"autre-etag"`, etag)).toBe(false);
  });
});

describe("constantes de cache exposées", () => {
  it("garantissent les engagements de la Task 25-g (TTL 5 min, version bumpable)", () => {
    expect(CATALOG_CACHE_TTL_SECONDS).toBe(300);
    expect(CATALOG_CACHE_VERSION).toMatch(/^v\d+$/);
    expect(CATALOG_DESCRIPTION_MAX_CHARS).toBe(140);
  });
});
