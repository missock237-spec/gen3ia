import "server-only";

/**
 * Génération d'images réelle via Agnes AI (apihub.agnes-ai.com).
 *
 * - API 100% compatible OpenAI : POST /v1/images/generations
 * - Modèle par défaut : agnes-image-2.5-flash (text-to-image, img2img,
 *   composition multi-images, tailles 1K-4K avec ratio).
 * - La clé vit UNIQUEMENT côté serveur (AGNES_API_KEY, variable Vercel).
 *
 * Référence : https://wiki.agnes-ai.com/en/docs/agnes-image-25-flash.md
 */

export const AGNES_IMAGE_MODEL = process.env.AGNES_IMAGE_MODEL || "agnes-image-2.5-flash";

const AGNES_API_BASE = process.env.AGNES_API_BASE || "https://apihub.agnes-ai.com/v1";

/** Garde-fou de durée : une génération nominale prend 5-15 s. */
const IMAGE_TIMEOUT_MS = 90_000;

/** Tailles/ratios autorisés (doc officielle). */
export const IMAGE_SIZES = ["1K", "2K", "3K", "4K"] as const;
export const IMAGE_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];
export type ImageRatio = (typeof IMAGE_RATIOS)[number];

export interface GeneratedImage {
  imageUrl: string;
  model: string;
  taskId?: string;
  latencyMs: number;
}

export class ImageGenerationError extends Error {
  code: "NOT_CONFIGURED" | "UPSTREAM_ERROR" | "TIMEOUT" | "INVALID_PROMPT";

  constructor(code: ImageGenerationError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "ImageGenerationError";
  }
}

/** La génération d'images n'est disponible que si la clé Agnes est configurée. */
export function isImageGenerationEnabled(): boolean {
  return Boolean(process.env.AGNES_API_KEY);
}

/**
 * Détection déterministe d'intention « générer une image » : un verbe
 * d'action + un nom d'objet visuel, en français ou en anglais. Aucun appel
 * LLM : la détection reste gratuite, instantanée et fiable pour les
 * formulations explicites.
 */
const IMAGE_VERBS =
  /\b(g[ée]n[èe]re(?:r|z|s)?|g[ée]n[ée]ration|cr[ée]e(?:r|z|s)?|cr[ée]ation|dessine(?:r|z|s|\-moi)?|fais(?:-|\s)?moi|fabrique(?:r|z|s)?|produis(?:-|\s)?moi|imagine(?:r|z|s)?|peins(?:-|\s)?(?:moi)?|render|generate|generating|create|draw|make|produce|design|illustrate)\b/i;

