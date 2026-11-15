import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Tool « watchdog.track » (Task 140) — surveillance de pages stratégiques.
 *
 * Verrous :
 *  1. register : SSRF (moquée), fetch protégé, référence normalisée + empreinte
 *     SHA-256 persistée dans « agentWatchdogs » (portée userId) ;
 *  2. check sans changement → changed:false, AUCUN appel LLM ;
 *  3. check avec changement → diff déterministe (ajouts/retraits), classifica-
 *     tion IA enregistrée, référence AVANCÉE au contenu courant (incrémental),
 *     historique plafonné à 50 entrées (la plus ancienne est évacuée) ;
 *  4. status n'expose JAMAIS la référence complète (aperçu 300 caractères) ;
 *  5. remove supprime réellement ; toute commande sur un document d'autrui
 *     échoue en français sans révéler son existence ;
 *  6. page inaccessible (5xx) → erreur française, rien de persisté.
 *
 * Frontières moquées : adminDb (Map, style bland-calls.test.ts), fetch
 * (global), generateForUser (LLM facturé), assertPublicHttpUrl (SSRF).
 */

const generateMock = vi.hoisted(() => vi.fn());
const assertPublicHttpUrlMock = vi.hoisted(() => vi.fn());
const store = vi.hoisted(() => ({ docs: new Map<string, Record<string, unknown>>() }));

function makeDocRef(fullKey: string, rawId: string) {
  return {
    id: rawId,
    get: vi.fn(async () => {
      const data = store.docs.get(fullKey);
      return { exists: Boolean(data), id: rawId, data: () => (data ? { ...data } : undefined) };
    }),
    set: vi.fn(async (data: Record<string, unknown>) => {
      store.docs.set(fullKey, { ...data });
    }),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      const current = store.docs.get(fullKey) ?? {};
      store.docs.set(fullKey, { ...current, ...patch });
    }),
    delete: vi.fn(async () => {
      store.docs.delete(fullKey);
    }),
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: (id: string) => makeDocRef(`${name}/${id}`, id),
    })),
  },
}));

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: (...args: unknown[]) => generateMock(...args),
}));

vi.mock("@/lib/security/url-safety", () => ({
  assertPublicHttpUrl: (...args: unknown[]) => assertPublicHttpUrlMock(...args),
}));

import { watchdogTrackTool } from "./watchdog-track";

const CONTEXT = { userId: "user-1", executionId: "exec-watch-1" };

const HTML_A = "<html><body><h1>Boutique</h1><p>Prix : 10 €</p></body></html>";
const HTML_B = "<html><body><h1>Boutique</h1><p>Prix : 12 €</p><p>Nouvelle offre été</p></body></html>";
const TEXT_A = "Boutique\nPrix : 10 €";
const TEXT_B = "Boutique\nPrix : 12 €\nNouvelle offre été";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const CLASSIFICATION = {
  superficial: false,
  strategic: true,
  category: "prix",
  summary: "Le prix est passé de 10 € à 12 €.",
  importance: 4,
};

interface LlmCall {
  userId: string;
  request: { task: string; system: string; messages: Array<{ role: string; content: string }>; maxTokens: number };
}

function pageResponse(html: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  const status = init.status ?? 200;
  const headers = init.headers ?? {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => html,
  };
}

const fetchMock = vi.fn();

type RegisterResult = { watchId: string; label: string; baselineChars: number; message: string };
type CheckChangedResult = {
  watchId: string;
  changed: true;
  classification: typeof CLASSIFICATION;
  addedLines: string[];
  removedLines: string[];
  historySize: number;
};

async function registerWatch(): Promise<RegisterResult> {
  return (await watchdogTrackTool.execute(
    {
      mode: "register",
      url: "https://exemple.com/prix",
      label: "Page des prix",
      instructions: "Surveiller les changements de prix.",
    },
    CONTEXT,
  )) as RegisterResult;
}

