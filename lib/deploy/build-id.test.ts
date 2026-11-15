import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * LECTURE DU BUILD_ID servi (lib/deploy/build-id.ts) — carburant de
 * /api/deploy-info (rechargement automatique des onglets ouverts).
 *
 * Garanties testées ici avec un VRAI système de fichiers (aucun mock) :
 *  - un .next/BUILD_ID présent et non vide est retourné TRIMÉ ;
 *  - un BUILD_ID vide/espaces ne masque pas la chaîne de repli (null) ;
 *  - une racine sans .next (dev, disque) → null SANS exception : la sonde
 *    /api/deploy-info répond toujours 200 ;
 *  - la lecture suit les remplacements du fichier (swap cd-finisher
 *    simulé : le même appel voit la nouvelle valeur).
 */

describe("readBuildId — empreinte du build effectivement servi", () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "gen3ia-buildid-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("lit et trim le .next/BUILD_ID présent", () => {
    mkdirSync(path.join(root, "next-a", ".next"), { recursive: true });
    writeFileSync(path.join(root, "next-a", ".next", "BUILD_ID"), "  _X5VyoPm2wkmqVd3BpbiX\n", "utf8");
    // Import dynamique : la signature est (cwd) => string | null.
    return import("./build-id").then(({ readBuildId }) => {
      expect(readBuildId(path.join(root, "next-a"))).toBe("_X5VyoPm2wkmqVd3BpbiX");
    });
  });

  it("retourne null sur un BUILD_ID vide ou blanc (ne masque pas le repli)", () => {
    mkdirSync(path.join(root, "next-b", ".next"), { recursive: true });
    writeFileSync(path.join(root, "next-b", ".next", "BUILD_ID"), "   \n", "utf8");
    return import("./build-id").then(({ readBuildId }) => {
      expect(readBuildId(path.join(root, "next-b"))).toBeNull();
    });
  });

  it("retourne null sans lever quand .next/BUILD_ID est absent (dev sans build)", () => {
    return import("./build-id").then(({ readBuildId }) => {
      expect(() => readBuildId(path.join(root, "sans-build"))).not.toThrow();
      expect(readBuildId(path.join(root, "sans-build"))).toBeNull();
    });
  });

  it("suit le remplacement du fichier (swap atomique cd-finisher simulé)", () => {
    mkdirSync(path.join(root, "next-c", ".next"), { recursive: true });
    const file = path.join(root, "next-c", ".next", "BUILD_ID");
    writeFileSync(file, "build-avant", "utf8");
    return import("./build-id").then(({ readBuildId }) => {
      expect(readBuildId(path.join(root, "next-c"))).toBe("build-avant");
      // cd-finisher.sh : mv .next .next.old && cp -al staging/.next .next
      writeFileSync(file, "build-apres-swap", "utf8");
      expect(readBuildId(path.join(root, "next-c"))).toBe("build-apres-swap");
    });
  });

  it("défaut : lit process.cwd() (l'app racine en production) — présence d'une signature injectable", async () => {
    const { readBuildId } = await import("./build-id");
    // Sans argument : la racine du repo de test n'a pas de .next/BUILD_ID
    // construit (ou en a un) — les deux cas sont acceptés, JAMAIS d'exception.
    expect(() => readBuildId()).not.toThrow();
    expect([null, expect.any(String)]).toContainEqual(readBuildId());
  });
});
