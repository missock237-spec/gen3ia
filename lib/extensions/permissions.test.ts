import { describe, expect, it } from "vitest";

import {
  assertPermissionsGranted,
  isPrivateHost,
  parseExtensionPermission,
} from "./permissions";

describe("moteur de permissions d'extensions", () => {
  it("parse les permissions objets et http.fetch", () => {
    expect(parseExtensionPermission("storage.read")).toEqual({ kind: "storage.read" });
    expect(parseExtensionPermission("http.fetch:api.exemple.com")).toEqual({
      kind: "http.fetch",
      host: "api.exemple.com",
    });
    expect(parseExtensionPermission("n'importe quoi")).toBeNull();
  });

  it("refuse les hosts privés, locaux et IP littérales", () => {
    expect(parseExtensionPermission("http.fetch:localhost")).toBeNull();
    expect(parseExtensionPermission("http.fetch:127.0.0.1")).toBeNull();
    expect(parseExtensionPermission("http.fetch:192.168.1.10")).toBeNull();
    expect(parseExtensionPermission("http.fetch:169.254.169.254")).toBeNull();
    expect(parseExtensionPermission("http.fetch:monserveur.local")).toBeNull();
    expect(parseExtensionPermission("http.fetch:api.exemple.com")).not.toBeNull();
  });

  it("identifie les hosts privés et refuse tout IP littéral", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("172.16.5.4")).toBe(true);
    // Tout IP littéral (même publique) est traité comme privé : les
    // permissions n'autorisent que des noms de domaine publics.
    expect(isPrivateHost("172.32.5.4")).toBe(true);
    expect(isPrivateHost("8.8.8.8")).toBe(true);
    expect(isPrivateHost("api.exemple.com")).toBe(false);
  });

  it("exige chaque permission requise pour l'exécution", () => {
    expect(() =>
      assertPermissionsGranted(["http.fetch:api.exemple.com"], ["http.fetch:api.exemple.com"]),
    ).not.toThrow();

    expect(() =>
      assertPermissionsGranted(["http.fetch:api.exemple.com"], ["http.fetch:api.autre.com"]),
    ).toThrow(/Permission denied/);

    expect(() =>
      assertPermissionsGranted(["storage.read"], ["storage.write"]),
    ).toThrow(/storage\.write/);
  });

  it("couvre les sous-domaines d'un host accordé", () => {
    expect(() =>
      assertPermissionsGranted(["http.fetch:exemple.com"], ["http.fetch:api.exemple.com"]),
    ).not.toThrow();
    expect(() =>
      assertPermissionsGranted(["http.fetch:*.exemple.com"], ["http.fetch:api.exemple.com"]),
    ).not.toThrow();
  });
});
