import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { HttpError } from "@/lib/security/http-errors";

/**
 * Routes admin genAPI /api/admin/genapi/clients : garde requireAdmin
 * obligatoire (401/403 JSON via errorStatus — jamais de 500 sur une erreur
 * d'auth), GET liste des clients, POST provisionner (succès avec jeton,
 * refus métier → 200 ok:false, validation basique), POST revoquer, action
 * inconnue → 400.
 *
 * Le socle lib/genapi (écrit en parallèle par la mission socle) est MOQUÉ :
 * l'intégration est testée seule, jamais contre le vrai Firestore. Les tests
 * sont actifs dès que les modules socle sont présents (garde d'existence) —
 * la route importe statiquement le socle, donc sans eux l'import de la route
 * échouerait à la résolution (consigne fusion : on ne crée JAMAIS un stub
 * lib/genapi ici, le garde saute la suite avec un message explicite).
 */

const requireAdminMock = vi.fn();
const listerClientsMock = vi.fn();
const provisionnerClientMock = vi.fn();
const revoquerClientMock = vi.fn();

vi.mock("@/lib/security/admin-access", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}));

// Registre clients + statut (lib/genapi/clients.ts — socle 2-a).
vi.mock("@/lib/genapi/clients", () => ({
  listerClients: (...args: unknown[]) => listerClientsMock(...args),
  revoquerClient: (...args: unknown[]) => revoquerClientMock(...args),
}));

// Cycle de provisionnement + journal (lib/genapi/provisionnement.ts — socle 2-a).
vi.mock("@/lib/genapi/provisionnement", () => ({
  provisionnerClient: (...args: unknown[]) => provisionnerClientMock(...args),
}));

/** Modules socle moqués (la route les importe statiquement). */
const SOCLE_CLIENTS = path.resolve(import.meta.dirname, "../../../../../lib/genapi/clients.ts");
const SOCLE_PROVISIONNEMENT = path.resolve(import.meta.dirname, "../../../../../lib/genapi/provisionnement.ts");
const SOCLE_PRESENT = existsSync(SOCLE_CLIENTS) && existsSync(SOCLE_PROVISIONNEMENT);

function getRequest(): NextRequest {
  return new NextRequest("https://gen3ia.local/api/admin/genapi/clients");
}

function postRequest(body?: unknown): NextRequest {
  return new NextRequest("https://gen3ia.local/api/admin/genapi/clients", {
    method: "POST",
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ uid: "admin-1", claims: { admin: true } });
});

describe.skipIf(!SOCLE_PRESENT)(
  "GET /api/admin/genapi/clients — garde admin et liste (socle moqué)",
  () => {
    it("401 sans session (JSON complet, aucune lecture du registre)", async () => {
      const { GET } = await import("./route");
      requireAdminMock.mockRejectedValue(
        new HttpError(401, "Authentification requise : jeton manquant ou session expirée."),
      );
      const response = await GET(getRequest());
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.code).toBe("AUTH_REQUIRED");
      expect(listerClientsMock).not.toHaveBeenCalled();
    });

    it("403 pour un compte non admin", async () => {
      const { GET } = await import("./route");
      requireAdminMock.mockRejectedValue(new HttpError(403, "Administrator access required.", "FORBIDDEN"));
      const response = await GET(getRequest());
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.code).toBe("FORBIDDEN");
      expect(listerClientsMock).not.toHaveBeenCalled();
    });

    it("renvoie le registre des clients", async () => {
      const { GET } = await import("./route");
      listerClientsMock.mockResolvedValue([
        { uid: "u-1", email: "a@exemple.com", empreinte: "ab12…", statut: "actif", creeA: "2026-01-01T00:00:00Z" },
      ]);
      const response = await GET(getRequest());
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.clients).toHaveLength(1);
      expect(body.clients[0].uid).toBe("u-1");
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("panne du socle (Firestore) → 500 propre, code PROVIDER_UNAVAILABLE", async () => {
      const { GET } = await import("./route");
      listerClientsMock.mockRejectedValue(new Error("firestore unavailable"));
      const response = await GET(getRequest());
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.code).toBe("PROVIDER_UNAVAILABLE");
      expect(body.error).toBeTruthy();
    });

    it("erreur générique du socle → 500 propre, code INTERNAL", async () => {
      const { GET } = await import("./route");
      listerClientsMock.mockRejectedValue(new Error("panne du daemon"));
      const response = await GET(getRequest());
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.code).toBe("INTERNAL");
    });
  },
);