beforeEach(() => {
  store.docs.clear();
  generateMock.mockReset().mockImplementation(async (_call: LlmCall) => ({
    chargeMinor: 1,
    providerCostEur: 0,
    response: { text: JSON.stringify(CLASSIFICATION), usage: { inputTokens: 10, outputTokens: 5 } },
  }));
  assertPublicHttpUrlMock.mockReset().mockImplementation(async (url: string) => new URL(url));
  fetchMock.mockReset().mockResolvedValue(pageResponse(HTML_A));
  vi.stubGlobal("fetch", fetchMock);
});

/* ──────────────────────────────────────────────────────────────────── */
/* Schéma d'entrée                                                     */
/* ──────────────────────────────────────────────────────────────────── */

describe("watchdog.track — schéma d'entrée", () => {
  it("exige une URL pour register et un watchId pour check/status/remove", async () => {
    expect(() => watchdogTrackTool.inputSchema.parse({ mode: "register" })).toThrow(/register.*URL/i);
    expect(() => watchdogTrackTool.inputSchema.parse({ mode: "check" })).toThrow(/watchId/);
    expect(() => watchdogTrackTool.inputSchema.parse({ mode: "status" })).toThrow(/watchId/);
    expect(() => watchdogTrackTool.inputSchema.parse({ mode: "remove" })).toThrow(/watchId/);
    expect(() => watchdogTrackTool.inputSchema.parse({ mode: "diagnostic", url: "https://a.exemple.com" })).toThrow();
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (a) register                                                        */
/* ──────────────────────────────────────────────────────────────────── */

describe("watchdog.track — register", () => {
  it("(a) persiste le document avec l'empreinte de la référence et retourne le watchId", async () => {
    const result = await registerWatch();

    expect(result.watchId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.label).toBe("Page des prix");
    expect(result.baselineChars).toBe(TEXT_A.length);
    expect(result.message).toMatch(/enregistrée/i);

    const doc = store.docs.get(`agentWatchdogs/${result.watchId}`);
    expect(doc).toBeDefined();
    expect(doc).toMatchObject({
      id: result.watchId,
      userId: "user-1",
      url: "https://exemple.com/prix",
      label: "Page des prix",
      instructions: "Surveiller les changements de prix.",
      baselineText: TEXT_A,
      baselineHash: sha256(TEXT_A),
      history: [],
      active: true,
    });
    expect(typeof doc?.createdAt).toBe("number");
    expect(doc?.lastChangeAt).toBeNull();
  });

  it("(a-bis) déduit le libellé de l'hôte quand aucun libellé n'est fourni", async () => {
    const result = (await watchdogTrackTool.execute(
      { mode: "register", url: "https://boutique.exemple.com/tarifs" },
      CONTEXT,
    )) as RegisterResult;
    expect(result.label).toBe("boutique.exemple.com");
  });

  it("(g) page inaccessible (HTTP 500) → erreur française, rien de persisté", async () => {
    fetchMock.mockResolvedValue(pageResponse("erreur interne", { status: 500 }));
    await expect(registerWatch()).rejects.toThrow(/Page inaccessible/);
    expect(store.docs.size).toBe(0);
  });

  it("suit UNE redirection revalidée puis refuse les redirections multiples", async () => {
    fetchMock
      .mockResolvedValueOnce(pageResponse("", { status: 301, headers: { location: "https://exemple.com/final" } }))
      .mockResolvedValueOnce(pageResponse(HTML_A));
    const result = await registerWatch();
    expect(store.docs.get(`agentWatchdogs/${result.watchId}`)?.baselineHash).toBe(sha256(TEXT_A));
    expect(assertPublicHttpUrlMock).toHaveBeenCalledTimes(2);

    fetchMock.mockReset().mockResolvedValue(pageResponse("", { status: 302, headers: { location: "https://exemple.com/ailleurs" } }));
    await expect(registerWatch()).rejects.toThrow(/redirections multiples/);
  });

  it("refuse les pages au-delà du plafond de 5 Mo", async () => {
    fetchMock.mockResolvedValue(pageResponse(HTML_A, { headers: { "content-length": "6000000" } }));
    await expect(registerWatch()).rejects.toThrow(/trop volumineuse/);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (b)(c) check                                                        */
/* ──────────────────────────────────────────────────────────────────── */

describe("watchdog.track — check", () => {
  it("(b) contenu identique → changed:false, aucun appel LLM, lastCheckedAt rafraîchi", async () => {
    const registered = await registerWatch();
    const result = await watchdogTrackTool.execute({ mode: "check", watchId: registered.watchId }, CONTEXT);

    expect(result).toMatchObject({ watchId: registered.watchId, changed: false, message: "Aucun changement détecté." });
    expect(generateMock).not.toHaveBeenCalled();

    const doc = store.docs.get(`agentWatchdogs/${registered.watchId}`);
    expect(doc?.history).toEqual([]);
    expect(doc?.lastCheckedAt).toBeGreaterThanOrEqual(doc?.createdAt ?? 0);
  });

  it("(c) contenu changé → classification IA enregistrée, référence avancée, historique ajouté", async () => {
    const registered = await registerWatch();
    fetchMock.mockResolvedValue(pageResponse(HTML_B));

    const result = (await watchdogTrackTool.execute(
      { mode: "check", watchId: registered.watchId },
      CONTEXT,
    )) as CheckChangedResult;

    expect(result.changed).toBe(true);
    expect(result.classification).toEqual(CLASSIFICATION);
    expect(result.addedLines).toEqual(["Prix : 12 €", "Nouvelle offre été"]);
    expect(result.removedLines).toEqual(["Prix : 10 €"]);
    expect(result.historySize).toBe(1);

    // L'appel LLM : tâche reasoning, 1000 tokens, lignes du diff + consignes.
    expect(generateMock).toHaveBeenCalledTimes(1);
    const llmCall = generateMock.mock.calls[0]?.[0] as LlmCall;
    expect(llmCall.userId).toBe("user-1");
    expect(llmCall.request.task).toBe("reasoning");
    expect(llmCall.request.maxTokens).toBe(1_000);
    expect(llmCall.request.messages[0]?.content).toContain("Prix : 12 €");
    expect(llmCall.request.messages[0]?.content).toContain("Surveiller les changements de prix.");

    // La référence est TOUJOURS avancée au contenu courant (vérification incrémentale).
    const doc = store.docs.get(`agentWatchdogs/${registered.watchId}`);
    expect(doc?.baselineText).toBe(TEXT_B);
    expect(doc?.baselineHash).toBe(sha256(TEXT_B));
    expect(doc?.lastChangeAt).toEqual(expect.any(Number));
    expect(doc?.history).toEqual([
      { checkedAt: expect.any(Number), changed: true, strategic: true, summary: CLASSIFICATION.summary },
    ]);
  });

  it("(c-bis) 51e vérification modifiée → historique plafonné à 50, la plus ancienne est évacuée", async () => {
    generateMock.mockImplementation(async (call: LlmCall) => {
      const match = /Prix : (\d+) €/.exec(call.request.messages[0]?.content ?? "");
      return {
        chargeMinor: 1,
        providerCostEur: 0,
        response: {
          text: JSON.stringify({ ...CLASSIFICATION, summary: `Prix : ${match?.[1] ?? "?"} €` }),
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      };
    });

    const registered = await registerWatch();
    for (let i = 1; i <= 51; i += 1) {
      fetchMock.mockResolvedValueOnce(
        pageResponse(`<html><body><h1>Boutique</h1><p>Prix : ${i} €</p></body></html>`),
      );
      await watchdogTrackTool.execute({ mode: "check", watchId: registered.watchId }, CONTEXT);
    }

    const doc = store.docs.get(`agentWatchdogs/${registered.watchId}`);
    expect(doc?.history).toHaveLength(50);
    // L'entrée de la 1re vérification (Prix : 1 €) a été évacuée ; la 51e est la dernière.
    expect(doc?.history?.[0]?.summary).toBe("Prix : 2 €");
    expect(doc?.history?.[49]?.summary).toBe("Prix : 51 €");
  });

  it("échec de la classification IA → fail-soft : changement signalé, classification explicite", async () => {
    generateMock.mockImplementation(async () => {
      throw new Error("Le modèle n'a pas produit une réponse conforme au format attendu après 2 tentative(s).");
    });
    const registered = await registerWatch();
    fetchMock.mockResolvedValue(pageResponse(HTML_B));

    const result = (await watchdogTrackTool.execute(
      { mode: "check", watchId: registered.watchId },
      CONTEXT,
    )) as CheckChangedResult;

    expect(result.changed).toBe(true);
    expect(result.classification.strategic).toBe(false);
    expect(result.classification.summary).toMatch(/non classé/);
    expect(result.historySize).toBe(1);
    // La référence a malgré tout avancé.
    const doc = store.docs.get(`agentWatchdogs/${registered.watchId}`);
    expect(doc?.baselineHash).toBe(sha256(TEXT_B));
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (d) status                                                          */
/* ──────────────────────────────────────────────────────────────────── */

describe("watchdog.track — status", () => {
  it("(d) n'expose jamais la référence complète (aperçu de 300 caractères)", async () => {
    const longHtml = `<html><body><h1>Journal</h1>${"<p>Ligne de journal détaillée et répétée pour dépasser trois cents caractères de référence.</p>".repeat(20)}</body></html>`;
    fetchMock.mockResolvedValue(pageResponse(longHtml));
    const registered = (await watchdogTrackTool.execute(
      { mode: "register", url: "https://exemple.com/journal", label: "Journal" },
      CONTEXT,
    )) as RegisterResult;
    expect(registered.baselineChars).toBeGreaterThan(300);

    const status = await watchdogTrackTool.execute({ mode: "status", watchId: registered.watchId }, CONTEXT);
    expect(status).not.toHaveProperty("baselineText");
    const record = status as { baselinePreview: string; baselineChars: number; url: string; label: string; active: boolean; history: unknown[] };
    expect(record.baselinePreview).toHaveLength(300);
    expect(record.baselinePreview.startsWith("Journal")).toBe(true);
    expect(record.baselineChars).toBe(registered.baselineChars);
    expect(record.url).toBe("https://exemple.com/journal");
    expect(record.label).toBe("Journal");
    expect(record.active).toBe(true);
    expect(Array.isArray(record.history)).toBe(true);
  });
});

/* ──────────────────────────────────────────────────────────────────── */
/* (e)(f) remove + propriété                                          */
/* ──────────────────────────────────────────────────────────────────── */

describe("watchdog.track — remove et garde de propriété", () => {
  it("(e) supprime réellement la surveillance", async () => {
    const registered = await registerWatch();
    const result = await watchdogTrackTool.execute({ mode: "remove", watchId: registered.watchId }, CONTEXT);
    expect(result).toEqual({ watchId: registered.watchId, removed: true });
    expect(store.docs.has(`agentWatchdogs/${registered.watchId}`)).toBe(false);

    // Une seconde suppression échoue honnêtement.
    await expect(
      watchdogTrackTool.execute({ mode: "remove", watchId: registered.watchId }, CONTEXT),
    ).rejects.toThrow(/introuvable/);
  });

  it("(f) document d'un autre utilisateur → erreur française pour check/status/remove, sans fetch", async () => {
    store.docs.set("agentWatchdogs/wd-autre", {
      id: "wd-autre",
      userId: "user-2",
      url: "https://exemple.com/x",
      label: "Autre",
      instructions: "",
      baselineText: "x",
      baselineHash: "h",
      createdAt: 1,
      lastCheckedAt: 1,
      lastChangeAt: null,
      history: [],
      active: true,
    });
    for (const mode of ["check", "status", "remove"] as const) {
      await expect(
        watchdogTrackTool.execute({ mode, watchId: "wd-autre" }, CONTEXT),
      ).rejects.toThrow(/introuvable/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(generateMock).not.toHaveBeenCalled();
    expect(store.docs.has("agentWatchdogs/wd-autre")).toBe(true);
  });
});
