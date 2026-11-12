import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outil `web.dns` — résolution DNS. AUCUNE résolution réelle dans les tests :
 * node:dns/promises est entièrement mocké (lookup, resolveMx, resolveTxt,
 * resolveNs, resolveCname, resolveSoa). Les cas d'erreur (ENOTFOUND,
 * ENODATA, délai dépassé) sont simulés avec les codes réels du résolveur.
 */

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
  resolveMx: vi.fn(),
  resolveTxt: vi.fn(),
  resolveNs: vi.fn(),
  resolveCname: vi.fn(),
  resolveSoa: vi.fn(),
}));

import { lookup, resolveCname, resolveMx, resolveNs, resolveSoa, resolveTxt } from "node:dns/promises";

import { outilWebDns } from "./dns";

const mockLookup = vi.mocked(lookup);
const mockResolveMx = vi.mocked(resolveMx);
const mockResolveTxt = vi.mocked(resolveTxt);
const mockResolveNs = vi.mocked(resolveNs);
const mockResolveCname = vi.mocked(resolveCname);
const mockResolveSoa = vi.mocked(resolveSoa);

const CONTEXTE = { userId: "utilisateur-test", executionId: "exec-test" };

function erreurDns(code: string, message: string): Error {
  const erreur = new Error(message) as Error & { code?: string };
  erreur.code = code;
  return erreur;
}

beforeEach(() => {
  // resetAllMocks (et non clearAllMocks) : aucune implémentation ne fuite.
  vi.resetAllMocks();
});

describe("outil web.dns — schéma d'entrée", () => {
  it("valide un nom d'hôte simple et des sous-domaines (avec underscores)", () => {
    expect(outilWebDns.inputSchema.safeParse({ hote: "exemple.com" }).success).toBe(true);
    expect(outilWebDns.inputSchema.safeParse({ hote: "_dmarc.exemple.com" }).success).toBe(true);
    expect(outilWebDns.inputSchema.safeParse({ hote: "exemple.com." }).success).toBe(true);
  });

  it("refuse une URL complète, un hôte vide et des étiquettes trop longues", () => {
    expect(outilWebDns.inputSchema.safeParse({ hote: "https://exemple.com" }).success).toBe(false);
    expect(outilWebDns.inputSchema.safeParse({ hote: "" }).success).toBe(false);
    expect(outilWebDns.inputSchema.safeParse({ hote: `${"a".repeat(64)}.com` }).success).toBe(false);
    expect(outilWebDns.inputSchema.safeParse({ hote: "-invalide.com" }).success).toBe(false);
  });

  it("borne timeoutMs entre 500 et 15000 ms", () => {
    expect(outilWebDns.inputSchema.safeParse({ hote: "exemple.com", timeoutMs: 100 }).success).toBe(false);
    expect(outilWebDns.inputSchema.safeParse({ hote: "exemple.com", timeoutMs: 20_000 }).success).toBe(false);
    const analyse = outilWebDns.inputSchema.parse({ hote: "exemple.com" });
    expect(analyse.timeoutMs).toBe(5_000);
  });
});

