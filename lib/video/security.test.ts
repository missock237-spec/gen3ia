import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { assertBinaryChecksum, resolveExpectedRuntimeChecksum } from "@/lib/video/security";

// ────────────────────────────────────────────────────────────────────────────
// Task 104-c — garde unitaire de l'intégrité des binaires FFmpeg/ffprobe
// téléchargés au runtime (alertes CodeQL #69/#70 : fail-closed avant écriture).
// ────────────────────────────────────────────────────────────────────────────

const FFMPEG_SHA256 = "ed652b2f32e0851d1946894fb8333f5b677c1b2ce6b9d187910a67f8b99da028";
const FFPROBE_SHA256 = "a339171d90f7482b2db02234e261b9e00d51526391f87fa633d5da7b98a28cf4";

function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("assertBinaryChecksum (intégrité binaire AVANT écriture)", () => {
  it("bon buffer → OK (aucun jet)", () => {
    const buffer = Buffer.from("binaire officiel");
    expect(() => assertBinaryChecksum(buffer, sha256Of("binaire officiel"))).not.toThrow();
  });

  it("checksum attendu en majuscules → accepté (comparaison insensible à la casse)", () => {
    const buffer = Buffer.from("binaire officiel");
    expect(() => assertBinaryChecksum(buffer, sha256Of("binaire officiel").toUpperCase())).not.toThrow();
  });

  it("buffer corrompu (1 octet modifié) → Error FR, exécution refusée", () => {
    const buffer = Buffer.from("binaire officieL"); // dernier octet altéré
    expect(() => assertBinaryChecksum(buffer, sha256Of("binaire officiel"))).toThrowError(
      /Intégrité du binaire compromise/,
    );
  });

  it("format attendu invalide (trop court, non hexadécimal) → Error immédiat", () => {
    const buffer = Buffer.from("x");
    expect(() => assertBinaryChecksum(buffer, "abc123")).toThrowError(/Checksum attendu invalide/);
    expect(() => assertBinaryChecksum(buffer, "z".repeat(64))).toThrowError(/Checksum attendu invalide/);
  });
});

describe("resolveExpectedRuntimeChecksum (matrice fail-closed, pure)", () => {
  it("release épinglée b6.0, aucune surcharge env → SHA256 épinglés du code", () => {
    expect(resolveExpectedRuntimeChecksum("ffmpeg", {})).toBe(FFMPEG_SHA256);
    expect(resolveExpectedRuntimeChecksum("ffprobe", {})).toBe(FFPROBE_SHA256);
  });

  it("checksums épinglés : hexadécimal 64 caractères", () => {
    for (const sha of [resolveExpectedRuntimeChecksum("ffmpeg", {}), resolveExpectedRuntimeChecksum("ffprobe", {})]) {
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("release surchargée par env SANS checksum → fail-closed, nom de la variable requis dans l'erreur", () => {
    expect(() => resolveExpectedRuntimeChecksum("ffmpeg", { VIDEO_STATIC_RELEASE_TAG: "b7.0" })).toThrowError(
      /fail-closed[\s\S]*VIDEO_FFMPEG_SHA256/,
    );
    expect(() =>
      resolveExpectedRuntimeChecksum("ffprobe", { VIDEO_STATIC_BINARIES_URL: "https://miroir.exemple/bins" }),
    ).toThrowError(/fail-closed[\s\S]*VIDEO_FFPROBE_SHA256/);
  });

  it("release surchargée AVEC checksum env → checksum env accepté (normalisé minuscules)", () => {
    const sha = resolveExpectedRuntimeChecksum("ffmpeg", {
      VIDEO_STATIC_RELEASE_TAG: "b7.0",
      VIDEO_FFMPEG_SHA256: FFPROBE_SHA256.toUpperCase(),
    });
    expect(sha).toBe(FFPROBE_SHA256);
  });

  it("release épinglée : un checksum env éventuel est IGNORÉ (valeur épinglée non contournable)", () => {
    const poisoned = "0".repeat(64);
    expect(resolveExpectedRuntimeChecksum("ffmpeg", { VIDEO_FFMPEG_SHA256: poisoned })).toBe(FFMPEG_SHA256);
    expect(resolveExpectedRuntimeChecksum("ffprobe", { VIDEO_FFPROBE_SHA256: poisoned })).toBe(FFPROBE_SHA256);
  });
});

// ── Garde structurelle : ordre source checksum AVANT écriture ──────────────

describe("Garde structurelle — security.ts", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/video/security.ts"), "utf8");

  it("contient les constantes SHA256 épinglées (64 hexadécimaux)", () => {
    const pinned = source.match(/"[0-9a-f]{64}"/g) ?? [];
    expect(pinned.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain(FFMPEG_SHA256);
    expect(source).toContain(FFPROBE_SHA256);
  });

  it("l'appel assertBinaryChecksum précède TOUTE écriture (writeFile) et le renommage", () => {
    const callIdx = source.search(/assertBinaryChecksum\(buffer,\s/);
    const writeIdx = source.indexOf("writeFile");
    const renameIdx = source.indexOf("rename");
    expect(callIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(callIdx);
    expect(renameIdx).toBeGreaterThan(callIdx);
  });

  it("écriture durcie : création exclusive « wx », fichier d'attelage .staging, chmod 0755", () => {
    expect(source).toContain('fs.open(stagingPath, "wx", 0o700)');
    expect(source).toContain(".staging`");
    expect(source).toContain("chmod(0o755)");
  });
});
