/**
 * WEBGPU BUFFER POOL — réutilisation contrôlée des buffers GPU (mission
 * Phase 3 : « réutiliser les ressources lorsque c'est possible », « éviter
 * les allocations répétitives », « limiter les lectures GPU vers CPU »).
 * Pools par taille exacte : obtenir → rendre → réutiliser. Destroy à la
 * fermeture du device uniquement.
 */

export interface BufferAlloue {
  buffer: GPUBuffer;
  taille: number;
}

interface PiscineParTaille {
  tampons: GPUBuffer[];
  taille: number;
}

const globalPools = globalThis as typeof globalThis & {
  __gen3iaGpuBufferPools?: Map<number, PiscineParTaille>;
  __gen3iaGpuBufferStats?: { allocations: number; reutilisations: number; octetsActifs: number };
};

function pools(): Map<number, PiscineParTaille> {
  if (!globalPools.__gen3iaGpuBufferPools) globalPools.__gen3iaGpuBufferPools = new Map();
  return globalPools.__gen3iaGpuBufferPools;
}

function stats(): { allocations: number; reutilisations: number; octetsActifs: number } {
  if (!globalPools.__gen3iaGpuBufferStats) globalPools.__gen3iaGpuBufferStats = { allocations: 0, reutilisations: 0, octetsActifs: 0 };
  return globalPools.__gen3iaGpuBufferStats;
}

/** Obtient un buffer STOCKAGE de la taille demandée (pool ou création). */
export function obtenirBuffer(device: GPUDevice, taille: number): BufferAlloue {
  const tailleAlignee = Math.ceil(taille / 16) * 16; // alignement uniforme
  const p = pools();
  const piscine = p.get(tailleAlignee);
  if (piscine && piscine.tampons.length > 0) {
    const buffer = piscine.tampons.pop()!;
    stats().reutilisations += 1;
    stats().octetsActifs += tailleAlignee;
    return { buffer, taille: tailleAlignee };
  }
  const buffer = device.createBuffer({ size: tailleAlignee, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  stats().allocations += 1;
  stats().octetsActifs += tailleAlignee;
  return { buffer, taille: tailleAlignee };
}

/** Rend un buffer au pool (aucun destroy — réutilisation future). */
export function rendreBuffer(bufferAlloue: BufferAlloue): void {
  const p = pools();
  let piscine = p.get(bufferAlloue.taille);
  if (!piscine) {
    piscine = { tampons: [], taille: bufferAlloue.taille };
    p.set(bufferAlloue.taille, piscine);
  }
  if (piscine.tampons.length < 16) piscine.tampons.push(bufferAlloue.buffer);
  else bufferAlloue.buffer.destroy(); // borne anti-fuite mission Phase 10
  stats().octetsActifs = Math.max(0, stats().octetsActifs - bufferAlloue.taille);
}

/** Statistiques du pool (dashboard mission Phase 11). */
export function statsPool(): { allocations: number; reutilisations: number; octetsActifs: number; taillesEnPool: number[] } {
  return {
    ...stats(),
    taillesEnPool: [...pools().keys()],
  };
}

/** Fermeture : destruction de tous les buffers en pool (device perdu/fin). */
export function viderPools(): void {
  for (const piscine of pools().values()) {
    for (const t of piscine.tampons) {
      try { t.destroy(); } catch { /* déjà perdu */ }
    }
  }
  pools().clear();
  stats().octetsActifs = 0;
}
