import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { decouvrirUniversellement, SOURCES_DISPONIBLES } from "../discovery/universal-discovery";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";

/**
 * TESTS DISCOVERY (mission §11) — découverte universelle multi-sources :
 * sources simulées (fetch mocké — pas de réseau réel en test), déduplication,
 * fiches normalisées, statut honnête des sources indisponibles.
 */

let dossier: string;

function reponseJson(corp: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => corp } as unknown as Response;
}

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-disc-"));
  reinitialiserRepositoryUce();
});

afterEach(async () => {
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("découverte universelle", () => {
  it("SOURCES_DISPONIBLES couvre plusieurs catégories (mission §2.B)", () => {
    expect(SOURCES_DISPONIBLES.length).toBeGreaterThanOrEqual(5);
    expect(SOURCES_DISPONIBLES).toContain("npm");
    expect(SOURCES_DISPONIBLES).toContain("huggingface");
  });

  it("normalise une découverte npm en fiche complète et crée une capacité « decouverte »", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const cible = String(url);
      if (cible.includes("registry.npmjs.org/-/v1/search")) {
        return reponseJson({
          objects: [{
            package: {
              name: "tiny-lib",
              description: "Une petite bibliothèque réelle.",
              version: "1.0.0",
              links: { repository: "https://github.com/example/tiny-lib" },
              publisher: { name: "example" },
            },
            score: { detail: { popularity: 0.7 } },
          }],
        });
      }
      return reponseJson({}, false);
    }));

    const rapport = await decouvrirUniversellement({
      requete: "petite bibliothèque",
      sources: ["npm"],
      limiteParSource: 2,
      persister: true,
      dossier,
    });
    expect(rapport.fiches.length).toBe(1);
    const fiche = rapport.fiches[0];
    expect(fiche.nom).toBe("tiny-lib");
    expect(fiche.source).toBe("npm");
    expect(fiche.description.length).toBeGreaterThan(0);
    expect(fiche.verifieLe).toBeTruthy();
    expect(rapport.capacitesCreees.length).toBe(1);
  });

  it("déduit les doublons (source+nom+version) au sein d’une même recherche", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponseJson({
      objects: [
        { package: { name: "dup-lib", description: "lib dupliquée", version: "2.0.0" }, score: { detail: { popularity: 0.5 } } },
        { package: { name: "dup-lib", description: "lib dupliquée (répétée)", version: "2.0.0" }, score: { detail: { popularity: 0.5 } } },
      ],
    })));
    const premier = await decouvrirUniversellement({ requete: "dup", sources: ["npm"], limiteParSource: 5, persister: true, dossier });
    expect(premier.fiches.length).toBe(1);
    expect(premier.doublonsIgnores).toBeGreaterThanOrEqual(1);
  });

  it("rapporte honnêtement une source indisponible (pas de fiche inventée)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("réseau coupé"); }));
    const rapport = await decouvrirUniversellement({ requete: "x", sources: ["npm"], persister: false, dossier });
    expect(rapport.fiches.length).toBe(0);
    expect(rapport.sources.npm.statut).not.toBe("ok");
  });
});
