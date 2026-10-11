import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Journal d'audit des actions critiques (Task 126) — collection
 * `auditEvents` : champs obligatoires, isolation des secrets (redaction),
 * métadonnées sérialisées et tronquées.
 */

const created: Array<Record<string, unknown>> = [];

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: (id: string) => ({
        async create(value: Record<string, unknown>) {
          created.push({ id, ...value });
          return undefined;
        },
      }),
    }),
  },
}));

vi.mock("@/lib/queue/firestore-guard", () => ({
  runFirestoreGuarded: (_label: string, op: () => Promise<unknown>) => op(),
}));

import { recordAuditEvent, recordAuditEventSafe } from "./audit-events";

beforeEach(() => {
  created.length = 0;
});

describe("recordAuditEvent", () => {
  it("écrit un événement complet (qui/quoi/cible/résultat)", async () => {
    const id = await recordAuditEvent({
      actorId: "admin-1",
      actorEmail: "admin@gen3ia.io",
      action: "admin.payout_decision",
      outcome: "granted",
      targetType: "payout",
      targetId: "po_123",
      metadata: { decision: "approve" },
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id,
      actorId: "admin-1",
      actorEmail: "admin@gen3ia.io",
      action: "admin.payout_decision",
      outcome: "granted",
      targetType: "payout",
      targetId: "po_123",
    });
    expect(created[0].metadata).toBe(JSON.stringify({ decision: "approve" }));
  });

  it("rejette les événements sans acteur ni action", async () => {
    await expect(recordAuditEvent({ actorId: " ", action: "x", outcome: "completed" })).rejects.toThrow(/actorId/);
    await expect(recordAuditEvent({ actorId: "u", action: "", outcome: "completed" })).rejects.toThrow(/action/);
  });

  it("sérialise les métadonnées non sérialisables sans lever", async () => {
    // BigInt : JSON.stringify lève — la garde doit rendre "[unserializable]".
    await expect(
      recordAuditEvent({ actorId: "u", action: "a", outcome: "failed", metadata: { montant: 10n } }),
    ).resolves.toBeTypeOf("string");
    expect(created[0].metadata).toBe("[unserializable]");
  });
});

describe("recordAuditEventSafe", () => {
  it("avale les erreurs (best-effort : jamais bloquant pour l'action auditée)", async () => {
    recordAuditEventSafe({ actorId: " ", action: "x", outcome: "granted" });
    // Laisse le rejet interne être avalé par le .catch avant l'assertion.
    await new Promise((resolve) => setImmediate(resolve));
    expect(created).toHaveLength(0);
  });
});
