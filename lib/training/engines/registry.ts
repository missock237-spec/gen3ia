import "server-only";

import type { TrainingFamily, TrainingMethod } from "../types";

/* ------------------------------------------------------------------ */
/* Registre des moteurs d'entraînement (spec §9)                       */
/*                                                                    */
/* Système EXTENSIBLE : chaque moteur déclare ses capacités RÉELLES     */
/* (architectures, formats, méthodes, paramètres). Le catalogue n'affiche*/
/* que ce qui est effectivement pris en charge — aucune promesse        */
/* d'entraînement multimodal tant que le moteur n'existe pas.           */
/*                                                                    */
/* Moteurs v1 : text-lora (LoRA/QLoRA sur LLM Transformers) +          */
/* text-eval (évaluation seule) + rag-index (indexation RAG — n'est    */
/* PAS un entraînement des poids). Les moteurs image/audio/vidéo sont   */
/* des capacités déclarées POUR le futur : `available: false`.          */
/* ------------------------------------------------------------------ */

export interface EngineParameterSpec {
  key: string;
  label: string;
  type: "number" | "string" | "boolean";
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number | string | boolean;
  description: string;
}

export interface TrainingEngine {
  /** Identifiant stable (cité dans les plans). */
  id: string;
  name: string;
  description: string;
  families: TrainingFamily[];
  methods: TrainingMethod[];
  /** Formats de fichiers modèle acceptés en entrée. */
  acceptedModelFormats: string[];
  /** Formats de datasets acceptés. */
  acceptedDatasetFormats: string[];
  /** Ressources minimales déclarées (estimations prudentes). */
  minVramGb: number;
  /** Exécution réelle possible aujourd'hui (moteur câblé à un worker). */
  available: boolean;
  /** Paramètres exposés en mode avancé. */
  parameters: EngineParameterSpec[];
  /** Limites connues, affichées telles quelles à l'utilisateur. */
  knownLimits: string[];
}

