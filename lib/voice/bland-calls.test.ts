import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Registre des appels vocaux Bland (collection « voiceCalls ») :
 *  - normalisation des statuts bruts Bland vers les statuts Gen3ia ;
 *  - round-trip des enregistrements (transcripts, rôles, champs flottants) ;
 *  - fusion idempotente des détails post-appel (webhook / polling) avec
 *    facturation miroir UNE SEULE fois ;
 *  - quota journalier (transaction, refus au-delà de la limite).
 */

const store = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  dailyCount: 0,
  billed: [] as Array<{ userId: string; kind: string; quantity: number }>,
}));

/** Référence de document mockée : id BRUT pour l'API, clé complète pour le store. */
function makeDocRef(fullKey: string, rawId: string) {
  const read = async () => {
    const data = store.docs.get(fullKey);
    return { exists: Boolean(data), id: rawId, data: () => (data ? { ...data } : undefined) };
  };
  return {
    id: rawId,
    _key: fullKey,
    get: vi.fn(read),
    set: vi.fn(async (data: Record<string, unknown>) => {
      store.docs.set(fullKey, { ...data });
    }),
    update: vi.fn(async (patch: Record<string, unknown>) => {
      const current = store.docs.get(fullKey) ?? {};
      store.docs.set(fullKey, { ...current, ...patch });
    }),
    delete: vi.fn(async () => store.docs.delete(fullKey)),
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => ({
      doc: (id: string) => makeDocRef(`${name}/${id}`, id),
      where: vi.fn(() => {
        throw new Error("non utilisé dans ces tests");
      }),
    })),
    runTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { _key: string }) => {
          const daily = store.docs.get(ref._key);
          return { exists: Boolean(daily), data: () => (daily ? { ...daily } : undefined) };
        },
        set: async (ref: { _key: string }, data: Record<string, unknown>, _opts?: unknown) => {
          const current = store.docs.get(ref._key) ?? {};
          store.docs.set(ref._key, { ...current, ...data });
        },
      }),
    ),
  },
}));

vi.mock("@/lib/billing/media-meter", () => ({
  billUsage: vi.fn(async (params: { userId: string; kind: string; quantity: number }) => {
    if (store.billed.length === 98) throw new Error("solde insuffisant (mock)");
    store.billed.push(params);
    return { chargeMinor: Math.round(params.quantity * 12) };
  }),
}));

vi.mock("@/lib/integrations/bland/client", () => ({
  getBlandCall: vi.fn(async (callId: string) => {
    const doc = store.docs.get(`voiceCalls/${callId}`);
    if (!doc) throw new Error("appel inconnu");
    return {
      callId,
      status: "completed",
      completed: true,
      queueStatus: "complete",
      answeredBy: "human",
      callEndedBy: "ASSISTANT",
      errorMessage: null,
      to: String(doc.to ?? ""),
      from: null,
      lengthMinutes: 2.5,
      priceUsd: 0.09,
      summary: "Résumé Bland.",
      concatenatedTranscript: null,
      transcripts: [
        { role: "user", text: "Allo ?", at: "2026-10-13T10:00:00Z" },
        { role: "assistant", text: "Bonjour !", at: "2026-10-13T10:00:05Z" },
      ],
      recordingUrl: "https://rec.example/x.mp3",
      createdAt: null,
      startedAt: null,
      endedAt: null,
      metadata: null,
      variables: null,
      batchId: null,
    };
  }),
}));

import {
  applyBlandCallDetails,
  assertVoiceCallOwner,
  createVoiceCallRecord,
  getVoiceCall,
  listVoiceCalls,
  normalizeBlandStatus,
  reserveDailyVoiceCallSlot,
  syncVoiceCallFromBland,
} from "@/lib/voice/bland-calls";

function seedCall(overrides: Record<string, unknown> = {}): string {
  const callId = `call-${store.docs.size + 1}`;
  store.docs.set(`voiceCalls/${callId}`, {
    provider: "bland",
    userId: "user-1",
    agentId: "agent-1",
    direction: "outbound",
    to: "+237600000000",
    from: null,
    objective: "Confirmer le RDV.",
    language: "fr-FR",
    status: "queued",
    completed: false,
    history: [],
    createdAt: Date.parse("2026-10-13T10:00:00Z"),
    updatedAt: Date.parse("2026-10-13T10:00:00Z"),
    ...overrides,
  });
  return callId;
}

beforeEach(() => {
  store.docs.clear();
  store.billed = [];
  vi.clearAllMocks();
});

describe("Normalisation des statuts", () => {
  it("mappe les statuts bruts vers l'affichage Gen3ia", () => {
    expect(normalizeBlandStatus({ completed: true, status: "completed", queueStatus: "complete" } as never)).toBe("completed");
    expect(normalizeBlandStatus({ completed: true, status: "failed", queueStatus: null } as never)).toBe("failed");
    expect(normalizeBlandStatus({ completed: false, status: "unknown", queueStatus: "active" } as never)).toBe("in-progress");
    expect(normalizeBlandStatus({ completed: false, status: "unknown", queueStatus: "queued" } as never)).toBe("queued");
    // Statut inconnu terminé → completed (fail-safe).
    expect(normalizeBlandStatus({ completed: true, status: "etrange", queueStatus: null } as never)).toBe("completed");
  });
});

