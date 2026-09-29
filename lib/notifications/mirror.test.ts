import { describe, expect, it } from "vitest";

/**
 * Tests des fonctions pures du miroir notifications → Supabase (Task 43, P2).
 *
 * Couverture : dérivation déterministe de l'id Postgres (uuid v5 depuis
 * l'id Firestore), fidélité de la ligne miroir (tronquatures identiques au
 * backend primaire, metadata complète, état de lecture).
 */

import { notificationMirrorId, mirrorRowFromNotification } from "./mirror";
import type { Gen3iaNotification } from "./repository";

const NOTIFICATION: Gen3iaNotification = {
  id: "firestore-doc-abc123",
  userId: "uid-utilisateur-1",
  type: "approval_requested",
  title: "Approbation requise : envoyer un e-mail",
  body: "L'agent souhaite utiliser le tool mailer.",
  read: false,
  kind: "agent_action",
  approvalId: "approval-42",
  conversationId: "conv-1",
  executionId: "exec-1",
  toolSlug: "mailer",
  createdAtMs: 1_700_000_000_000,
};

describe("notificationMirrorId (dérivation uuid v5)", () => {
  it("est déterministe : même id Firestore → même uuid Postgres", () => {
    expect(notificationMirrorId("firestore-doc-abc123")).toBe(notificationMirrorId("firestore-doc-abc123"));
  });

  it("diffère entre ids Firestore distincts", () => {
    expect(notificationMirrorId("a")).not.toBe(notificationMirrorId("b"));
  });

  it("produit un uuid v4-format valide (36 caractères, 5 blocs)", () => {
    const id = notificationMirrorId("firestore-doc-abc123");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("mirrorRowFromNotification (fidélité de la ligne miroir)", () => {
  it("mappe la notification unread complète (id dérivé, metadata riche)", () => {
    const profileId = "11111111-2222-4333-8444-555555555555";
    const row = mirrorRowFromNotification(NOTIFICATION, profileId) as Record<string, unknown> & {
      metadata: Record<string, unknown>;
    };

    expect(row.id).toBe(notificationMirrorId(NOTIFICATION.id));
    expect(row.owner_profile_id).toBe(profileId);
    expect(row.kind).toBe("approval");
    expect(row.title).toBe(NOTIFICATION.title);
    expect(row.body).toBe(NOTIFICATION.body);
    expect(row.read).toBe(false);
    expect(row.read_at).toBeNull();
    expect(row.created_at).toBe(new Date(NOTIFICATION.createdAtMs).toISOString());

    expect(row.metadata.type).toBe("approval_requested");
    expect(row.metadata.kind).toBe("agent_action");
    expect(row.metadata.userId).toBe(NOTIFICATION.userId);
    // L'id Firestore d'origine est conservé pour l'audit/traçabilité.
    expect(row.metadata.firestoreId).toBe(NOTIFICATION.id);
    expect(row.metadata.approvalId).toBe("approval-42");
    expect(row.metadata.conversationId).toBe("conv-1");
    expect(row.metadata.executionId).toBe("exec-1");
    expect(row.metadata.toolSlug).toBe("mailer");
  });

  it("mappe une notification info déjà lue (kind system, read_at posé)", () => {
    const read: Gen3iaNotification = {
      ...NOTIFICATION,
      type: "info",
      kind: undefined,
      approvalId: undefined,
      read: true,
    };
    const row = mirrorRowFromNotification(read, "p") as Record<string, unknown> & {
      metadata: Record<string, unknown>;
    };
    expect(row.kind).toBe("system");
    expect(row.read).toBe(true);
    expect(row.read_at).toBe(new Date(read.createdAtMs).toISOString());
    expect(row.metadata.kind).toBeUndefined();
    expect(row.metadata.approvalId).toBeUndefined();
  });

  it("tronque titre (200) et corps (800) comme le backend primaire", () => {
    const long: Gen3iaNotification = {
      ...NOTIFICATION,
      title: "T".repeat(500),
      body: "B".repeat(2000),
    };
    const row = mirrorRowFromNotification(long, "p");
    expect((row.title as string).length).toBe(200);
    expect((row.body as string).length).toBe(800);
  });
});
