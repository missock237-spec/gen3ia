import { beforeEach, describe, expect, it, vi } from "vitest";

// Le module admin Firestore est lourd (certificats, reseau) : on isole les
// dependances externes pour tester le contrat HTTP de la route.
vi.mock("@/lib/auth/firebase", () => ({
  verifyFirebaseRequest: vi.fn(),
}));

vi.mock("@/lib/security/emergency-stop", () => ({
  activateEmergencyStop: vi.fn(),
  clearEmergencyStop: vi.fn(),
}));

vi.mock("@/lib/security/security-audit", () => ({
  appendSecurityAuditEvent: vi.fn(),
}));

import { verifyFirebaseRequest } from "@/lib/auth/firebase";
import { activateEmergencyStop, clearEmergencyStop } from "@/lib/security/emergency-stop";
import { appendSecurityAuditEvent } from "@/lib/security/security-audit";
import { DELETE, POST } from "./route";

const mockedVerify = vi.mocked(verifyFirebaseRequest);
const mockedActivate = vi.mocked(activateEmergencyStop);
const mockedClear = vi.mocked(clearEmergencyStop);
const mockedAudit = vi.mocked(appendSecurityAuditEvent);

function postRequest(body: unknown): Request {
  return new Request("https://gen3ia.local/api/security/emergency-stop", {
    method: "POST",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(body: unknown): Request {
  return new Request("https://gen3ia.local/api/security/emergency-stop", {
    method: "DELETE",
    headers: { authorization: "Bearer test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedVerify.mockResolvedValue({ uid: "owner-1", email: "owner@test.io" } as never);
  mockedActivate.mockResolvedValue(undefined as never);
  mockedClear.mockResolvedValue(undefined as never);
  mockedAudit.mockResolvedValue("audit-1");
});

describe("POST /api/security/emergency-stop", () => {
  it("active l'arret d'urgence et journalise l'evenement critique", async () => {
    const response = await POST(postRequest({ scope: "user", reason: "comportement inattendu" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, stopped: true, scope: "user" });
    expect(mockedActivate).toHaveBeenCalledOnce();
    expect(mockedAudit).toHaveBeenCalledOnce();
    const audit = mockedAudit.mock.calls[0][0];
    expect(audit.userId).toBe("owner-1");
    expect(audit.toolName).toBe("security.emergency_stop");
    expect(audit.event).toBe("stopped");
    expect(audit.metadata?.scope).toBe("user");
  });

  it("rejette un scope invalide avec 400", async () => {
    const response = await POST(postRequest({ scope: "partout" }));
    expect(response.status).toBe(400);
    expect(mockedActivate).not.toHaveBeenCalled();
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("refuse une requete non authentifiee avec 401", async () => {
    mockedVerify.mockRejectedValue(new Error("authorization header missing"));
    const response = await POST(postRequest({ scope: "user" }));
    expect(response.status).toBe(401);
    expect(mockedAudit).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/security/emergency-stop", () => {
  it("leve l'arret d'urgence sans erreur", async () => {
    const response = await DELETE(deleteRequest({ scope: "execution", executionId: "exec-9" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, stopped: false, scope: "execution" });
    expect(mockedClear).toHaveBeenCalledOnce();
  });
});
