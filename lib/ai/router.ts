import {
  MODEL_CAPABILITIES,
  PROVIDERS,
} from "./config";

import type {
  AIProvider,
  AIMessage,
  AIRequest,
  AIResponse,
  TaskType,
} from "./models";

import {
  callProvider,
  callProviderStream,
} from "./providers";

export interface RoutingDecision {
  provider: AIProvider;

  model: string;

  reason: string;

  score: number;
}

function calculateScore(
  request: AIRequest,
  provider: AIProvider,
  model: string,
): number {
  const capability =
    MODEL_CAPABILITIES.find(
      (item) =>
        item.provider === provider &&
        item.model === model,
    );

  if (!capability) {
    return -Infinity;
  }

  if (
    !capability.tasks.includes(
      request.task,
    )
  ) {
    return -Infinity;
  }

  if (
    request.requiresTools &&
    !capability.toolCalling
  ) {
    return -Infinity;
  }

  if (
    request.requiresVision &&
    !capability.vision
  ) {
    return -Infinity;
  }

  if (
    request.requiresStructuredOutput &&
    !capability.structuredOutput
  ) {
    return -Infinity;
  }

  let score =
    capability.priority;

  if (
    request.provider ===
    provider
  ) {
    score += 100;
  }

  if (
    request.preferFree &&
    provider === "openrouter"
  ) {
    score += 40;
  }

  return score;
}

export function selectProvider(
  request: AIRequest,
): RoutingDecision[] {
  const decisions:
    RoutingDecision[] = [];

  for (const providerConfig of PROVIDERS) {
    if (!providerConfig.enabled) {
      continue;
    }

    const model =
      request.provider ===
        providerConfig.provider &&
      request.model
        ? request.model
        : providerConfig.defaultModel;

    if (
      !model ||
      model === "auto"
    ) {
      continue;
    }

    const score =
      calculateScore(
        request,
        providerConfig.provider,
        model,
      );

    if (
      score === -Infinity
    ) {
      continue;
    }

    decisions.push({
      provider:
        providerConfig.provider,

      model,

      score,

      reason:
        `${providerConfig.provider} selected for ${request.task}`,
    });
  }

  return decisions.sort(
    (a, b) =>
      b.score - a.score,
  );
}

/**
 * Picks the best available model for a request.
 * Returns the highest-scored routing decision, or null when no
 * configured provider can serve the task.
 */
export function selectModel(
  request: Omit<AIRequest, "messages"> & { messages?: AIMessage[] },
): RoutingDecision | null {
  const decisions =
    selectProvider({ ...request, messages: request.messages ?? [] });

  return decisions[0] ?? null;
}

export async function generate(
  request: AIRequest,
): Promise<AIResponse> {
  const candidates =
    selectProvider(request);

  if (candidates.length === 0) {
    throw new Error(
      `No configured provider can execute task "${request.task}".`,
    );
  }

  const failures: Array<{
    provider: AIProvider;
    error: string;
  }> = [];

  for (const candidate of candidates) {
    try {
      return await callProvider(
        candidate.provider,
        {
          ...request,

          provider:
            candidate.provider,

          model:
            candidate.model,
        },
      );
    } catch (error) {
      failures.push({
        provider:
          candidate.provider,

        error:
          error instanceof Error
            ? error.message
            : "Unknown provider error.",
      });
    }
  }

  throw new Error(
    `All AI providers failed: ${JSON.stringify(
      failures,
    )}`,
  );
}

/**
 * Variante en flux de `generate` : mêmes règles de sélection de fournisseur,
 * mais chaque fragment de texte est transmis à `onDelta` au fil de l'arrivée
 * (token streaming réel côté fournisseur). En cas d'échec d'un fournisseur,
 * on réessaie avec le suivant — les fragments déjà émis ne sont PAS
 * retransmis : `onDelta` ne doit être branché qu'à partir du premier
 * fournisseur qui accepte le flux (signalé via `onProviderSelected`).
 */
export async function generateStream(
  request: AIRequest,
  handlers: {
    onDelta: (delta: string) => void | Promise<void>;
    /** Appelé avant le premier delta du fournisseur retenu. */
    onProviderSelected?: (provider: AIProvider, model: string) => void | Promise<void>;
  },
): Promise<AIResponse> {
  const candidates =
    selectProvider(request);

  if (candidates.length === 0) {
    throw new Error(
      `No configured provider can execute task "${request.task}".`,
    );
  }

  const failures: Array<{
    provider: AIProvider;
    error: string;
  }> = [];

  for (const candidate of candidates) {
    let providerAccepted = false;
    try {
      const response = await callProviderStream(
        candidate.provider,
        {
          ...request,

          provider:
            candidate.provider,

          model:
            candidate.model,
        },
        (delta) => {
          if (!providerAccepted) {
            providerAccepted = true;
            const selected = handlers.onProviderSelected?.(candidate.provider, candidate.model);
            // Le premier fragment suit le même chemin que les autres :
            // onProviderSelected est un signal, jamais un remplacement.
            return Promise.resolve(selected).then(() => handlers.onDelta(delta));
          }
          return handlers.onDelta(delta);
        },
      );
      // Le premier fragment passe par onProviderSelected : transmettons-le
      // aussi à onDelta pour que le texte émis soit complet.
      return response;
    } catch (error) {
      // Aucun fragment n'a été émis pour ce fournisseur : on peut tenter le
      // suivant sans risque de dupliquer du texte côté client.
      if (!providerAccepted) {
        failures.push({
          provider:
            candidate.provider,

          error:
            error instanceof Error
              ? error.message
              : "Unknown provider error.",
        });
        continue;
      }
      // Le flux a commencé mais a échoué en cours de route : on ne retente
      // pas (texte déjà partiellement livré) — l'appelant gère le repli.
      throw error;
    }
  }

  throw new Error(
    `All AI providers failed (stream): ${JSON.stringify(
      failures,
    )}`,
  );
}
