import { constants as fsConstants } from "node:fs";
import { mkdir, readFile as rawReadFile, symlink, writeFile as rawWriteFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFileCapsule } from "./file-capsule";

let root = "";
const MAX_BYTES = 2_000_000;

beforeEach(async () => {
  root = join(tmpdir(), `gen3ia-capsule-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  // Racine de test volontairement détendue pour le nettoyage des fixtures chmod.
  await chmod(root, 0o700).catch(() => undefined);
});

describe("createFileCapsule — lecture (descripteur vérifié, zéro TOCTOU)", () => {
  it("lit un fichier présent dans la racine autorisée", async () => {
    await rawWriteFile(join(root, "note.txt"), "contenu gen3ia", "utf8");
    const capsule = createFileCapsule(root, MAX_BYTES);
    await expect(capsule.read("note.txt")).resolves.toBe("contenu gen3ia");
  });

  it("lit via un sous-dossier de la racine", async () => {
    await mkdir(join(root, "sub"));
    await rawWriteFile(join(root, "sub", "data.txt"), "ok", "utf8");
    const capsule = createFileCapsule(root, MAX_BYTES);
    await expect(capsule.read("sub/data.txt")).resolves.toBe("ok");
  });

  it("refuse la traversée « .. » et les chemins absolus", async () => {
    const capsule = createFileCapsule(root, MAX_BYTES);
    // Un segment « .. » est refusé par la garde précoce (comportement de
    // l'ancien safeFilePath, conservé) ; un absolu tombe sous la jail.
    await expect(capsule.read("../secret.txt")).rejects.toThrow("Unsafe live file path");
    await expect(capsule.read("sub/../../secret.txt")).rejects.toThrow("Unsafe live file path");
    await expect(capsule.read("/etc/passwd")).rejects.toThrow("escapes the authorized root");
  });

  it("refuse les séparateurs Windows, l'octet nul et les chemins vides", async () => {
    const capsule = createFileCapsule(root, MAX_BYTES);
    await expect(capsule.read("a\\b.txt")).rejects.toThrow("Unsafe live file path");
    await expect(capsule.read("a\0b")).rejects.toThrow("Unsafe live file path");
    await expect(capsule.read("")).rejects.toThrow("Unsafe live file path");
  });

  it("refuse un symlink posé sur le composant final (O_NOFOLLOW → ELOOP)", async () => {
    const outside = join(tmpdir(), `gen3ia-outside-${Date.now()}.txt`);
    await rawWriteFile(outside, "SECRET-HORS-JAIL", "utf8");
    const link = join(root, "link.txt");
    await symlink(outside, link);
    const capsule = createFileCapsule(root, MAX_BYTES);
    // L'ancien chemin (stat → readFile) suivait le symlink : la donnée hors
    // jail était lisible. O_NOFOLLOW le refuse désormais.
    await expect(capsule.read("link.txt")).rejects.toThrow();
  });

  it("refuse un fichier trop volumineux (plafond du capsule)", async () => {
    await rawWriteFile(join(root, "big.txt"), "x".repeat(1_000), "utf8");
    const capsule = createFileCapsule(root, 500);
    await expect(capsule.read("big.txt")).rejects.toThrow("exceeds the size limit");
  });

  it("refuse un fichier manquant", async () => {
    const capsule = createFileCapsule(root, MAX_BYTES);
    await expect(capsule.read("absent.txt")).rejects.toThrow();
  });

  it("refuse un répertoire (isFile attendu)", async () => {
    await mkdir(join(root, "dossier"));
    const capsule = createFileCapsule(root, MAX_BYTES);
    await expect(capsule.read("dossier")).rejects.toThrow();
  });
});

describe("createFileCapsule — écriture (écrasement sûr, symlink refusé)", () => {
  it("crée puis écrase un fichier de la racine (sémantique « w » conservée)", async () => {
    const capsule = createFileCapsule(root, MAX_BYTES);
    await expect(capsule.write("out.txt", "v1")).resolves.toBe(2);
    await expect(rawReadFile(join(root, "out.txt"), "utf8")).resolves.toBe("v1");
    await expect(capsule.write("out.txt", "v2-longue")).resolves.toBe(9);
    await expect(rawReadFile(join(root, "out.txt"), "utf8")).resolves.toBe("v2-longue");
  });

  it("crée les modes 0600 (plus strict que l'ancien défaut)", async () => {
    const capsule = createFileCapsule(root, MAX_BYTES);
    await capsule.write("secret.txt", "sensible");
    const mode = (await stat(join(root, "secret.txt"))).mode & fsConstants.S_IRWXU;
    expect(mode).toBeGreaterThan(0);
    expect((await stat(join(root, "secret.txt"))).mode & 0o077).toBe(0);
  });

  it("refuse d'écrire À TRAVERS un symlink final (O_NOFOLLOW)", async () => {
    const outside = join(tmpdir(), `gen3ia-outside-w-${Date.now()}.txt`);
    await rawWriteFile(outside, "original", "utf8");
    await symlink(outside, join(root, "wl.txt"));
    const capsule = createFileCapsule(root, MAX_BYTES);
    await expect(capsule.write("wl.txt", "PIVOTÉ")).rejects.toThrow();
    await expect(rawReadFile(outside, "utf8")).resolves.toBe("original");
  });

  it("refuse la traversée « .. » et un contenu dépassant le plafond", async () => {
    const capsule = createFileCapsule(root, 10);
    await expect(capsule.write("../x.txt", "data")).rejects.toThrow("Unsafe live file path");
    await expect(capsule.write("x.txt", "x".repeat(11))).rejects.toThrow("exceeds the size limit");
  });
});