export const ENGINES: TrainingEngine[] = [
  {
    id: "gen3-native",
    name: "Gen3 natif — Gen entraîne votre modèle",
    description:
      "L'IA Gen3ia entraîne ELLE-MÊME un modèle de langage sur VOS données : votre dataset de paires question/réponse est réellement appris par le cortex neuronal Gen3 (index inversé pondéré IDF + plasticité d'usage), sur le CPU de la plateforme. Aucun GPU externe requis, aucun modèle téléchargé — le modèle produit est un cerveau Gen3 exportable (JSON) qui répond à vos questions.",
    families: ["text"],
    methods: ["finetune", "full-training"],
    acceptedModelFormats: ["config-only", "catalog"],
    acceptedDatasetFormats: ["json", "jsonl", "csv", "txt"],
    minVramGb: 0,
    available: true,
    parameters: [
      { key: "epochs", label: "Époques", type: "number", min: 1, max: 30, step: 1, defaultValue: 5, description: "Passes complètes sur votre dataset (chaque passe renforce la plasticité du modèle)." },
      { key: "testRatio", label: "Fraction de test", type: "number", min: 0.05, max: 0.3, step: 0.05, defaultValue: 0.15, description: "Part des paires réservée à la mesure de précision (jamais vue pendant l'apprentissage)." },
    ],
    knownLimits: [
      "Le modèle produit est un cerveau Gen3 (apprentissage par corpus : il répond à partir de ce que le dataset lui a enseigné) — il ne généralise pas comme un LLM transformeur.",
      "Plafonds honnêtes : 5 Mo et 5 000 paires par dataset (au-delà, les lignes excédentaires sont ignorées et signalées dans les journaux).",
    ],
  },
  {
    id: "text-lora",
    name: "Fine-tuning LLM — LoRA / QLoRA",
    description:
      "Adaptateurs LoRA et QLoRA sur les modèles de langage compatibles Hugging Face Transformers (Llama, Mistral, Gemma…). Méthode la plus économe en VRAM pour spécialiser un LLM.",
    families: ["text"],
    methods: ["lora", "qlora", "adapter"],
    acceptedModelFormats: ["safetensors", "zip-archive", "catalog"],
    acceptedDatasetFormats: ["json", "jsonl", "csv"],
    minVramGb: 8,
    available: true,
    parameters: [
      { key: "learningRate", label: "Learning rate", type: "number", min: 1e-6, max: 1e-2, step: 1e-6, defaultValue: 2e-4, description: "Vitesse d'apprentissage (typique LoRA : 1e-4 à 3e-4)." },
      { key: "epochs", label: "Époques", type: "number", min: 1, max: 20, step: 1, defaultValue: 3, description: "Passes complètes sur le dataset." },
      { key: "batchSize", label: "Batch size", type: "number", min: 1, max: 32, step: 1, defaultValue: 4, description: "Exemples traités par étape." },
      { key: "loraRank", label: "Rang LoRA (r)", type: "number", min: 4, max: 128, step: 4, defaultValue: 16, description: "Dimension des adaptateurs — plus élevé = plus de capacité, plus de VRAM." },
      { key: "loraAlpha", label: "Alpha LoRA", type: "number", min: 1, max: 256, step: 1, defaultValue: 32, description: "Échelle des adaptateurs (usuellement 2× le rang)." },
      { key: "loraDropout", label: "Dropout LoRA", type: "number", min: 0, max: 0.5, step: 0.05, defaultValue: 0.05, description: "Régularisation des adaptateurs." },
      { key: "maxSequenceLength", label: "Longueur max de séquence", type: "number", min: 128, max: 8192, step: 128, defaultValue: 1024, description: "Tokens par exemple." },
      { key: "gradientAccumulation", label: "Accumulation de gradient", type: "number", min: 1, max: 32, step: 1, defaultValue: 2, description: "Simule des batchs plus grands sur VRAM limitée." },
    ],
    knownLimits: [
      "Nécessite un worker GPU connecté (voir Paramètres fournisseurs) : sans GPU, les tâches restent en file d'attente.",
      "La fusion des adaptateurs dans le modèle de base (merge) produit un modèle autonome plus lourd — l'export adaptateur seul exige le modèle de base à l'inférence.",
    ],
  },
  {
    id: "text-eval",
    name: "Évaluation de LLM",
    description:
      "Mesure un modèle existant sur un jeu de test (perte, exactitude tâche) sans modifier les poids.",
    families: ["text"],
    methods: ["eval-only"],
    acceptedModelFormats: ["safetensors", "gguf", "zip-archive", "catalog"],
    acceptedDatasetFormats: ["json", "jsonl", "csv"],
    minVramGb: 4,
    available: true,
    parameters: [
      { key: "batchSize", label: "Batch size", type: "number", min: 1, max: 64, step: 1, defaultValue: 8, description: "Exemples évalués par étape." },
      { key: "maxSequenceLength", label: "Longueur max de séquence", type: "number", min: 128, max: 8192, step: 128, defaultValue: 1024, description: "Tokens par exemple." },
    ],
    knownLimits: ["Nécessite un worker GPU connecté pour l'inférence batch."],
  },
  {
    id: "rag-index",
    name: "Indexation RAG",
    description:
      "Construit un système RAG : indexe vos documents dans une base vectorielle. N'ENTRAÎNE AUCUN POIDS — le modèle de langage reste inchangé, seules les connaissances indexées s'ajoutent.",
    families: ["text"],
    methods: ["rag"],
    acceptedModelFormats: ["catalog"],
    acceptedDatasetFormats: ["json", "jsonl", "csv", "txt"],
    minVramGb: 0,
    available: true,
    parameters: [
      { key: "chunkSize", label: "Taille de chunk", type: "number", min: 128, max: 4096, step: 64, defaultValue: 800, description: "Segments de texte indexés." },
      { key: "chunkOverlap", label: "Chevauchement", type: "number", min: 0, max: 512, step: 32, defaultValue: 80, description: "Recouvrement entre chunks." },
    ],
    knownLimits: [
      "Le RAG n'est PAS un fine-tuning : il enrichit le contexte, il ne modifie pas le comportement de base du modèle.",
    ],
  },
];

/** Moteurs réellement disponibles pour exécution (câblés à un worker). */
export function executableEngines(): TrainingEngine[] {
  return ENGINES.filter((engine) => engine.available);
}

export function findEngine(engineId: string): TrainingEngine | undefined {
  return ENGINES.find((engine) => engine.id === engineId);
}

/** Méthodes réellement supportées aujourd'hui (alimente l'UI honnêtement). */
export function supportedMethods(): TrainingMethod[] {
  return [...new Set(executableEngines().flatMap((engine) => engine.methods))];
}

/** Valide qu'un plan est cohérent avec les capacités déclarées du moteur. */
export function validatePlanAgainstEngine(plan: {
  method: string;
  engineId: string;
  parameters: Record<string, unknown>;
}): string[] {
  const engine = findEngine(plan.engineId);
  if (!engine) return [`Moteur inconnu : ${plan.engineId}.`];
  const errors: string[] = [];
  if (!engine.methods.includes(plan.method as TrainingMethod)) {
    errors.push(`La méthode ${plan.method} n'est pas supportée par le moteur ${engine.name}.`);
  }
  for (const [key, value] of Object.entries(plan.parameters ?? {})) {
    const spec = engine.parameters.find((p) => p.key === key);
    if (!spec) {
      errors.push(`Paramètre ${key} inconnu pour le moteur ${engine.name}.`);
      continue;
    }
    if (spec.type === "number" && typeof value === "number") {
      if (spec.min !== undefined && value < spec.min) errors.push(`${spec.label} : ${value} < minimum ${spec.min}.`);
      if (spec.max !== undefined && value > spec.max) errors.push(`${spec.label} : ${value} > maximum ${spec.max}.`);
    }
  }
  return errors;
}
