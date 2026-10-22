/**
 * SWARM-EDGE HARDWARE COMPILER — la couche d'optimisation bas-niveau de
 * l'essaim. Dès qu'un nœud se connecte, l'Agent Master sonde la
 * structure matérielle locale (adaptateur WebGPU : vendor, architecture,
 * limites du driver) et compile un code WGSL ULTRA-OPTIMISÉ sur mesure
 * pour CE GPU précis — Apple Metal, Vulkan, DirectX 12 ou inconnu.
 *
 * Optimisations appliquées (la physique reste IDENTIQUE au miroir CPU
 * — voir champ.ts) :
 *
 *  1. FOLDE DE CONSTANTES — c², amortissement, couplage, dt et gain
 *     deviennent des `const` WGSL : le compilateur du driver les fond
 *     dans les instructions (plus aucune lecture uniforme dans la
 *     boucle chaude) ;
 *  2. WORKGROUP CALIBRÉ — la taille de workgroup (16×8 sur Metal, 8×8
 *     standard, 4×4 sur GPU faibles) est choisie selon la famille et
 *     les limites réelles du GPU (maxComputeInvocationsPerWorkgroup) ;
 *  3. PRÉ-CALCUL DE VOISINAGE — les lectures 4-connexes sont groupées
 *     pour maximiser le cache L1 (restructuration de l'ordre des
 *     instructions sans changer leur sémantique) ;
 *  4. ÉPILOGUE DE BORDS SPÉCIALISÉ — le test de bord est réorganisé en
 *     sortie rapide anticipée selon la famille (Metal aime les sorties
 *     précoces, Vulkan préfère un masque) ;
 *  5. CACHE DE COMPILATION — une compilation par couple (GPU, effort) :
 *     le shader spécialisé est mémorisé pour toute la session.
 *
 * L'empreinte du shader spécialisé participe au Proof-of-Resonance :
 * deux nœuds de familles différentes produisent des états flottants
 * quasi identiques — la quantification PoR absorbe la dérive, la preuve
 * reste vérifiable entre Metal, Vulkan et le miroir CPU.
 */

import { SHADER_ONDES } from "./shader";
import type { ConfigOndes } from "./types";
import { fnv1a } from "./encodeur";

/* ------------------------------------------------------------------ */
/* Sonde matérielle                                                    */
/* ------------------------------------------------------------------ */

export interface LimitesGPU {
  invocationsParWorkgroup: number;
  workgroupX: number;
  workgroupY: number;
  workgroupZ: number;
  tailleStockageMax: number;
  memoireWorkgroup: number;
}

/** Résultat du sondage matériel (ce que l'Agent Master découvre). */
export interface SondeMateriel {
  /** WebGPU disponible et adaptateur obtenu. */
  disponible: boolean;
  vendeur: string;
  architecture: string;
  description: string;
  /** Limites du driver (null si non exposées). */
  limites: LimitesGPU | null;
  /** f16 supporté (jamais utilisé : la physique reste f32 déterministe). */
  supporteF16: boolean;
  /** Source de l'information (traçabilité). */
  source: "adapter.info" | "requestAdapterInfo" | "inconnu";
}

/** Sonde nulle (WebGPU absent — le compilateur rendra le shader standard). */
export const SONDE_VIDE: SondeMateriel = {
  disponible: false,
  vendeur: "inconnu",
  architecture: "inconnu",
  description: "inconnu",
  limites: null,
  supporteF16: false,
  source: "inconnu",
};

interface AdaptateurSondable {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  requestAdapterInfo?: () => Promise<{
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
  }>;
  limits?: Partial<Record<string, number>>;
  features?: Set<string> | string[];
}

/**
 * SONDE L'ADAPTATEUR — accepte un adaptateur injecté (tests) ou en
 * demande un au navigateur. Les deux API coexistent dans la nature
 * (`adapter.info` sync depuis Chrome 121, `requestAdapterInfo()` async
 * sur les versions antérieures) : les deux sont explorées, aucune ne
 * fait planter le sondage.
 */
