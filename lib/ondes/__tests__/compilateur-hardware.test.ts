import { describe, expect, it } from "vitest";

import {
  classerProfil,
  compilerWGSL,
  CacheCompilation,
  SONDE_VIDE,
  sonderMateriel,
  type SondeMateriel,
} from "../compilateur-hardware";
import { SHADER_ONDES } from "../shader";
import { CONFIGS_EFFORT } from "../types";

const SONDE_APPLE: SondeMateriel = {
  disponible: true,
  vendeur: "apple",
  architecture: "gpu-19-core",
  description: "Apple M2 Pro",
  limites: {
    invocationsParWorkgroup: 1024,
    workgroupX: 32,
    workgroupY: 32,
    workgroupZ: 64,
    tailleStockageMax: 134217728,
    memoireWorkgroup: 32768,
  },
  supporteF16: true,
  source: "adapter.info",
};

const SONDE_VULKAN: SondeMateriel = {
  disponible: true,
  vendeur: "nvidia",
  architecture: "ada",
  description: "NVIDIA GeForce RTX 4070 (Vulkan)",
  limites: {
    invocationsParWorkgroup: 1024,
    workgroupX: 1024,
    workgroupY: 1024,
    workgroupZ: 64,
    tailleStockageMax: 134217728,
    memoireWorkgroup: 32768,
  },
  supporteF16: true,
  source: "adapter.info",
};

const SONDE_MODESTE: SondeMateriel = {
  disponible: true,
  vendeur: "intel",
  architecture: "gen-11",
  description: "Intel UHD Graphics (D3D12)",
  limites: {
    invocationsParWorkgroup: 32,
    workgroupX: 32,
    workgroupY: 32,
    workgroupZ: 32,
    tailleStockageMax: 134217728,
    memoireWorkgroup: 16384,
  },
  supporteF16: false,
  source: "requestAdapterInfo",
};

describe("Swarm-Edge Hardware Compiler — sondage", () => {
  it("sonde un adaptateur injecté (adapter.info sync)", async () => {
    const sonde = await sonderMateriel({
      info: { vendor: "apple", architecture: "gpu-19-core", device: "M2 Pro" },
      limits: { maxComputeInvocationsPerWorkgroup: 1024, maxComputeWorkgroupSizeX: 32, maxComputeWorkgroupSizeY: 32 },
      features: new Set(["shader-f16"]),
    });
    expect(sonde.disponible).toBe(true);
    expect(sonde.vendeur).toBe("apple");
    expect(sonde.limites?.invocationsParWorkgroup).toBe(1024);
    expect(sonde.supporteF16).toBe(true);
    expect(sonde.source).toBe("adapter.info");
  });

  it("retombe sur requestAdapterInfo() quand info n'existe pas", async () => {
    const sonde = await sonderMateriel({
      requestAdapterInfo: async () => ({ vendor: "nvidia", architecture: "ada" }),
    });
    expect(sonde.vendeur).toBe("nvidia");
    expect(sonde.source).toBe("requestAdapterInfo");
  });

  it("sonde nulle sans WebGPU (node, navigateur ancien)", async () => {
    const sonde = await sonderMateriel();
    expect(sonde.disponible).toBe(false);
    expect(sonde).toEqual(SONDE_VIDE);
  });
});

describe("Swarm-Edge Hardware Compiler — classification", () => {
  it("reconnaît Apple/Metal et calibre le workgroup 16×8", () => {
    const profil = classerProfil(SONDE_APPLE);
    expect(profil.famille).toBe("apple-metal");
    expect(profil.tier).toBe(1);
    expect(profil.workgroup).toEqual([16, 8]);
    expect(profil.decisions.length).toBeGreaterThan(0);
  });

  it("reconnaît Vulkan sur NVIDIA/AMD/Intel et DirectX 12 quand le driver le dit", () => {
    expect(classerProfil(SONDE_VULKAN).famille).toBe("vulkan");
    const amd = classerProfil({ ...SONDE_VULKAN, vendeur: "amd", description: "Radeon RX 7900" });
    expect(amd.famille).toBe("vulkan");
    // Un driver qui s'annonce D3D12 est classé DirectX 12 — même si le
    // vendeur appartient aussi à la liste Vulkan.
    const directx = classerProfil({ ...SONDE_VULKAN, vendeur: "amd", description: "Radeon RX (D3D12)" });
    expect(directx.famille).toBe("directx12");
  });

  it("réduit le workgroup sur un GPU modeste (tier 3)", () => {
    const profil = classerProfil(SONDE_MODESTE);
    expect(profil.tier).toBe(3);
    expect(profil.workgroup).toEqual([4, 4]);
  });

  it("respecte STRICTEMENT les limites du driver", () => {
    const sondeLimitee: SondeMateriel = {
      ...SONDE_APPLE,
      limites: { ...SONDE_APPLE.limites!, invocationsParWorkgroup: 64, workgroupX: 8, workgroupY: 8 },
    };
    const profil = classerProfil(sondeLimitee);
    expect(profil.workgroup[0] * profil.workgroup[1]).toBeLessThanOrEqual(64);
    expect(profil.workgroup[0]).toBeLessThanOrEqual(8);
    expect(profil.workgroup[1]).toBeLessThanOrEqual(8);
  });

  it("profile un adaptateur non identifié comme Vulkan prudent", () => {
    const profil = classerProfil({ ...SONDE_VULKAN, vendeur: "inconnu", architecture: "inconnu", description: "inconnu" });
    expect(profil.famille).toBe("vulkan");
  });

  it("reste inconnu quand WebGPU est absent (shader standard)", () => {
    const profil = classerProfil(SONDE_VIDE);
    expect(profil.famille).toBe("inconnu");
    expect(profil.decisions.some((d) => d.includes("indisponible"))).toBe(true);
  });
});

