/**
 * WEBGPU MEMORY MANAGER — budget mémoire GPU central (mission Phase 7-3
 * « seuils de mémoire », Phase 10-2 « limiter les allocations »). Un seul
 * budget partagé : chaque allocation demandée est comptée, les dépassements
 * sont REFUSÉS avec raison (pas de fiction), les stats alimentent le
 * dashboard.
 */

const globalMemoire = globalThis as typeof globalThis & { __gen3iaGpuBudget?: BudgetMemoireGpu };

export interface BudgetMemoireGpu {
  /** Budget total autorisé pour Gen3ia (octets) — défaut 512 Mo. */
  budgetOctets: number;
  octetsUtilises: number;
  refus: number;
  peakOctets: number;
}

function budget(): BudgetMemoireGpu {
  if (!globalMemoire.__gen3iaGpuBudget) {
    globalMemoire.__gen3iaGpuBudget = { budgetOctets: 512 * 1024 * 1024, octetsUtilises: 0, refus: 0, peakOctets: 0 };
  }
  return globalMemoire.__gen3iaGpuBudget;
}

/** Définit le budget (à partir des limites réelles du device si connues). */
export function definirBudgetGpu(octets: number): void {
  budget().budgetOctets = Math.max(1024, octets);
}

/** Réserve N octets → autorisé/refusé avec raison (jamais de dépassement). */
export function reserverMemoireGpu(octets: number): { autorise: boolean; raison?: string } {
  const b = budget();
  if (octets > b.budgetOctets) {
    b.refus += 1;
    return { autorise: false, raison: `allocation ${Math.round(octets / 1024 / 1024)} Mo > budget Gen3ia ${Math.round(b.budgetOctets / 1024 / 1024)} Mo — REFUSÉE (mission Phase 10 : prévenir les allocations excessives)` };
  }
  if (b.octetsUtilises + octets > b.budgetOctets) {
    b.refus += 1;
    return { autorise: false, raison: `budget épuisé (${b.octetsUtilises} + ${octets} > ${b.budgetOctets} octets) — libérer ou réduire` };
  }
  b.octetsUtilises += octets;
  b.peakOctets = Math.max(b.peakOctets, b.octetsUtilises);
  return { autorise: true };
}

/** Libère une réservation (retour au budget disponible). */
export function libererMemoireGpu(octets: number): void {
  const b = budget();
  b.octetsUtilises = Math.max(0, b.octetsUtilises - octets);
}

/** Instantané mémoire (dashboard). */
export function etatMemoireGpu(): Readonly<BudgetMemoireGpu> {
  return { ...budget() };
}

export function reinitialiserMemoireGpu(): void {
  const b = budget();
  b.octetsUtilises = 0;
  b.refus = 0;
  b.peakOctets = 0;
}
