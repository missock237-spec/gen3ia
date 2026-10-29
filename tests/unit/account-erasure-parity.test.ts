import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde-fou — ÉTANCHÉITÉ DU DROIT À L'EFFACEMENT (itération 27, Job 478451).
 *
 * Constat d'audit : DELETE /api/auth/account (RGPD art. 17) purgeait
 * conversations/memories/memory-items (R2) et agents/executions/documents/
 * researchJobs (Firestore) — mais laissaient SURVIVRE à l'effacement :
 *  - R2 : users/{uid}/agents, /privacy/consent, /exports (copies d'export
 *    RGPD !), /runs, /prompt-templates, /training* — 6 namespaces ;
 *  - Firestore : aiFeedback, aiFeedbackLessons, conversationArtifacts,
 *    toolConsents — 4 collections personnelles.
 * Une donnée qui survit à un compte effacé est une violation art. 17.
 *
 * Correctif verrouillé ici :
 * 1. PURGE RACINE R2 `users/{uid}/` — filet d'étanchéité structurel : tout
 *    namespace présent ou FUTUR est couvert sans modifier la route ;
 * 2. Firestore : les 4 collections oubliées sont purgées ;
 * 3. /api/settings/export-data : format renommé `gen3ia.settings-export`
 *    (fin de la collision de format avec `gen3ia.account-export` it.25) et
 *    manifest honnête {count, tronque} — plus de troncature non déclarée.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

/* ------------------------------------------------------------------ */
/* État partagé (hoisté — accessible depuis les factories de mocks)     */
/* ------------------------------------------------------------------ */

const { adminDbCalls, deleteUserFn } = vi.hoisted(() => ({
  adminDbCalls: new Map<string, number>(),
  deleteUserFn: vi.fn(async () => undefined),
}));

/* ------------------------------------------------------------------ */
/* Mocks                                                                */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/security/authenticated-request", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: vi.fn((name: string) => {
      const snap = () => {
        const n = adminDbCalls.get(name) ?? 0;
        adminDbCalls.set(name, n + 1);
        return n === 0
          ? { empty: false, size: 2, docs: [{ ref: "d1" }, { ref: "d2" }] }
          : { empty: true, size: 0, docs: [] };
      };
      const limit = () => ({ get: snap });
      const where = () => ({ limit });
      return { where, batch: () => ({ delete: vi.fn(), commit: async () => undefined }), doc: () => ({ delete: async () => undefined }) };
    }),
    batch: () => ({ delete: vi.fn(), commit: async () => undefined }),
    recursiveDelete: vi.fn(async () => undefined),
  },
}));
vi.mock("@/lib/server/session-cookie", () => ({ clearSessionCookieHeader: () => "session=;" }));
vi.mock("@/lib/security/security-audit", () => ({ appendSecurityAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/identity/service", () => ({ deleteIdentityForAccount: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/storage/user-data-store", () => ({
  removePrefix: vi.fn().mockResolvedValue(0),
  userDir: (uid: string, ...segments: string[]) =>
    `users/${uid}${segments.length ? `/${segments.join("/")}` : ""}`,
  userKey: (uid: string, ...segments: string[]) => `users/${uid}/${segments.join("/")}.json`,
}));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("firebase-admin/auth", () => ({ getAuth: vi.fn(() => ({ deleteUser: deleteUserFn })) }));
vi.mock("firebase-admin/app", () => ({ getApp: vi.fn(() => ({})) }));

import { requireUser } from "@/lib/security/authenticated-request";
import { adminDb } from "@/lib/firebase/admin";
import { removePrefix } from "@/lib/storage/user-data-store";

const mockRequireUser = vi.mocked(requireUser);
const mockRemovePrefix = vi.mocked(removePrefix);
const mockAdminDbCollection = vi.mocked(adminDb.collection);

async function callDelete(): Promise<Response> {
  const { DELETE } = await import("@/app/api/auth/account/route");
  const request = new Request("http://localhost/api/auth/account", { method: "DELETE" });
  return DELETE(request as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  adminDbCalls.clear();
  deleteUserFn.mockClear();
  mockRequireUser.mockResolvedValue({ uid: "u1" } as never);
  mockRemovePrefix.mockResolvedValue(0);
});

describe("DELETE /api/auth/account — étanchéité art. 17", () => {
  it("purge les 4 collections Firestore personnelles oubliées", async () => {
    const res = await callDelete();
    expect(res.status, `réponse: ${await res.clone().text()}`).toBe(200);
    expect(adminDbCalls.has("aiFeedback")).toBe(true);
    expect(adminDbCalls.has("aiFeedbackLessons")).toBe(true);
    expect(adminDbCalls.has("conversationArtifacts")).toBe(true);
    // toolConsents : purgé par deleteWhere (champ userId), comme les autres.
    expect(mockAdminDbCollection).toHaveBeenCalledWith("toolConsents");
    const body = (await res.json()) as { deleted: Record<string, unknown> };
    expect(body.deleted).toHaveProperty("aiFeedback", 2);
    expect(body.deleted).toHaveProperty("aiFeedbackLessons", 2);
    expect(body.deleted).toHaveProperty("artifacts", 2);
    expect(body.deleted).toHaveProperty("toolConsents", 2);
  });

  it("exécute la PURGE RACINE R2 users/{uid}/ en plus des purges nommées", async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    const prefixes = mockRemovePrefix.mock.calls.map((c) => c[0]);
    expect(prefixes).toContain("users/u1/conversations/");
    expect(prefixes).toContain("users/u1/memories/");
    expect(prefixes).toContain("users/u1/memory-items/");
    // Filet d'étanchéité : le préfixe RACINE est purgé — aucun objet
    // personnel (agents, exports, training, prompt-templates, runs,
    // privacy/consent, namespaces futurs) ne peut survivre.
    expect(prefixes).toContain("users/u1/");
  });

  it("expose le compteur de la purge racine dans la réponse", async () => {
    let passes = 0;
    mockRemovePrefix.mockImplementation(async (prefix: string) => {
      if (prefix !== "users/u1/") return 0;
      passes += 1;
      return passes === 1 ? 7 : 0; // 7 objets en 1re passe, puis épuisement
    });
    const res = await callDelete();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: Record<string, unknown> };
    expect(body.deleted).toHaveProperty("r2RacinePurge", 7);
  });

  it("supprime toujours le compte Firebase Auth (parité avec l'ancien comportement)", async () => {
    const res = await callDelete();
    expect(res.status).toBe(200);
    expect(deleteUserFn).toHaveBeenCalledWith("u1");
  });
});