describe("Swarm-Edge Hardware Compiler — compilation WGSL", () => {
  it("produit un shader spécialisé : workgroup, constantes fondues, bindings", () => {
    const profil = classerProfil(SONDE_APPLE);
    const shader = compilerWGSL(profil, CONFIGS_EFFORT.eleve);
    expect(shader.famille).toBe("apple-metal");
    expect(shader.code).toContain("@workgroup_size(16, 8)");
    expect(shader.code).toContain("const C2 : f32 = 0.250000");
    expect(shader.code).toContain("const AMORTISSEMENT : f32 = 0.990000");
    expect(shader.code).toContain("const COUPLAGE : f32 = 0.120000");
    expect(shader.code).toContain("const DT : f32 = 0.120000");
    expect(shader.code).toContain("const GAIN : f32 = 0.020000");
    // La physique du miroir CPU est préservée (d'Alembert + Kuramoto).
    expect(shader.code).toContain("2.0 * centre - passe + C2 * (gauche + droite + haut + bas - 4.0 * centre)");
    expect(shader.code).toContain("sin(phase[i - 1u] - ph)");
    expect(shader.code).toContain("fn principal");
    expect(shader.optimisations.length).toBeGreaterThanOrEqual(4);
    expect(shader.empreinte).toMatch(/^[0-9a-f]+$/);
  });

  it("produit des shaders DIFFÉRENTS pour des profils différents", () => {
    const apple = compilerWGSL(classerProfil(SONDE_APPLE), CONFIGS_EFFORT.eleve);
    const modeste = compilerWGSL(classerProfil(SONDE_MODESTE), CONFIGS_EFFORT.eleve);
    expect(apple.code).not.toBe(modeste.code);
    expect(apple.workgroup).not.toEqual(modeste.workgroup);
    expect(apple.empreinte).not.toBe(modeste.empreinte);
  });

  it("rend le shader STANDARD quand WebGPU est indisponible", () => {
    const shader = compilerWGSL(classerProfil(SONDE_VIDE), CONFIGS_EFFORT.faible);
    expect(shader.code).toBe(SHADER_ONDES);
    expect(shader.optimisations).toEqual(["aucune — shader standard"]);
  });

  it("le shader spécialisé reste compatible avec le buffer uniform 48 octets", () => {
    // Le shader spécialisé ne lit que les 4 premiers scalaires (16 octets)
    // du Params standard (48 octets) — la mise en file du moteur reste
    // identique, aucune reconstruction du pipeline par pas.
    const shader = compilerWGSL(classerProfil(SONDE_VULKAN), CONFIGS_EFFORT.moyen);
    expect(shader.code).toContain("struct Params");
    expect(shader.code).toContain("largeur : u32");
    expect(shader.code).not.toContain("c2 : f32,"); // les constantes sont fondues
  });
});

describe("Swarm-Edge Hardware Compiler — cache de session", () => {
  it("une compilation par couple (profil, configuration)", () => {
    const cache = new CacheCompilation();
    const profil = classerProfil(SONDE_APPLE);
    const cle = cache.cle(profil, CONFIGS_EFFORT.faible);
    expect(cache.obtenir(cle)).toBeNull();
    const shader = compilerWGSL(profil, CONFIGS_EFFORT.faible);
    cache.memoriser(cle, shader);
    expect(cache.obtenir(cle)).toBe(shader);
    expect(cache.taille).toBe(1);
    // Un autre effort → une autre clé (nouvelle compilation).
    const cleEleve = cache.cle(profil, CONFIGS_EFFORT.eleve);
    expect(cleEleve).not.toBe(cle);
    expect(cache.obtenir(cleEleve)).toBeNull();
  });
});
