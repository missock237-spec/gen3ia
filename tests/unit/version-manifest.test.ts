import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Manifeste de version — mise à jour forcée navigateur (plan 4 étapes,
 * demande utilisateur 2026-10-23).
 *
 * Le script tourne en CLI réel (npm run build → init avant `next build`,
 * finalize après) : ces tests exécutent le PROCESSUS node dans des
 * répertoires temporaires — c'est le chemin de production exact qui est
 * éprouvé, pas une réimplémentation.
 *
 * Chaîne garantie : init écrit public/version.json (provisoire, fichier
 * TOUJOURS présent) → finalize aligne `version` sur .next/BUILD_ID et
 * copie le manifeste dans .next/version.json (le tar CD ne contient que
 * .next — deploy-vps.yml — c'est par là que le manifeste rejoint le VPS,
 * où cd-finisher.sh le recopie dans public/).
 */

const SCRIPT = path.join(process.cwd(), "scripts", "version-manifest.mjs");
const tempDirs: string[] = [];

function newRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gen3ia-version-"));
  tempDirs.push(dir);
  return dir;
}

function run(root: string, phase: "init" | "finalize"): Record<string, unknown> {
  execFileSync(process.execPath, [SCRIPT, phase], { cwd: root, stdio: "pipe" });
  return JSON.parse(readFileSync(path.join(root, "public", "version.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("scripts/version-manifest.mjs — manifeste de version au build", () => {
  it("init : manifeste provisoire TOUJOURS présent, version unique, phase build", () => {
    const root = newRoot();
    const manifest = run(root, "init");
    expect(manifest.phase).toBe("build");
    expect(typeof manifest.version).toBe("string");
    expect((manifest.version as string).length).toBeGreaterThan(0);
    expect(typeof manifest.buildDate).toBe("string");
    expect(Number.isNaN(Date.parse(manifest.buildDate as string))).toBe(false);
    // Hors dépôt git (répertoire temporaire) : sha null sans exception.
    expect(manifest.gitSha).toBeNull();
    expect(manifest.buildId).toBeNull();
  });

  it("finalize : version ALIGNÉE sur .next/BUILD_ID + embarquement .next/version.json", () => {
    const root = newRoot();
    run(root, "init");
    const buildId = "c_Va4nvUNQWpKD-SMc8nO";
    mkdirSync(path.join(root, ".next"));
    writeFileSync(path.join(root, ".next", "BUILD_ID"), `${buildId}\n`);
    const manifest = run(root, "finalize");
    expect(manifest.phase).toBe("production");
    expect(manifest.version).toBe(buildId);
    expect(manifest.buildId).toBe(buildId);
    // Le manifeste embarqué dans le tar CD est identique à celui servi.
    const shipped = JSON.parse(readFileSync(path.join(root, ".next", "version.json"), "utf8")) as Record<string, unknown>;
    expect(shipped.version).toBe(buildId);
  });

  it("finalize sans BUILD_ID (build interrompu) : provisoire conservé, aucune exception", () => {
    const root = newRoot();
    const provisional = run(root, "init");
    const manifest = run(root, "finalize");
    expect(manifest.phase).toBe("build");
    expect(manifest.version).toBe(provisional.version);
  });

  it("init puis finalize SANS init : finalize crée le manifeste même partant de zéro", () => {
    const root = newRoot();
    const buildId = "bpEOMVm7uLkPDW8TooMfj";
    mkdirSync(path.join(root, ".next"));
    writeFileSync(path.join(root, ".next", "BUILD_ID"), buildId);
    const manifest = run(root, "finalize");
    expect(manifest.version).toBe(buildId);
    expect(existsSync(path.join(root, ".next", "version.json"))).toBe(true);
  });
});
