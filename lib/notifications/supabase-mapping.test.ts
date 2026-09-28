import { describe, expect, it } from "vitest";

/**
 * Tests des mappages purs du pilote notifications Supabase (Task 40).
 *
 * Les fonctions de mapping sont la surface de compatibilité entre le
 * modèle Firestore (Gen3iaNotification validée zod) et la table Postgres
 * `notifications` : elles garantissent l'équivalence sémantique des deux
 * backends (ADR-006) — le schema de validation est EXACTEMENT le même.
 */

import { notificationToRow, rowToNotification } from "./supabase-repository";

const NOW = 1_759_000_000_000; // ms fixes pour un test déterministe

describe("mapping notifications Firestore ⇄ Postgres", () => {
  it("notification d'approbation : mapping aller complet", () => {
    const row = notificationToRow(
      {
        userId: "uid-123",
        type: "approval_requested",
        title: "Action sensible demandée",
        body: "web.api.write sur exemple.com",
        kind: "agent_action",
        approvalId: "apr_1",
        conversationId: "conv_1",
        executionId: "run_1",
        toolSlug: "web.api.write",
      },
      "profile-uuid-1",
      "notif-uuid-1",
      NOW,
    );

    expect(row).toMatchObject({
      id: "notif-uuid-1",
      owner_profile_id: "profile-uuid-1",
      kind: "approval",
      title: "Action sensible demandée",
      body: "web.api.write sur exemple.com",
      read: false,
    });
    expect(row.created_at).toBe(new Date(NOW).toISOString());
    const meta = row.metadata as Record<string, unknown>;
    expect(meta).toMatchObject({
      type: "approval_requested",
      kind: "agent_action",
      userId: "uid-123",
      approvalId: "apr_1",
      conversationId: "conv_1",
      executionId: "run_1",
      toolSlug: "web.api.write",
    });
  });

  it("notification info : kind par défaut 'system', références absentes omises", () => {
    const row = notificationToRow(
      { userId: "uid-1", type: "info", title: "Info" },
      "profile-uuid-1",
      "notif-uuid-2",
      NOW,
    );
    expect(row.kind).toBe("system");
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.type).toBe("info");
    expect(meta).not.toHaveProperty("approvalId");
  });

  it("aller-retour complet : row → notification → mêmes champs métier", () => {
    const input = {
      userId: "uid-9",
      type: "approval_requested" as const,
      title: "Titre",
      body: "Corps",
      kind: "conversation" as const,
      approvalId: "apr-77",
      conversationId: "conv-77",
      executionId: "run-77",
      toolSlug: "email.send",
    };
    const row = notificationToRow(input, "profile-uuid-1", "notif-uuid-9", NOW);
    const back = rowToNotification({
      id: "notif-uuid-9",
      kind: row.kind as string,
      title: row.title as string,
      body: row.body as string,
      read: false,
      read_at: null,
      metadata: row.metadata as Record<string, unknown>,
      created_at: new Date(NOW).toISOString(),
    });

    expect(back).not.toBeNull();
    expect(back!.userId).toBe("uid-9");
    expect(back!.type).toBe("approval_requested");
    expect(back!.kind).toBe("conversation");
    expect(back!.approvalId).toBe("apr-77");
    expect(back!.conversationId).toBe("conv-77");
    expect(back!.executionId).toBe("run-77");
    expect(back!.toolSlug).toBe("email.send");
    expect(back!.read).toBe(false);
    expect(back!.createdAtMs).toBe(NOW);
  });

  it("ligne corrompue (metadata sans userId/type) → notification dégradée mais VALIDE (jamais de crash de lecture)", () => {
    const back = rowToNotification({
      id: "notif-x",
      kind: "system",
      title: "t",
      body: "",
      read: false,
      read_at: null,
      metadata: null,
      created_at: new Date(NOW).toISOString(),
    });
    expect(back).not.toBeNull();
    expect(back!.type).toBe("info");
    expect(back!.userId).toBe("unknown");
  });

  it("troncature identique au backend Firestore (titre 200, corps 800)", () => {
    const row = notificationToRow(
      {
        userId: "uid-1",
        type: "info",
        title: "a".repeat(500),
        body: "b".repeat(2000),
      },
      "profile-uuid-1",
      "notif-uuid-3",
      NOW,
    );
    expect((row.title as string).length).toBe(200);
    expect((row.body as string).length).toBe(800);
  });
});