describe("Registre voiceCalls", () => {
  it("createVoiceCallRecord écrit le document puis getVoiceCall le relit intact", async () => {
    const record = await createVoiceCallRecord({
      callId: "bland-call-9",
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Assistant",
      blandAgentId: "bland-1",
      to: "+237600000000",
      objective: "Confirmer le RDV.",
      language: "fr-FR",
    });
    expect(record.id).toBe("bland-call-9");
    expect(record.status).toBe("queued");
    expect(record.provider).toBe("bland");

    const reloaded = await getVoiceCall("bland-call-9");
    expect(reloaded?.userId).toBe("user-1");
    expect(reloaded?.agentName).toBe("Assistant");
  });

  it("assertVoiceCallOwner accepte le propriétaire et rejette tout autre utilisateur", async () => {
    const callId = seedCall();
    await expect(assertVoiceCallOwner("user-1", callId)).resolves.toMatchObject({ id: callId });
    await expect(assertVoiceCallOwner("user-2", callId)).rejects.toThrow(/introuvable/i);
  });

  it("listVoiceCalls filtre par utilisateur et par agent (chemin where/orderBy)", async () => {
    const callA = seedCall({ agentId: "agent-1" });
    const callB = seedCall({ userId: "user-2", agentId: "agent-2" });
    // Le mock where() de base lève : on le remplace par un filtre mémoire
    // équivalent au comportement r2fs (where userId == … + orderBy + limit).
    const { adminDb } = await import("@/lib/firebase/admin");
    const collectionMock = vi.mocked(adminDb.collection);
    collectionMock.mockImplementation(((name: string) => {
      let filterUserId = "";
      return {
        doc: (id: string) => makeDocRef(`${name}/${id}`, id),
        where: vi.fn((field: string, _op: string, value: unknown) => {
          if (field === "userId") filterUserId = String(value);
          return {
            orderBy: vi.fn(() => ({
              limit: vi.fn(() => ({
                get: async () => ({
                  docs: [...store.docs.entries()]
                    .filter(([key, data]) => key.startsWith("voiceCalls/") && data.userId === filterUserId)
                    .map(([key, data]) => ({ id: key.slice("voiceCalls/".length), data: () => ({ ...data }) })),
                }),
              })),
            })),
          };
        }),
      };
    }) as never);

    const all = await listVoiceCalls("user-1");
    expect(all.map((r) => r.id)).toContain(callA);
    expect(all.map((r) => r.id)).not.toContain(callB);
    const filtered = await listVoiceCalls("user-1", "agent-1");
    expect(filtered.every((r) => r.agentId === "agent-1")).toBe(true);
  });
});

describe("Fusion des détails post-appel (webhook/polling)", () => {
  it("applyBlandCallDetails met à jour statut/transcripts/enregistrement et facture UNE fois", async () => {
    const callId = seedCall();
    const details = {
      callId,
      status: "completed",
      completed: true,
      queueStatus: "complete",
      answeredBy: "human",
      callEndedBy: "ASSISTANT",
      errorMessage: null,
      to: "+237600000000",
      from: null,
      lengthMinutes: 2.5,
      priceUsd: 0.09,
      summary: "Résumé Bland.",
      concatenatedTranscript: null,
      transcripts: [{ role: "assistant" as const, text: "Bonjour !", at: "" }],
      recordingUrl: "https://rec.example/x.mp3",
      createdAt: null,
      startedAt: null,
      endedAt: null,
      metadata: null,
      variables: null,
      batchId: null,
    };

    const updated = await applyBlandCallDetails(callId, details, { bill: true });
    expect(updated?.status).toBe("completed");
    expect(updated?.recordingUrl).toBe("https://rec.example/x.mp3");
    expect(updated?.history).toEqual([{ role: "assistant", text: "Bonjour !", at: "" }]);
    expect(store.billed).toHaveLength(1);
    expect(store.billed[0]).toMatchObject({ userId: "user-1", kind: "voice_call", quantity: 2.5 });

    // Seconde application (rejeu webhook) : PLUS de facturation.
    await applyBlandCallDetails(callId, details, { bill: true });
    expect(store.billed).toHaveLength(1);
  });

  it("un appel de durée nulle n'est pas facturé", async () => {
    const callId = seedCall();
    await applyBlandCallDetails(callId, {
      callId,
      status: "no-answer",
      completed: true,
      queueStatus: "complete",
      answeredBy: "no-answer",
      callEndedBy: "ASSISTANT",
      errorMessage: null,
      to: "+237600000000",
      from: null,
      lengthMinutes: 0,
      priceUsd: 0,
      summary: null,
      concatenatedTranscript: null,
      transcripts: [],
      recordingUrl: null,
      createdAt: null,
      startedAt: null,
      endedAt: null,
      metadata: null,
      variables: null,
      batchId: null,
    }, { bill: true });
    expect(store.billed).toHaveLength(0);
  });

  it("syncVoiceCallFromBland rafraîchit depuis l'API Bland (échec soft si inconnu)", async () => {
    const callId = seedCall();
    const refreshed = await syncVoiceCallFromBland(callId);
    expect(refreshed?.status).toBe("completed");
    expect(refreshed?.summary).toBe("Résumé Bland.");

    const unknown = await syncVoiceCallFromBland("inexistant");
    expect(unknown).toBeNull();
  });
});

describe("Quota journalier", () => {
  it("réserve un créneau puis refuse au-delà de la limite", async () => {
    // Le mock transaction lit voiceCallDaily/user-1_<jour> — on simule la
    // consommation complète du quota via le doc existant.
    const day = new Date().toISOString().slice(0, 10);
    store.docs.set(`voiceCallDaily/user-1_${day}`, { userId: "user-1", day, count: 20 });
    await expect(reserveDailyVoiceCallSlot("user-1")).rejects.toThrow(/Limite quotidienne/i);
  });
});