const IMAGE_NOUNS =
  /\b(image|images|photo|photos|photographie|visuel|visuels|logo|logos|illustration|illustrations|dessin|dessins|affiche|affiches|poster|posters|banni[èe]re|banni[èe]res|bandeaux?|ic[ôo]ne|ic[ôo]nes|avatar|fond d'[éé]cran|wallpaper|thumbnail|miniature|picture|pictures|portrait|artwork|tableau|banni[èe]re publicitaire|image de couverture|couverture)\b/i;

export function looksLikeImageRequest(message: string): boolean {
  const text = message.trim();
  if (text.length < 8 || text.length > 4000) return false;
  return IMAGE_VERBS.test(text) && IMAGE_NOUNS.test(text);
}

/**
 * Extrait le prompt effectif du message utilisateur : on retire les formules
 * d'introduction (« génère-moi une image de ... ») pour laisser au modèle un
 * descriptif propre.
 */
export function extractImagePrompt(message: string): string {
  let prompt = message.trim();
  prompt = prompt.replace(
    /^(?:s'il\s+te\s+pla[îi]t[,]?\s*)?(?:peux(?:-|\s)?tu|pourrais(?:-|\s)?tu|stp|svp)?\s*(?:g[ée]n[èe]re(?:-|\s)?(?:moi)?|cr[ée]e(?:-|\s)?(?:moi)?|dessine(?:-|\s)?(?:moi)?|fais(?:-|\s)?moi|fabrique(?:-|\s)?moi|produis(?:-|\s)?moi|imagine(?:-|\s)?(?:moi)?|peins(?:-|\s)?(?:moi)?)\s*(?:une?\s+)?(?:belle\s+|jolie\s+|superbe\s+)?(?:image(?:s)?|photo(?:s)?|visuel(?:s)?|illustration(?:s)?|dessin(?:s)?|affiche(?:s)?|logo(?:s)?|poster(?:s)?|banni[èe]re(?:s)?|ic[ôo]ne(?:s)?|avatar|fond\s+d'?[éé]cran|miniature|thumbnail|picture|portrait|artwork)\s*(?:de|du|d'|pour|sur|repr[ée]sentant|montre|montrant|avec|:)?\s*/i,
    "",
  );
  return prompt.trim() || message.trim();
}

interface AgnesImageResponse {
  data?: Array<{ url?: string; b64_json?: string }>;
  task_id?: string;
  error?: { message?: string; code?: string } | string;
}

/**
 * Génère une image via Agnes AI et renvoie son URL publique.
 * La réponse officielle : { data: [{ url, b64_json, revised_prompt }], created, task_id }.
 */
export async function generateImageWithAgnes(options: {
  prompt: string;
  size?: ImageSize;
  ratio?: ImageRatio;
}): Promise<GeneratedImage> {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    throw new ImageGenerationError(
      "NOT_CONFIGURED",
      "La génération d'images n'est pas configurée sur cette plateforme (AGNES_API_KEY manquante).",
    );
  }

  const prompt = options.prompt?.trim();
  if (!prompt || prompt.length < 3) {
    throw new ImageGenerationError("INVALID_PROMPT", "Décrivez l'image à générer en quelques mots.");
  }
  if (prompt.length > 4000) {
    throw new ImageGenerationError("INVALID_PROMPT", "La description de l'image est trop longue (4000 caractères maximum).");
  }

  const size = options.size ?? "1K";
  const ratio = options.ratio ?? "1:1";

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);

  try {
    const response = await fetch(`${AGNES_API_BASE}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AGNES_IMAGE_MODEL,
        prompt,
        size,
        ratio,
        extra_body: { response_format: "url" },
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    const latencyMs = Date.now() - started;

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      let message = `Agnes AI a renvoyé une erreur HTTP ${response.status}.`;
      try {
        const parsed = JSON.parse(detail) as AgnesImageResponse;
        const upstream = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
        if (upstream) message = `Agnes AI : ${upstream}`;
      } catch {
        if (detail) message = `Agnes AI : ${detail.slice(0, 200)}`;
      }
      console.error(`[agnes-image] HTTP ${response.status} après ${latencyMs}ms:`, message);
      throw new ImageGenerationError("UPSTREAM_ERROR", message);
    }

    const payload = (await response.json()) as AgnesImageResponse;
    const url = payload.data?.[0]?.url;
    if (!url || typeof url !== "string" || !/^https?:\/\//.test(url)) {
      console.error("[agnes-image] réponse sans URL d'image:", JSON.stringify(payload).slice(0, 300));
      throw new ImageGenerationError("UPSTREAM_ERROR", "Agnes AI n'a pas renvoyé d'image exploitable. Réessayez.");
    }

    return {
      imageUrl: url,
      model: AGNES_IMAGE_MODEL,
      taskId: payload.task_id,
      latencyMs,
    };
  } catch (error) {
    if (error instanceof ImageGenerationError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ImageGenerationError("TIMEOUT", "La génération d'image a pris trop de temps. Réessayez.");
    }
    throw new ImageGenerationError(
      "UPSTREAM_ERROR",
      error instanceof Error ? error.message : "La génération d'image a échoué.",
    );
  } finally {
    clearTimeout(timer);
  }
}
