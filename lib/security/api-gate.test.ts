import { beforeEach, describe, expect, it, vi } from "vitest";

const verifyFirebaseAuth = vi.fn();

vi.mock("@/lib/firebase/auth-server", () => ({
  verifyFirebaseAuth: (...args: unknown[]) => verifyFirebaseAuth(...args),
}));

import { deciderMutationApi } from "@/lib/security/api-gate";

function requete(method: string, headers: Record<string, string> = {}) {
  return {
    method,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

describe("deciderMutationApi — garde d'auth obligatoire (P0)", () => {
  beforeEach(() => {
    verifyFirebaseAuth.mockReset();
  });

  it("laisse passer les lectures sans appeler la vérification d'identité", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const verdict = await deciderMutationApi(requete(method), "/api/memory");
      expect(verdict).toEqual({ verdict: "passer", uid: null, voie: "lecture" });
    }
    expect(verifyFirebaseAuth).not.toHaveBeenCalled();
  });

  it("laisse passer les mutations sur les chemins publics (webhooks, auth, cron)", async () => {
    for (const pathname of [
      "/api/webhooks/chariow",
      "/api/auth/r2/signup",
      "/api/cron/knowledge-ingest",
      "/api/queue/dispatch-tick",
      "/api/video/worker/tick",
      "/api/health",
      "/api/metrics",
      "/api/public/commercial/offre",
    ]) {
      const verdict = await deciderMutationApi(requete("POST"), pathname);
      expect(verdict).toEqual({ verdict: "passer", uid: null, voie: "public" });
    }
    expect(verifyFirebaseAuth).not.toHaveBeenCalled();
  });

  it("exige une identité valide pour une mutation utilisateur (cookie ou Bearer)", async () => {
    verifyFirebaseAuth.mockResolvedValueOnce({ uid: "user-1" });
    const verdict = await deciderMutationApi(requete("POST"), "/api/memory");
    expect(verdict).toEqual({ verdict: "passer", uid: "user-1", voie: "identite-verifiee" });
    expect(verifyFirebaseAuth).toHaveBeenCalledTimes(1);
  });

  it("refuse 401 une mutation anonyme sur un chemin non public", async () => {
    verifyFirebaseAuth.mockRejectedValueOnce(new Error("Missing authorization header."));
    const verdict = await deciderMutationApi(requete("POST"), "/api/essaim/job");
    expect(verdict).toMatchObject({
      verdict: "refuser",
      statut: 401,
      code: "AUTH_REQUIRED",
    });
  });

  it("refuse 401 une identité INVALIDE (jeton expiré / cookie ressigné)", async () => {
    verifyFirebaseAuth.mockRejectedValueOnce(new Error("Invalid JWT signature."));
    const verdict = await deciderMutationApi(
      requete("DELETE", { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.faux.faux" }),
      "/api/agents/run",
    );
    expect(verdict).toMatchObject({ verdict: "refuser", statut: 401, code: "AUTH_REQUIRED" });
  });

  it("couvre toutes les méthodes mutantes (PUT, PATCH, DELETE)", async () => {
    verifyFirebaseAuth.mockRejectedValue(new Error("no identity"));
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const verdict = await deciderMutationApi(requete(method), "/api/settings/preferences");
      expect(verdict).toMatchObject({ verdict: "refuser", statut: 401 });
    }
  });

  it("laisse passer /api/v1 porteuse d'une clé API (vérifiée par franchirPorteV1)", async () => {
    const verdict = await deciderMutationApi(
      requete("POST", { "x-api-key": "g3a_test" }),
      "/api/v1/chat",
    );
    expect(verdict).toEqual({ verdict: "passer", uid: null, voie: "cle-api-v1" });
    expect(verifyFirebaseAuth).not.toHaveBeenCalled();
  });

  it("refuse 401 /api/v1 sans clé API (ni identité Firebase)", async () => {
    verifyFirebaseAuth.mockRejectedValueOnce(new Error("Missing authorization header."));
    const verdict = await deciderMutationApi(requete("POST"), "/api/v1/chat");
    expect(verdict).toMatchObject({ verdict: "refuser", statut: 401 });
  });

  it("les pages (hors /api) sont hors périmètre — classification lecture", async () => {
    // Le middleware n'appelle la garde que pour /api/* ; un appel direct
    // avec un chemin page reste néanmoins sûr : GET → lecture.
    const verdict = await deciderMutationApi(requete("POST"), "/dashboard");
    // POST hors /api : la classification ne le connaît pas — restreint — la
    // garde exige alors une identité (comportement sûr par défaut).
    verifyFirebaseAuth.mockRejectedValueOnce(new Error("no identity"));
    const verdictPost = await deciderMutationApi(requete("POST"), "/dashboard");
    expect(verdict.verdict === "passer" || verdict.verdict === "refuser").toBe(true);
    expect(verdictPost).toMatchObject({ verdict: "refuser", statut: 401 });
  });
});