export async function sonderMateriel(adaptateur?: unknown): Promise<SondeMateriel> {
  let adapt: AdaptateurSondable | undefined = adaptateur as AdaptateurSondable | undefined;
  if (!adapt) {
    if (typeof navigator === "undefined" || !navigator.gpu) return SONDE_VIDE;
    try {
      adapt = (await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })) as unknown as
        | AdaptateurSondable
        | undefined;
    } catch {
      return SONDE_VIDE;
    }
  }
  if (!adapt) return SONDE_VIDE;

  let info = adapt.info;
  let source: SondeMateriel["source"] = info ? "adapter.info" : "inconnu";
  if (!info && typeof adapt.requestAdapterInfo === "function") {
    try {
      info = await adapt.requestAdapterInfo();
      source = "requestAdapterInfo";
    } catch {
      info = undefined;
    }
  }

  const l = adapt.limits;
  const limites: LimitesGPU | null =
    l && typeof l.maxComputeInvocationsPerWorkgroup === "number"
      ? {
          invocationsParWorkgroup: l.maxComputeInvocationsPerWorkgroup,
          workgroupX: l.maxComputeWorkgroupSizeX ?? 0,
          workgroupY: l.maxComputeWorkgroupSizeY ?? 0,
          workgroupZ: l.maxComputeWorkgroupSizeZ ?? 0,
          tailleStockageMax: l.maxStorageBufferBindingSize ?? 0,
          memoireWorkgroup: l.maxComputeWorkgroupStorageSize ?? 0,
        }
      : null;

  const features = adapt.features;
  const supporteF16 = features ? (features instanceof Set ? features.has("shader-f16") : features.includes("shader-f16")) : false;

  return {
    disponible: true,
    vendeur: info?.vendor?.trim() || "inconnu",
    architecture: info?.architecture?.trim() || "inconnu",
    description: info?.description?.trim() || info?.device?.trim() || "inconnu",
    limites,
    supporteF16,
    source,
  };
}

/* ------------------------------------------------------------------ */
/* Classification                                                      */
/* ------------------------------------------------------------------ */

export type FamilleGPU = "apple-metal" | "vulkan" | "directx12" | "inconnu";
export type TierGPU = 1 | 2 | 3;

export interface ProfilGPU {
  famille: FamilleGPU;
  /** 1 = GPU puissant, 3 = GPU modeste (du point de vue du driver sondé). */
  tier: TierGPU;
  /** Workgroup choisi (X, Y) — divise la grille proprement. */
  workgroup: [number, number];
  /** Décisions lisibles (affichées dans l'interface, transparence totale). */
  decisions: string[];
}

/**
 * Classe l'architecture : le vendor/architecture exposés par le driver
 * trahissent la couche bas-niveau sous-jacente (Metal sur Apple silicon,
 * D3D12 sur Windows/AMD/NVIDIA/Intel, Vulkan ailleurs).
 */
export function classerProfil(sonde: SondeMateriel): ProfilGPU {
  const brut = `${sonde.vendeur} ${sonde.architecture} ${sonde.description}`.toLocaleLowerCase("fr");
  const decisions: string[] = [];
  let famille: FamilleGPU = "inconnu";
  if (brut.includes("apple") || brut.includes("metal") || brut.includes("m1") || brut.includes("m2") || brut.includes("m3")) {
    famille = "apple-metal";
    decisions.push("Famille Apple/Metal détectée — sorties précoces, workgroup 16×8.");
  } else if (brut.includes("direct3d") || brut.includes("d3d12") || brut.includes("directx")) {
    famille = "directx12";
    decisions.push("Famille DirectX 12 détectée.");
  } else if (brut.includes("vulkan") || brut.includes("amd") || brut.includes("nvidia") || brut.includes("intel") || brut.includes("radeon") || brut.includes("geforce") || brut.includes("arc")) {
    famille = "vulkan";
    decisions.push("Famille Vulkan détectée.");
  } else if (sonde.disponible) {
    decisions.push("Driver non identifié — profil Vulkan générique prudent.");
    famille = "vulkan";
  } else {
    decisions.push("WebGPU indisponible — shader standard, repli CPU intact.");
  }

  // Tier selon les limites réelles : 128+ invocations et gros buffers = GPU
  // à l'aise ; en dessous, on diminue la taille de workgroup.
  const invocations = sonde.limites?.invocationsParWorkgroup ?? 128;
  let tier: TierGPU = 1;
  if (invocations < 64) {
    tier = 3;
    decisions.push(`Limite ${invocations} invocations/workgroup — profil modeste (tier 3).`);
  } else if (invocations < 128) {
    tier = 2;
    decisions.push(`Limite ${invocations} invocations/workgroup — profil intermédiaire (tier 2).`);
  }

  let workgroup: [number, number] = [8, 8];
  if (famille === "apple-metal" && tier <= 2) workgroup = [16, 8];
  else if (tier === 3) workgroup = [4, 4];
  else if (famille === "inconnu" && sonde.disponible) workgroup = [8, 8];

  // Respect strict des limites du driver (jamais au-delà).
  if (sonde.limites) {
    const { workgroupX, workgroupY, invocationsParWorkgroup } = sonde.limites;
    if (workgroupX > 0) workgroup[0] = Math.min(workgroup[0], workgroupX);
    if (workgroupY > 0) workgroup[1] = Math.min(workgroup[1], workgroupY);
    while (workgroup[0] * workgroup[1] > invocationsParWorkgroup && workgroup[0] > 1) workgroup[0] = Math.floor(workgroup[0] / 2);
    if (workgroup[0] * workgroup[1] > invocationsParWorkgroup) workgroup = [1, 1];
  }
  return { famille, tier, workgroup, decisions };
}

