import "server-only";

/* ------------------------------------------------------------------ */
/* Abstraction de fournisseur GPU (spec §8)                             */
/*                                                                    */
/* Chaque fournisseur expose : capacités réelles, soumission, état,    */
/* journaux, annulation. La sélection tient compte de la VRAM           */
/* nécessaire déclarée par le moteur. AUCUN fournisseur n'est           */
/* considéré comme disponible sans vérification explicite.             */
/* ------------------------------------------------------------------ */

export interface GpuInfo {
  name: string;
  vramGb: number;
  available: boolean;
}

export interface GpuProviderCapabilities {
  providerId: string;
  label: string;
  gpus: GpuInfo[];
  maxDurationMinutes: number | null;
  /** Vrai UNIQUEMENT pour le fournisseur mock (tests/dev). */
  simulated: boolean;
}

export interface SubmitJobPayload {
  jobId: string;
  engineId: string;
  method: string;
  parameters: Record<string, unknown>;
  baseModel: { kind: "upload" | "catalog"; ref: string; storageKey?: string };
  datasets: Array<{ storageKey: string; split: string; format: string }>;
}

export interface ProviderLogLine {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
}

export interface ProviderJobState {
  externalId: string;
  status: "running" | "completed" | "failed";
  progressPercent: number | null;
  currentStep: string | null;
  epochsDone: number | null;
  epochsTotal: number | null;
  trainLoss: number | null;
  metrics: Record<string, number>;
  logs: ProviderLogLine[];
  error: string | null;
  artifacts: Array<{ label: string; storageKey: string; sizeBytes: number }>;
}

export interface GpuProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Périmètre d'engines optionnel : si déclaré, le fournisseur n'accepte
   * QUE les tâches de ces moteurs (ex. gen3-local → gen3-native). Absent =
   * compatible avec tous les moteurs (sélection VRAM standard).
   */
  readonly engines?: readonly string[];
  /** Sonde les capacités réelles (échoue proprement si injoignable). */
  capabilities(): Promise<GpuProviderCapabilities>;
  submit(payload: SubmitJobPayload): Promise<{ externalId: string }>;
  status(externalId: string): Promise<ProviderJobState>;
  cancel(externalId: string): Promise<void>;
}

/** Sélection : le fournisseur couvre-t-il la VRAM minimale demandée ? */
export function providerSupportsVram(capabilities: GpuProviderCapabilities, minVramGb: number): boolean {
  return capabilities.gpus.some((gpu) => gpu.available && gpu.vramGb >= minVramGb);
}
