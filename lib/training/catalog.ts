import "server-only";

import { ENGINES } from "./engines/registry";
import { resolveProviders } from "./providers";
import { trainingQuotas } from "./quotas";

/* ------------------------------------------------------------------ */
/* Catalogue public du Training Studio (spec §9)                        */
/*                                                                    */
/* Le catalogue n'affiche QUE des méthodes réellement supportées.      */
/* Les modèles de base listés sont des RÉFÉRENCES (identifiants        */
/* Hugging Face publics) : aucun poids n'est téléchargé ni hébergé    */
/* ici — le worker GPU les récupère à l'exécution depuis le dépôt      */
/* officiel. Le statut des fournisseurs est sonde en temps réel.       */
/* ------------------------------------------------------------------ */

export interface CatalogBaseModel {
  id: string;
  name: string;
  family: "text";
  params: string;
  minVramGb: number;
  recommendedFor: string[];
  notes: string;
}

/** Modèles de base recommandés — références publiques vérifiables. */
export const BASE_MODELS: CatalogBaseModel[] = [
  {
    id: "Qwen/Qwen2.5-0.5B-Instruct",
    name: "Qwen2.5 0.5B Instruct",
    family: "text",
    params: "0,5 Md",
    minVramGb: 4,
    recommendedFor: ["qlora", "expérimentation"],
    notes: "Très léger : idéal pour valider un pipeline d'entraînement de bout en bout.",
  },
  {
    id: "Qwen/Qwen2.5-1.5B-Instruct",
    name: "Qwen2.5 1.5B Instruct",
    family: "text",
    params: "1,5 Md",
    minVramGb: 8,
    recommendedFor: ["lora", "qlora"],
    notes: "Compromis qualité/VRAM recommandé par défaut pour les premiers fine-tunings.",
  },
  {
    id: "meta-llama/Llama-3.2-1B-Instruct",
    name: "Llama 3.2 1B Instruct",
    family: "text",
    params: "1,2 Md",
    minVramGb: 8,
    recommendedFor: ["lora", "qlora"],
    notes: "Licence Llama : vérifiez les conditions d'utilisation pour votre cas.",
  },
  {
    id: "mistralai/Mistral-7B-Instruct-v0.3",
    name: "Mistral 7B Instruct v0.3",
    family: "text",
    params: "7 Md",
    minVramGb: 20,
    recommendedFor: ["qlora", "lora (multi-GPU)"],
    notes: "Qualité supérieure : QLoRA requis sur GPU 24 Go.",
  },
  {
    id: "google/gemma-2-2b-it",
    name: "Gemma 2 2B IT",
    family: "text",
    params: "2,6 Md",
    minVramGb: 10,
    recommendedFor: ["lora", "qlora"],
    notes: "Bon rapport qualité/taille, licence Gemma.",
  },
];

export interface ProviderStatusEntry {
  id: string;
  label: string;
  configured: boolean;
  gpus: Array<{ name: string; vramGb: number; available: boolean }>;
  simulated: boolean;
}

export interface TrainingCatalog {
  engines: Array<{
    id: string;
    name: string;
    description: string;
    families: string[];
    methods: string[];
    available: boolean;
    minVramGb: number;
    parameters: Array<{ key: string; label: string; type: string; min?: number; max?: number; step?: number; defaultValue?: number | string | boolean; description: string }>;
    knownLimits: string[];
  }>;
  baseModels: CatalogBaseModel[];
  providers: ProviderStatusEntry[];
  quotas: {
    maxProjects: number;
    maxConcurrentJobs: number;
    maxUploadMb: number;
    maxDatasetsPerProject: number;
    maxModelsPerProject: number;
  };
}

/** Construit le catalogue complet, sondes fournisseurs incluses. */
export async function buildCatalog(): Promise<TrainingCatalog> {
  const providers = resolveProviders();
  const statuses: ProviderStatusEntry[] = await Promise.all(
    providers.map(async (provider) => {
      try {
        const caps = await provider.capabilities();
        return {
          id: provider.id,
          label: provider.label,
          configured: caps.gpus.length > 0,
          gpus: caps.gpus,
          simulated: caps.simulated,
        };
      } catch {
        return { id: provider.id, label: provider.label, configured: false, gpus: [], simulated: false };
      }
    }),
  );

  const quotas = trainingQuotas();
  return {
    engines: ENGINES.map((engine) => ({
      id: engine.id,
      name: engine.name,
      description: engine.description,
      families: [...engine.families],
      methods: [...engine.methods],
      available: engine.available,
      minVramGb: engine.minVramGb,
      parameters: engine.parameters.map((p) => ({
        key: p.key,
        label: p.label,
        type: p.type,
        min: p.min,
        max: p.max,
        step: p.step,
        defaultValue: p.defaultValue,
        description: p.description,
      })),
      knownLimits: [...engine.knownLimits],
    })),
    baseModels: [...BASE_MODELS],
    providers: statuses,
    quotas: {
      maxProjects: quotas.maxProjects,
      maxConcurrentJobs: quotas.maxConcurrentJobs,
      maxUploadMb: Math.round(quotas.maxUploadBytes / (1024 * 1024)),
      maxDatasetsPerProject: quotas.maxDatasetsPerProject,
      maxModelsPerProject: quotas.maxModelsPerProject,
    },
  };
}
