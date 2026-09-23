import { describe, expect, it } from "vitest";
import { z } from "zod";

import { badRequest, errorBody, errorStatus, isZodErrorLike, zodValidationError } from "./http-errors";

describe("isZodErrorLike (détection duck-typed)", () => {
  it("reconnaît une vraie ZodError", () => {
    const parsed = z.object({ message: z.string() }).safeParse({ message: 42 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(isZodErrorLike(parsed.error)).toBe(true);
  });

  it("rejette une erreur générique, un objet nu ou une erreur sans issues", () => {
    expect(isZodErrorLike(new Error("classique"))).toBe(false);
    expect(isZodErrorLike({ name: "ZodError", issues: [] })).toBe(false);
    expect(isZodErrorLike(null)).toBe(false);
    expect(isZodErrorLike(undefined)).toBe(false);
  });
});

describe("errorStatus (ZodError -> 422)", () => {
  it("renvoie 422 pour une ZodError (plus de repli 400 avec dump brut)", () => {
    const parsed = z.object({ message: z.string() }).safeParse({ message: 42 });
    if (!parsed.success) expect(errorStatus(parsed.error, 400)).toBe(422);
  });

  it("préserve les statuts existants (HttpError, 401 auth, 503 infra)", () => {
    expect(errorStatus(badRequest("x"))).toBe(400);
    expect(errorStatus(new Error("Missing Authorization header"))).toBe(401);
    expect(errorStatus(new Error("Firestore unavailable"))).toBe(503);
    expect(errorStatus(new Error("boom"), 500)).toBe(500);
  });
});

describe("errorBody (ZodError -> message humain lisible)", () => {
  it("traduit une ZodError en message français identifiant le champ", () => {
    const parsed = z.object({ message: z.string().min(1) }).safeParse({ message: "" });
    if (!parsed.success) {
      const body = errorBody(parsed.error);
      expect(body.code).toBe("INVALID_REQUEST");
      expect(body.error).toContain("message");
      expect(body.error).not.toMatch(/expected|received|invalid_type/);
      expect(body.error).not.toContain("\n");
    }
  });

  it("laisse les erreurs non-Zod inchangées", () => {
    const body = errorBody(new Error("panne fournisseur"), "repli");
    expect(body.error).toBe("panne fournisseur");
  });
});

describe("zodValidationError (contrat existant préservé)", () => {
  it("produit un 422 lisible avec le champ en cause", () => {
    const parsed = z.object({ message: z.string() }).safeParse({ message: 42 });
    if (!parsed.success) {
      const httpError = zodValidationError(parsed.error);
      expect(httpError.status).toBe(422);
      expect(httpError.code).toBe("INVALID_REQUEST");
      expect(httpError.message).toContain("message");
    }
  });
});
