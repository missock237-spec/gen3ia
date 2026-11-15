import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Registre des workspaces persistant (Task 62) : la propriété vit en
 * Firestore — un cold start ou une autre instance ne produit plus
 * « Workspace access denied » pour le propriétaire légitime ; un workspace
 * expiré (24 h) est traité comme inexistant.
 *
 * Mock Firestore minimaliste en mémoire (doc get/set/delete + runTransaction
 * non utilisé ici — le registre n'en a pas besoin : chaque workspace n'est
 * écrit que par son créateur, jamais en concurrence).
 */

const docs = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/r2fs", () => ({
  FieldValue: { delete: () => "__DELETE__", increment: (n: number) => ({ __increment__: n }) },
}));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        path: `${name}/${id}`,
        async get() {
          return { exists: docs.has(`${name}/${id}`), data: () => docs.get(`${name}/${id}`) };
        },
        async set(data: Record<string, unknown>) {
          docs.set(`${name}/${id}`, data);
          return undefined;
        },
        async delete() {
          docs.delete(`${name}/${id}`);
          return undefined;
        },
      }),
    }),
  },
}));

import { WORKSPACE_TTL_MS, assertWorkspaceOwner, getWorkspace, registerWorkspace, removeWorkspace } from "./workspace-registry";
import { workspaceRootFor } from "./workspace";

const OWNER = "user-abc";
const EXECUTION = "exec-xyz";

beforeEach(() => {
  docs.clear();
});

describe("workspace-registry persistant (Task 62)", () => {
  it("register → get : propriété et racine déterministe conservées", async () => {
    await registerWorkspace({ id: "ws123", root: "/tmp/ancienne-valeur" }, OWNER, EXECUTION);
    const record = await getWorkspace("ws123");

    expect(record).not.toBeNull();
    expect(record?.ownerId).toBe(OWNER);
    expect(record?.executionId).toBe(EXECUTION);
    // La racine est dérivée LOCALEMENT (instance-local) — pas celle du créateur.
    expect(record?.root).toBe(workspaceRootFor("ws123"));
  });

  it("workspace inconnu → null (jamais d'exception)", async () => {
    expect(await getWorkspace("inconnu")).toBeNull();
  });

  it("assertWorkspaceOwner : propriétaire légitime OK après un « redémarrage » (docs conservés)", async () => {
    await registerWorkspace({ id: "wsOK", root: "/tmp/x" }, OWNER, EXECUTION);
    // Simulation : le process redémarre (la Map est vide, Firestore reste).
    const record = await assertWorkspaceOwner("wsOK", OWNER);
    expect(record.id).toBe("wsOK");
  });

  it("assertWorkspaceOwner : autre utilisateur → refus (anti-énumération)", async () => {
    await registerWorkspace({ id: "wsDENY", root: "/tmp/x" }, OWNER, EXECUTION);
    await expect(assertWorkspaceOwner("wsDENY", "user-inconnu")).rejects.toThrow("Workspace access denied");
    await expect(assertWorkspaceOwner("inconnu", OWNER)).rejects.toThrow("Workspace access denied");
  });

  it("workspace expiré (TTL 24 h) → traité comme inexistant", async () => {
    await registerWorkspace({ id: "wsOLD", root: "/tmp/x" }, OWNER, EXECUTION);
    // Écrit directement un expiry dépassé.
    docs.set("executionWorkspaces/wsOLD", {
      id: "wsOLD", ownerId: OWNER, executionId: EXECUTION,
      createdAtMs: Date.now() - WORKSPACE_TTL_MS - 1_000,
      expiresAtMs: Date.now() - 1_000,
    });

    expect(await getWorkspace("wsOLD")).toBeNull();
    expect(docs.has("executionWorkspaces/wsOLD")).toBe(false); // purgé
  });

  it("removeWorkspace supprime l'enregistrement", async () => {
    await registerWorkspace({ id: "wsRM", root: "/tmp/x" }, OWNER, EXECUTION);
    await removeWorkspace("wsRM");
    expect(await getWorkspace("wsRM")).toBeNull();
  });
});