/* ------------------------------------------------------------------ */
/* Garde anti-collision de format + structurels (lecture de source)    */
/* ------------------------------------------------------------------ */

describe("gardes structurels — un seul format par document", () => {
  it("gen3ia.account-export reste réservé à /api/account/export (it.25)", () => {
    const lib = read("lib/privacy/account-export.ts");
    expect(lib).toContain('"gen3ia.account-export"');
  });

  it("settings/export-data déclare gen3ia.settings-export — plus de collision", () => {
    const src = read("app/api/settings/export-data/route.ts");
    expect(src).toContain('"gen3ia.settings-export"');
    expect(src).not.toContain('"gen3ia.account-export"');
  });

  it("settings/export-data expose un manifest honnête {count, tronque} + caps", () => {
    const src = read("app/api/settings/export-data/route.ts");
    expect(src).toContain("manifest:");
    expect(src).toContain("tronque:");
    expect(src).toContain("caps:");
    expect(src).toContain("messagesTronques");
  });

  it("la route d'effacement contient le filet racine (anti-régression)", () => {
    const src = read("app/api/auth/account/route.ts");
    expect(src).toContain("purgerPrefixeRacineUtilisateur");
    expect(src).toContain("${userDir(uid)}/");
    expect(src).toContain('"aiFeedback"');
    expect(src).toContain('"aiFeedbackLessons"');
    expect(src).toContain('"conversationArtifacts"');
    expect(src).toContain('"toolConsents"');
    expect(src).toContain("R2_ROOT_PURGE_MAX_PASSES");
  });
});

/* ------------------------------------------------------------------ */
/* Comportement — route settings/export-data                           */
/* ------------------------------------------------------------------ */

vi.mock("@/lib/security/route-guard", () => ({
  protectRoute: vi.fn(async () => ({ ok: true, context: { userId: "u1", email: "u1@test" } })),
}));
vi.mock("@/lib/security/http-errors", () => ({
  errorBody: (e: unknown, m: string) => ({ error: m, detail: String(e) }),
  errorStatus: () => 500,
}));
vi.mock("@/lib/security/audit-events", () => ({ recordAuditEventSafe: vi.fn() }));
vi.mock("@/lib/identity/r2-identity-store", () => ({ getIdentity: vi.fn(async () => ({ userId: "u1" })) }));
vi.mock("@/lib/chat/repository", () => ({ listConversations: vi.fn(), listMessages: vi.fn() }));
vi.mock("@/lib/domain/artifacts/repository", () => ({ listArtifacts: vi.fn() }));
vi.mock("@/lib/domain/runs/repository", () => ({ listRecentRuns: vi.fn() }));
vi.mock("@/lib/memory/privacy", () => ({ exportUserData: vi.fn() }));
vi.mock("@/lib/storage/r2", () => ({
  putObject: vi.fn(async () => undefined),
  createR2DownloadUrl: vi.fn(async () => "https://r2.test/signed"),
}));