describe.skipIf(!SOCLE_PRESENT)(
  "POST /api/admin/genapi/clients — provisionner (socle moqué)",
  () => {
    it("succès → 200 avec le ResultatProvisionnement (jeton + expiration)", async () => {
      const { POST } = await import("./route");
      provisionnerClientMock.mockResolvedValue({
        ok: true,
        empreinte: "ab12…ef90",
        jetonTelechargement: "jeton-1",
        expireA: "2026-01-01T00:15:00Z",
      });
      const response = await POST(postRequest({ action: "provisionner", uid: "u-1", email: "a@exemple.com" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(body.jetonTelechargement).toBe("jeton-1");
      expect(provisionnerClientMock).toHaveBeenCalledWith({ uid: "u-1", email: "a@exemple.com", trigger: "console_admin" });
    });

    it("refus métier → 200 avec ok:false (JAMAIS un 500)", async () => {
      const { POST } = await import("./route");
      provisionnerClientMock.mockResolvedValue({ ok: false, erreur: "CA racine indisponible." });
      const response = await POST(postRequest({ action: "provisionner", uid: "u-1", email: "a@exemple.com" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.erreur).toBe("CA racine indisponible.");
    });

    it("erreur technique du socle → 500 propre", async () => {
      const { POST } = await import("./route");
      provisionnerClientMock.mockRejectedValue(new Error("panne du daemon"));
      const response = await POST(postRequest({ action: "provisionner", uid: "u-1", email: "a@exemple.com" }));
      expect(response.status).toBe(500);
      const body = await response.json();
      expect(body.code).toBe("INTERNAL");
    });

    it("uid manquant → 400 sans appeler le socle", async () => {
      const { POST } = await import("./route");
      const response = await POST(postRequest({ action: "provisionner", email: "a@exemple.com" }));
      expect(response.status).toBe(400);
      expect(provisionnerClientMock).not.toHaveBeenCalled();
    });

    it("email invalide → 400 sans appeler le socle", async () => {
      const { POST } = await import("./route");
      const response = await POST(postRequest({ action: "provisionner", uid: "u-1", email: "pas-un-email" }));
      expect(response.status).toBe(400);
      expect(provisionnerClientMock).not.toHaveBeenCalled();
    });
  },
);

describe.skipIf(!SOCLE_PRESENT)(
  "POST /api/admin/genapi/clients — revoquer (socle moqué)",
  () => {
    it("succès → 200 { ok: true }", async () => {
      const { POST } = await import("./route");
      revoquerClientMock.mockResolvedValue(true);
      const response = await POST(postRequest({ action: "revoquer", uid: "u-1" }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(true);
      expect(revoquerClientMock).toHaveBeenCalledWith("u-1");
    });

    it("uid manquant → 400", async () => {
      const { POST } = await import("./route");
      const response = await POST(postRequest({ action: "revoquer" }));
      expect(response.status).toBe(400);
      expect(revoquerClientMock).not.toHaveBeenCalled();
    });
  },
);

describe.skipIf(!SOCLE_PRESENT)(
  "POST /api/admin/genapi/clients — validations transverses (socle moqué)",
  () => {
    it("action inconnue → 400", async () => {
      const { POST } = await import("./route");
      const response = await POST(postRequest({ action: "soumettre", uid: "u-1" }));
      expect(response.status).toBe(400);
      expect(provisionnerClientMock).not.toHaveBeenCalled();
      expect(revoquerClientMock).not.toHaveBeenCalled();
    });

    it("action absente → 400", async () => {
      const { POST } = await import("./route");
      const response = await POST(postRequest({ uid: "u-1" }));
      expect(response.status).toBe(400);
    });

    it("corps JSON invalide → 400", async () => {
      const { POST } = await import("./route");
      const response = await POST(postRequest());
      expect(response.status).toBe(400);
    });

    it("401 sans session (aucune écriture du registre)", async () => {
      const { POST } = await import("./route");
      requireAdminMock.mockRejectedValue(
        new HttpError(401, "Authentification requise : jeton manquant ou session expirée."),
      );
      const response = await POST(postRequest({ action: "provisionner", uid: "u-1", email: "a@exemple.com" }));
      expect(response.status).toBe(401);
      expect(provisionnerClientMock).not.toHaveBeenCalled();
      expect(revoquerClientMock).not.toHaveBeenCalled();
    });
  },
);