describe("outil web.dns — résolution complète (mocks)", () => {
  it("restitue chaque type avec une structure dédiée et trie les MX par priorité", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4, ttl: 3600 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6, ttl: 600 },
    ]);
    mockResolveMx.mockResolvedValueOnce([
      { exchange: "mx2.exemple.com", priority: 20 },
      { exchange: "mx1.exemple.com", priority: 10 },
    ]);
    mockResolveTxt.mockResolvedValueOnce([["v=spf1 ", "include:exemple.net ", "~all"]]);
    mockResolveNs.mockResolvedValueOnce(["ns1.exemple.com", "ns2.exemple.com"]);
    mockResolveCname.mockResolvedValueOnce(["alias.exemple.com"]);
    mockResolveSoa.mockResolvedValueOnce({
      nsname: "ns1.exemple.com",
      hostmaster: "admin.exemple.com",
      serial: 2025010101,
      refresh: 7200,
      retry: 3600,
      expire: 1209600,
      minttl: 300,
    });

    const resultat = await outilWebDns.execute(
      outilWebDns.inputSchema.parse({ hote: "exemple.com" }),
      CONTEXTE,
    );

    expect(resultat.succes).toBe(true);
    expect(resultat.erreurs).toEqual([]);
    expect(resultat.resultats.lookup).toEqual([
      { adresse: "93.184.216.34", famille: "IPv4", ttl: 3600 },
      { adresse: "2606:2800:220:1:248:1893:25c8:1946", famille: "IPv6", ttl: 600 },
    ]);
    expect(resultat.resultats.mx).toEqual([
      { echange: "mx1.exemple.com", priorite: 10 },
      { echange: "mx2.exemple.com", priorite: 20 },
    ]);
    expect(resultat.resultats.txt).toEqual(["v=spf1 include:exemple.net ~all"]);
    expect(resultat.resultats.ns).toEqual(["ns1.exemple.com", "ns2.exemple.com"]);
    expect(resultat.resultats.cname).toEqual(["alias.exemple.com"]);
    expect(resultat.resultats.soa).toEqual({
      nsPrimaire: "ns1.exemple.com",
      courrielAdmin: "admin.exemple.com",
      serie: 2025010101,
      rafraichissement: 7200,
      nouvelEssai: 3600,
      expiration: 1209600,
      ttlMin: 300,
    });
  });

  it("n'interroge que les types demandés", async () => {
    await outilWebDns.execute(
      outilWebDns.inputSchema.parse({ hote: "exemple.com", types: ["mx"] }),
      CONTEXTE,
    );
    expect(mockResolveMx).toHaveBeenCalledTimes(1);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockResolveTxt).not.toHaveBeenCalled();
  });
});

describe("outil web.dns — erreurs honnêtes par type", () => {
  it("rapporte ENOTFOUND avec son code sans interrompre les autres types", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4, ttl: 3600 }]);
    mockResolveMx.mockRejectedValueOnce(erreurDns("ENOTFOUND", "getaddrinfo ENOTFOUND exemple.com"));
    mockResolveTxt.mockRejectedValueOnce(erreurDns("ENODATA", "ENODATA pour ce nom"));

    const resultat = await outilWebDns.execute(
      outilWebDns.inputSchema.parse({ hote: "exemple.com", types: ["lookup", "mx", "txt"] }),
      CONTEXTE,
    );

    expect(resultat.succes).toBe(true);
    expect(resultat.resultats.lookup).toHaveLength(1);
    expect(resultat.erreurs).toEqual([
      { type: "mx", code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND exemple.com" },
      { type: "txt", code: "ENODATA", message: "ENODATA pour ce nom" },
    ]);
    expect(resultat.remarques.some((r) => /néanmoins réels/.test(r))).toBe(true);
  });

  it("échoue honnêtement quand TOUS les types sont en erreur", async () => {
    mockLookup.mockRejectedValueOnce(erreurDns("ENOTFOUND", "getaddrinfo ENOTFOUND hote-inexistant.test"));
    const resultat = await outilWebDns.execute(
      outilWebDns.inputSchema.parse({ hote: "hote-inexistant.test", types: ["lookup"] }),
      CONTEXTE,
    );
    expect(resultat.succes).toBe(false);
    expect(resultat.erreurs[0]?.code).toBe("ENOTFOUND");
    expect(Object.keys(resultat.resultats)).toEqual([]);
  });

  it("respecte le délai par type et signale ETIMEOUT", async () => {
    mockLookup.mockImplementationOnce(() => new Promise(() => undefined)); // ne répond jamais
    const debut = Date.now();
    const resultat = await outilWebDns.execute(
      outilWebDns.inputSchema.parse({ hote: "exemple.com", types: ["lookup"], timeoutMs: 500 }),
      CONTEXTE,
    );
    expect(Date.now() - debut).toBeGreaterThanOrEqual(500);
    expect(resultat.erreurs[0]?.code).toBe("ETIMEOUT");
    expect(resultat.erreurs[0]?.message).toMatch(/délai dépassé \(500 ms\) pour « lookup »/);
    expect(resultat.succes).toBe(false);
  });

  it("déclare honnêtement l'absence de TTL hors lookup", async () => {
    mockResolveMx.mockResolvedValueOnce([{ exchange: "mx.exemple.com", priority: 5 }]);
    const resultat = await outilWebDns.execute(
      outilWebDns.inputSchema.parse({ hote: "exemple.com", types: ["mx"] }),
      CONTEXTE,
    );
    expect(resultat.remarques.some((r) => /n'expose pas de TTL/.test(r))).toBe(true);
  });
});
