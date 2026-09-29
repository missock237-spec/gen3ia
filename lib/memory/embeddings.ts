import {
  InferenceClient,
} from "@huggingface/inference";

const model =
  process.env.HF_EMBEDDING_MODEL;

if (!model) {
  console.warn(
    "HF_EMBEDDING_MODEL is not configured",
  );
}

const client =
  new InferenceClient(
    process.env.HF_TOKEN,
  );

/**
 * CACHE D'EMBEDDINGS (Task 42, axe 8 — élasticité) : l'embedding est une
 * fonction DÉTERMINISTE du texte et du modèle — un même texte encodé deux
 * fois donne le même vecteur. Cache LRU mémoire (mono-processus) :
 * réindexations, recherches répétées et reprises échouées ne re-paient
 * plus le réseau. Confidentialité : les vecteurs restent EN PROCESSUS,
 * jamais persistés ni loggés ; taille bornée (évanescence LRU).
 */
const EMBEDDING_CACHE_MAX = 500;
const embeddingCache = new Map<string, number[]>();

function cacheKey(text: string): string {
  return `${model ?? "none"}:${text}`;
}

export async function createMemoryEmbedding(
  text: string,
): Promise<number[]> {
  if (!model) {
    throw new Error(
      "HF_EMBEDDING_MODEL is not configured",
    );
  }

  const key = cacheKey(text);
  const cached = embeddingCache.get(key);
  if (cached) {
    // Rajeunissement LRU (réinsertion en fin de Map = usage récent).
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
    return cached;
  }

  const result =
    await client.featureExtraction({
      model,
      inputs: text,
    });

  if (
    !Array.isArray(result)
  ) {
    throw new Error(
      "Invalid embedding response",
    );
  }

  if (
    result.length === 0
  ) {
    throw new Error(
      "Empty embedding",
    );
  }

  const embedding =
    Array.isArray(result[0])
      ? (result[0] as number[])
      : (result as number[]);

  embeddingCache.set(key, embedding);
  if (embeddingCache.size > EMBEDDING_CACHE_MAX) {
    // Évince l'entrée la plus ancienne (première clé insérée).
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }

  return embedding;
}
