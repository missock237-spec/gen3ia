import type {
  AIProvider,
  AIMessage,
  AIRequest,
  AIResponse,
} from "./models";

import { validateImageAttachments } from "./content-filter";

// Comptage du coût réel dans l'exécution facturée en cours (tarif nul —
// le moteur interne ne consomme aucun service externe).
import { recordLLMCallForBilling } from "@/lib/billing/execution-meter";

import { getNeuralRuntime } from "../neural/runtime";

/**
 * ROUTEUR IA — MOTEUR NEURONAL EXCLUSIF.
 *
 * Les IA externes (LLM OpenAI/Anthropic/Groq/OpenRouter/GLM/Agnes) ont
 * été supprimées du projet sur demande explicite de l'utilisateur :
 * toutes les capacités IA passent par le SYSTÈME NEURONAL Gen3
 * (lib/neural/ — SNN à spikes, plasticité hebbienne, corps sémantique).
 *
 * `generate` / `generateStream` conservent leur signature historique :
 * chaque intégration existante (chat, agents, planificateurs, critiques,
 * entraînement…) continue de fonctionner, dorénavant propulsée par le
 * moteur interne.
 */

/** Garde vision : toute image jointe est validée (nombre, taille réelle
 *  après base64, format, URLs https) AVANT l'exécution — rejet uniforme. */
function assertImagesAllowed(request: AIRequest): void {
  const images = request.messages.flatMap((message) => message.images ?? []);
  if (images.length === 0) return;
  const filter = validateImageAttachments(images);
  if (!filter.ok) {
    throw new Error(`Images refusées par le filtre de contenu : ${filter.errors.join(" ")}`);
  }
}

export interface RoutingDecision {
  provider: AIProvider;

  model: string;

  reason: string;

  score: number;
}

/** Modèle logique du moteur neuronal (lib/neural/engine.ts). */
const NEURAL_MODEL = "gen3-snn-v1";

/**
 * Décision de routage — un seul moteur, une seule décision. Conservée
 * pour les intégrations historiques (billing/execution-gate,
 * worstCaseReserve) : la réponse est toujours la même et honnête.
 */
export function selectProvider(
  _request: AIRequest,
): RoutingDecision[] {
  return [
    {
      provider: "gen3-snn",
      model: NEURAL_MODEL,
      reason: "Moteur neuronal Gen3 (SNN interne) — unique moteur du projet",
      score: 100,
    },
  ];
}

/**
 * Picks the best available model for a request — toujours le moteur
 * neuronal Gen3.
 */
export function selectModel(
  request: Omit<AIRequest, "messages"> & { messages?: AIMessage[] },
): RoutingDecision | null {
  return selectProvider({ ...request, messages: request.messages ?? [] })[0] ?? null;
}

export async function generate(
  request: AIRequest,
): Promise<AIResponse> {
  assertImagesAllowed(request);

  // Moteur neuronal Gen3 — unique moteur du projet.
  const response = await getNeuralRuntime().engine.generate(request);
  recordLLMCallForBilling(request, response);
  return response;
}

/**
 * Variante en flux de `generate` : les fragments réels du moteur neuronal
 * (progression cycle par cycle, puis texte décodé par segments) sont
 * transmis à `onDelta` au fil de l'exécution ; `onProviderSelected` est
 * appelé avant le premier delta — contrat identique au routeur historique.
 */
export async function generateStream(
  request: AIRequest,
  handlers: {
    onDelta: (delta: string) => void | Promise<void>;
    /** Appelé avant le premier delta du moteur retenu. */
    onProviderSelected?: (provider: AIProvider, model: string) => void | Promise<void>;
  },
): Promise<AIResponse> {
  assertImagesAllowed(request);

  // Moteur neuronal Gen3 — unique moteur du projet.
  const response = await getNeuralRuntime().engine.generateStream(request, {
    onDelta: handlers.onDelta,
    onProviderSelected: handlers.onProviderSelected,
  });
  recordLLMCallForBilling(request, response);
  return response;
}
