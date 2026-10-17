import { describe, expect, it } from "vitest";

import { validateModelFile } from "./model-files";

/* ------------------------------------------------------------------ */
/* Validation des fichiers modèles — sécurité à l'import (spec §11).   */
/* ------------------------------------------------------------------ */

/** Construit un buffer safetensors plausible : header JSON + tenseurs factices. */
function buildSafetensors(headerEntries = 3, padToMb = 2): Buffer {
  const header: Record<string, unknown> = {
    "model.embed_tokens.weight": { dtype: "F16", shape: [1000, 64], data_offsets: [0, 128000] },
    "lm_head.weight": { dtype: "F16", shape: [64, 1000], data_offsets: [128000, 256000] },
  };
  for (let i = 0; i < Math.max(0, headerEntries - 2); i++) {
    header[`layer.${i}.weight`] = { dtype: "F16", shape: [64, 64], data_offsets: [256000 + i * 8192, 256008 + i * 8192] };
  }
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(headerJson.byteLength));
  const body = Buffer.alloc(Math.max(0, padToMb * 1024 * 1024 - 8 - headerJson.byteLength), 7);
  return Buffer.concat([length, headerJson, body]);
}

describe("validateModelFile — safetensors", () => {
  it("accepte un safetensors dont le header JSON est valide", async () => {
    const report = await validateModelFile("model.safetensors", buildSafetensors(), "text");
    expect(report.status).toBe("valid");
    expect(report.format).toBe("safetensors");
    expect(report.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.findings.some((f) => f.code === "format-verified")).toBe(true);
  });

  it("rejette un safetensors au header déclaré plus grand que le fichier", async () => {
    const buffer = Buffer.alloc(64, 1);
    buffer.writeBigUInt64LE(BigInt(1_000_000_000), 0);
    const report = await validateModelFile("model.safetensors", buffer, "text");
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("bad-safetensors-header");
  });

  it("rejette un safetensors au header JSON illisible", async () => {
    const buffer = Buffer.alloc(256, 1);
    buffer.writeBigUInt64LE(BigInt(100), 0);
    const report = await validateModelFile("model.safetensors", buffer, "text");
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("bad-safetensors-header");
  });

  it("met en quarantaine un safetensors suspectement léger (< 1 Mo)", async () => {
    const small = buildSafetensors(2, 0).subarray(0, 500 * 1024);
    const report = await validateModelFile("adapter.safetensors", small, "text");
    expect(report.status).toBe("quarantined");
    expect(report.findings.some((f) => f.code === "suspiciously-small")).toBe(true);
  });
});

describe("validateModelFile — refus des formats pickle", () => {
  it.each(["model.pt", "weights.pth", "checkpoint.ckpt", "data.pickle", "blob.pkl"])(
    "refuse %s sans stocker quoi que ce soit",
    async (filename) => {
      const report = await validateModelFile(filename, Buffer.alloc(1024, 3), "text");
      expect(report.status).toBe("rejected");
      expect(report.findings[0]?.code).toBe("pickle-format-refused");
    },
  );
});

describe("validateModelFile — GGUF", () => {
  it("accepte un fichier dont le magic est GGUF", async () => {
    const buffer = Buffer.alloc(2 * 1024 * 1024, 0);
    buffer.write("GGUF", 0, "ascii");
    const report = await validateModelFile("model.gguf", buffer, "text");
    expect(report.status).toBe("valid");
    expect(report.format).toBe("gguf");
  });

  it("rejette un .gguf sans magic", async () => {
    const report = await validateModelFile("model.gguf", Buffer.alloc(1024, 9), "text");
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("bad-gguf-magic");
  });
});

describe("validateModelFile — ZIP", () => {
  it("rejette un fichier vide", async () => {
    const report = await validateModelFile("model.zip", Buffer.alloc(0), "text");
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("empty-file");
  });

  it("rejette une extension inconnue", async () => {
    const report = await validateModelFile("model.exe", Buffer.alloc(128), "text");
    expect(report.status).toBe("rejected");
    expect(report.findings[0]?.code).toBe("unsupported-format");
  });

  it("met en quarantaine un .bin non analysable (héritage PyTorch)", async () => {
    const report = await validateModelFile("pytorch_model.bin", Buffer.alloc(2048, 4), "text");
    expect(report.status).toBe("quarantined");
    expect(report.findings[0]?.code).toBe("bin-legacy-format");
  });
});