import { protectRoute } from "@/lib/security/route-guard";
import { listConversations, listMessages } from "@/lib/chat/repository";
import { listArtifacts } from "@/lib/domain/artifacts/repository";
import { listRecentRuns } from "@/lib/domain/runs/repository";
import { exportUserData } from "@/lib/memory/privacy";
import { putObject } from "@/lib/storage/r2";

const mockProtectRoute = vi.mocked(protectRoute);
const mockListConversations = vi.mocked(listConversations);
const mockListMessages = vi.mocked(listMessages);
const mockListArtifacts = vi.mocked(listArtifacts);
const mockListRecentRuns = vi.mocked(listRecentRuns);
const mockExportUserData = vi.mocked(exportUserData);
const mockPutObject = vi.mocked(putObject);

async function callExport(): Promise<Response> {
  const { GET } = await import("@/app/api/settings/export-data/route");
  const request = new Request("http://localhost/api/settings/export-data");
  return GET(request as never);
}

function memoire() {
  return {
    format: "gen3ia.memory-export" as const,
    version: 1 as const,
    exportedAt: "2026-10-29T00:00:00.000Z",
    userId: "u1",
    memories: [{ key: "k", value: "v", source: "test" }],
    aiFeedback: [],
    aiFeedbackLessons: [],
    toolConsents: {},
  };
}

describe("GET /api/settings/export-data — manifest honnête, format distinct", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProtectRoute.mockResolvedValue({ ok: true, context: { userId: "u1", email: "u1@test" } } as never);
    mockExportUserData.mockResolvedValue(memoire());
    mockListConversations.mockResolvedValue([] as never);
    mockListMessages.mockResolvedValue([] as never);
    mockListArtifacts.mockResolvedValue([] as never);
    mockListRecentRuns.mockResolvedValue([] as never);
    mockPutObject.mockResolvedValue(undefined);
  });

  it("dépose un document gen3ia.settings-export v1 avec manifest honnête", async () => {
    const res = await callExport();
    expect(res.status, `réponse: ${await res.clone().text()}`).toBe(200);
    expect(mockPutObject).toHaveBeenCalledOnce();
    const doc = JSON.parse((mockPutObject.mock.calls[0][0].body as Buffer).toString("utf8")) as {
      format: string;
      version: number;
      manifest: Record<string, unknown>;
      caps: Record<string, number>;
    };
    expect(doc.format).toBe("gen3ia.settings-export");
    expect(doc.version).toBe(1);
    expect(doc.manifest.profil).toEqual({ count: 1, tronque: false });
    expect(doc.manifest.conversations).toMatchObject({ count: 0, tronque: false, messagesTronques: 0 });
    expect(doc.manifest.memoire).toEqual({ count: 1, tronque: false });
    expect(doc.caps).toEqual({ conversations: 50, messagesParConversation: 200, artefacts: 200, jobs: 50 });
  });

  it("signale la troncature quand les caps sont atteints (jamais de mensonge)", async () => {
    mockListConversations.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({ id: `c${i}` })) as never,
    );
    mockListMessages.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `m${i}` })) as never,
    );
    mockListArtifacts.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => ({ id: `a${i}` })) as never,
    );
    mockListRecentRuns.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ id: `r${i}` })) as never);
    await callExport();
    const doc = JSON.parse((mockPutObject.mock.calls[0][0].body as Buffer).toString("utf8")) as {
      manifest: {
        conversations: { count: number; tronque: boolean; messagesTronques: number };
        artefacts: { tronque: boolean };
        jobs: { tronque: boolean };
      };
    };
    expect(doc.manifest.conversations.tronque).toBe(true);
    expect(doc.manifest.conversations.messagesTronques).toBe(50);
    expect(doc.manifest.artefacts.tronque).toBe(true);
    expect(doc.manifest.jobs.tronque).toBe(true);
  });

  it("une section en panne est count:0 / tronque:true dans le manifest", async () => {
    mockListArtifacts.mockRejectedValue(new Error("R2 indisponible"));
    const res = await callExport();
    expect(res.status).toBe(200);
    const doc = JSON.parse((mockPutObject.mock.calls[0][0].body as Buffer).toString("utf8")) as {
      manifest: { artefacts: { count: number; tronque: boolean } };
      warnings: string[];
    };
    expect(doc.manifest.artefacts).toEqual({ count: 0, tronque: true });
    expect(doc.warnings.join(" ")).toContain("artefacts");
  });
});