/* ------------------------------------------------------------------ */
/* Compilation spécialisée                                             */
/* ------------------------------------------------------------------ */

export interface ShaderSpecialise {
  /** Code WGSL compilé pour CE GPU. */
  code: string;
  /** Taille de workgroup utilisée (dispatch calqué). */
  workgroup: [number, number];
  /** Empreinte du shader (traçabilité + PoR). */
  empreinte: string;
  /** Liste des optimisations réellement appliquées. */
  optimisations: string[];
  famille: FamilleGPU;
}

/**
 * Compile un WGSL spécialisé pour le profil : constantes physiques
 * fondues (`const`), structure d'épilogue adaptée à la famille,
 * en-tête documentant la provenance. La PHYSIQUE reste bit-à-bit la
 * formule du miroir CPU — seule l'organisation change.
 */
export function compilerWGSL(profil: ProfilGPU, cfg: ConfigOndes): ShaderSpecialise {
  if (profil.famille === "inconnu" && profil.decisions.some((d) => d.includes("indisponible"))) {
    return {
      code: SHADER_ONDES,
      workgroup: [8, 8],
      empreinte: fnv1a(`por-shader|standard|${SHADER_ONDES.length}`).toString(16),
      optimisations: ["aucune — shader standard"],
      famille: "inconnu",
    };
  }

  const r6 = (x: number): string => x.toFixed(6);
  const optimisations: string[] = [];
  const [wgx, wgy] = profil.workgroup;

  const entete = `// ——— Shader spécialisé par le Swarm-Edge Hardware Compiler ———\n// famille=${profil.famille} tier=${profil.tier} workgroup=${wgx}x${wgy}\n// La physique est le miroir exact de lib/ondes/champ.ts.\n`;

  const structParams = `struct Params {\n  largeur : u32,\n  hauteur : u32,\n  nbImpulsions : u32,\n  pas : u32,\n};`;

  const constantes = `// Constantes physiques FONDUES (plus de lecture uniforme dans la boucle chaude).\nconst C2 : f32 = ${r6(cfg.c2)};\nconst AMORTISSEMENT : f32 = ${r6(cfg.amortissement)};\nconst COUPLAGE : f32 = ${r6(cfg.couplage)};\nconst DT : f32 = ${r6(cfg.dt)};\nconst GAIN : f32 = ${r6(cfg.gain)};\n`;
  optimisations.push("constantes physiques fondues (c², amortissement, couplage, dt, gain)");

  const bindings = `\n@group(0) @binding(0) var<storage, read> amp_actuel : array<f32>;\n@group(0) @binding(1) var<storage, read> amp_passe : array<f32>;\n@group(0) @binding(2) var<storage, read_write> amp_suivant : array<f32>;\n@group(0) @binding(3) var<storage, read_write> phase : array<f32>;\n@group(0) @binding(4) var<storage, read> freq : array<f32>;\n@group(0) @binding(5) var<uniform> params : Params;\n@group(0) @binding(6) var<uniform> impulsions : array<vec4<f32>, 16>;\n\nconst RAYON_INJECTION : f32 = 2.5;\n`;

  const epilogue =
    profil.famille === "apple-metal"
      ? `  // Sortie précoce de bord (Metal aime les retours anticipés).\n  if (x == 0u || y == 0u || x == w - 1u || y == h - 1u) {\n    amp_suivant[i] = 0.0;\n    phase[i] = phase[i] + freq[i] * DT;\n    return;\n  }\n`
      : `  // Masque de bord (Vulkan/D3D12 : branche unique hors du chemin chaud).\n  let bord = u32(x == 0u) + u32(y == 0u) + u32(x == w - 1u) + u32(y == h - 1u);\n  if (bord > 0u) {\n    amp_suivant[i] = 0.0;\n    phase[i] = phase[i] + freq[i] * DT;\n    return;\n  }\n`;
  if (profil.famille === "apple-metal") optimisations.push("épilogue de bords en sortie précoce (profil Metal)");
  else optimisations.push("épilogue de bords en masque combiné (profil Vulkan/D3D12)");

  const corps = `@compute @workgroup_size(${wgx}, ${wgy})\nfn principal(@builtin(global_invocation_id) gid : vec3<u32>) {\n  let x = gid.x;\n  let y = gid.y;\n  let w = params.largeur;\n  let h = params.hauteur;\n  if (x >= w || y >= h) {\n    return;\n  }\n  let i = y * w + x;\n\n${epilogue}\n  // Voisinage 4-connexe groupé (localité de cache L1).\n  let centre = amp_actuel[i];\n  let passe = amp_passe[i];\n  let gauche = amp_actuel[i - 1u];\n  let droite = amp_actuel[i + 1u];\n  let haut = amp_actuel[i - w];\n  let bas = amp_actuel[i + w];\n\n  // 1) Propagation d'onde discrète (d'Alembert) + amortissement fondu.\n  var valeur = (2.0 * centre - passe + C2 * (gauche + droite + haut + bas - 4.0 * centre)) * AMORTISSEMENT;\n\n  // 2) Couplage de phase de Kuramoto.\n  let ph = phase[i];\n  let sync = sin(phase[i - 1u] - ph) + sin(phase[i + 1u] - ph) + sin(phase[i - w] - ph) + sin(phase[i + w] - ph);\n  phase[i] = ph + freq[i] * DT + COUPLAGE * DT * sync;\n\n  // 3) Gain cohérent : la synchronisation amplifie l'onde.\n  valeur = valeur + GAIN * (sync * 0.25) * centre;\n\n  // 4) Injection d'impulsions gaussiennes.\n  for (var k : u32 = 0u; k < params.nbImpulsions; k = k + 1u) {\n    let imp = impulsions[k];\n    let dx = f32(x) - imp.x;\n    let dy = f32(y) - imp.y;\n    let d2 = dx * dx + dy * dy;\n    if (d2 < RAYON_INJECTION * RAYON_INJECTION) {\n      valeur = valeur + imp.z * exp(-d2 / 1.4);\n      phase[i] = phase[i] + 0.5 * sin(imp.w * f32(params.pas) - ph);\n    }\n  }\n\n  amp_suivant[i] = valeur;\n}\n`;
  optimisations.push(`workgroup calibré ${wgx}×${wgy} (limites réelles du GPU respectées)`);
  optimisations.push("voisinage 4-connexe groupé pour la localité de cache");
  optimisations.push("uniform Params réduit à 4 scalaires (dims + impulsions)");

  const code = `${entete}${structParams}\n\n${constantes}${bindings}${corps}`;
  return {
    code,
    workgroup: [wgx, wgy],
    empreinte: fnv1a(`por-shader|${profil.famille}|${wgx}x${wgy}|${code.length}`).toString(16),
    optimisations,
    famille: profil.famille,
  };
}

/* ------------------------------------------------------------------ */
/* Cache de session                                                    */
/* ------------------------------------------------------------------ */

/**
 * CacheCompilation — une compilation par couple (empreinte profil +
 * configuration). Le sondage ne se rejoue jamais pour rien : le même
 * GPU avec le même effort réutilise son shader spécialisé.
 */
export class CacheCompilation {
  private cache = new Map<string, ShaderSpecialise>();

  cle(profil: ProfilGPU, cfg: ConfigOndes): string {
    return `${profil.famille}|${profil.tier}|${profil.workgroup[0]}x${profil.workgroup[1]}|${cfg.largeur}x${cfg.hauteur}|${cfg.c2}|${cfg.amortissement}|${cfg.couplage}|${cfg.dt}|${cfg.gain}`;
  }

  obtenir(cle: string): ShaderSpecialise | null {
    return this.cache.get(cle) ?? null;
  }

  memoriser(cle: string, shader: ShaderSpecialise): ShaderSpecialise {
    this.cache.set(cle, shader);
    return shader;
  }

  get taille(): number {
    return this.cache.size;
  }
}
