import { describe, expect, it } from "vitest";

import { webApiTool, webApiWriteTool } from "@/lib/tools/web/api";

/**
 * Outil web.api — appel d'API publique par URL. Les tests vérifient la
 * validation d'entrée et la garde SSRF (aucun réseau réel vers des hôtes
 * internes) ; l'appel réel distant est vérifié en production (e2e).
 */

describe("web.api — validation d'entrée", () => {
  it("rejette une URL invalide", () => {
    expect(webApiTool.inputSchema.safeParse({ url: "pas-une-url" }).success).toBe(false);
  });

  it("accepte une URL publique simple", () => {
    const parsed = webApiTool.inputSchema.safeParse({ url: "https://jsonplaceholder.typicode.com/users/1" });
    expect(parsed.success).toBe(true);
  });

  it("limite les en-têtes et paramètres", () => {
    const headers = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`h${i}`, "v"]));
    expect(webApiTool.inputSchema.safeParse({ url: "https://api.exemple.com", headers }).success).toBe(false);
  });
});

describe("web.api.write — validation d'entrée", () => {
  it("exige une méthode d'écriture explicite", () => {
    expect(webApiWriteTool.inputSchema.safeParse({ url: "https://api.exemple.com" }).success).toBe(false);
    expect(
      webApiWriteTool.inputSchema.safeParse({ url: "https://api.exemple.com", method: "POST", body: { a: 1 } }).success,
    ).toBe(true);
  });

  it("rejette GET (lecture = outil web.api)", () => {
    expect(webApiWriteTool.inputSchema.safeParse({ url: "https://api.exemple.com", method: "GET" }).success).toBe(false);
  });
});

describe("web.api — garde SSRF (aucun appel vers un hôte interne)", () => {
  it("bloque localhost avant tout fetch", async () => {
    await expect(
      webApiTool.execute({ url: "http://localhost:4000/secret" }, { userId: "test-user" }),
    ).rejects.toThrow(/non autorisée|Invalid/i);
  });

  it("bloque les adresses IP privées/métadonnées", async () => {
    await expect(
      webApiTool.execute({ url: "http://169.254.169.254/latest/meta-data" }, { userId: "test-user" }),
    ).rejects.toThrow(/non autorisée|private/i);
  });
});
