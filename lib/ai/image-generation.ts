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

/**
 * Garde-fou de durée : une génération nominale prend 5-15 s (1K), 10-25 s
 * (2K). Les surfaces serverless avec un budget serré (tour conversationnel,
 * fonction limitée à 60 s) passent un timeout explicite plus court.
 */
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
 *
 * Couverture élargie (retour utilisateur : « impossible de créer une image »
 * quand la formulation sort du gabarit verbe+nom strict) :
 *  - verbes de volonté (« je veux/voudrais/aimerais une image… »),
 *  - « faire » (« peux-tu me faire un dessin… »),
 *  - message COMMENÇANT par un nom visuel (« un logo pour ma boulangerie »).
 * Garde-fous anti-faux-positifs : les questions explicatives (« Comment
 * créer une image ? ») ne déclenchent PAS de génération.
 */
const IMAGE_VERBS =
  /\b(g[ée]n[èe]re(?:r|z|s)?|g[ée]n[ée]ration|cr[ée]e(?:r|z|s)?|cr[ée]ation|cr[ée][ée]e?|dessine(?:r|z|s|\-moi)?|fais(?:-|\s)?moi|faisons|faire|fabrique(?:r|z|s)?|produis(?:-|\s)?moi|imagine(?:r|z|s)?|peins(?:-|\s)?(?:moi)?|veux|voudrais|aimerais|souhaite(?:r|z|s)?|besoin|render|generate|generating|create|draw|make|produce|design|illustrate)\b/i;

const IMAGE_NOUNS =
  /\b(image|images|photo|photos|photographie|visuel|visuels|logo|logos|illustration|illustrations|dessin|dessins|paysage|paysages|affiche|affiches|poster|posters|banni[èe]re|banni[èe]res|bandeaux?|ic[ôo]ne|ic[ôo]nes|avatar|fond d'[éé]cran|wallpaper|thumbnail|miniature|picture|pictures|portrait|artwork|tableau|banni[èe]re publicitaire|image de couverture|couverture)\b/i;

/** Message qui COMMENCE par un nom visuel précédé d'un déterminant. */
const IMAGE_NOUN_LEAD =
  /^\s*(?:une?|des|les|le|la|mon|ma|mes|ton|ta|tes|ce|cette)\s+(?:IMAGE_NOUNS_PLACEHOLDER)/i;

/** Verbes d'analyse/édition : l'utilisateur agit sur une image EXISTANTE. */
const IMAGE_NON_GENERATION_VERBS =
  /\b(analys\w*|expliqu\w*|comprends?|comprendre|interpr[èe]t\w*|d[ée]cris|d[ée]crire|examin\w*|identifi\w*|ouvre[rz]?|ouvrir|t[ée]l[ée]charg\w*|supprim\w*|modifi\w*|renomme[rz]?|partag\w*|envoy\w*|ins[èe]r\w*|ajout\w*|retouch\w*|rogne[rz]?|redimensionn\w*)\b/i;

/** Verbes de GÉNÉRATION explicites (lèvent le garde d'analyse/édition). */
const IMAGE_GENERATION_VERBS =
  /\b(g[ée]n[èe]re(?:r|z|s)?|dessine(?:r|z|s)?|peins?(?:-\s?moi)?|imagine(?:r|z|s)?|cr[ée]e(?:r|z|s)?|fabrique(?:r|z|s)?|produis(?:-\s?moi)?|draw|generate|create|illustrate|render)\b/i;

export function looksLikeImageRequest(message: string): boolean {
  const text = message.trim();
  if (text.length < 8 || text.length > 4000) return false;
  // Question explicative (« Comment créer une image ? », « C'est quoi un
  // logo vectoriel ? ») : l'utilisateur veut une RÉPONSE, pas un visuel.
  if (/^(?:comment|pourquoi|est-ce que tu peux m'expliquer|c'est quoi|qu'est-ce qu')/i.test(text)) return false;
  const wantsGeneration = IMAGE_VERBS.test(text);
  // Action sur une image existante (analyser, supprimer, modifier…) sans
  // verbe de GÉNÉRATION explicite : ce n'est PAS une demande de création.
  // Un verbe de volonté (« je veux comprendre cette image ») ne lève PAS
  // ce garde : seul un verbe de génération peut le faire.
  if (IMAGE_NON_GENERATION_VERBS.test(text) && !IMAGE_GENERATION_VERBS.test(text)) return false;
  const nounLead = new RegExp(
    IMAGE_NOUN_LEAD.source.replace("IMAGE_NOUNS_PLACEHOLDER", IMAGE_NOUNS.source.slice(2, -2)),
    "i",
  );
  // Verbe + nom visuel (ordre quelconque) OU visuel en tête de message.
  return (wantsGeneration && IMAGE_NOUNS.test(text)) || nounLead.test(text);
}

/**
 * Ratio d'image déduit de la demande (cadrage uniquement — jamais le
 * sujet). Les mots-clés explicites (16:9, story…) priment, sinon les
 * indices de format ; défaut carré.
 */
export function detectImageRatio(message: string): ImageRatio {
  const lower = message.toLowerCase();
  const explicit = lower.match(/\b(16:9|9:16|4:3|3:4|3:2|2:3|21:9|1:1)\b/);
  if (explicit) return explicit[1] as ImageRatio;
  if (/\b(story|stories|vertical|smartphone|mobile|tiktok|reels?|9\s*\/\s*16)\b/i.test(lower)) return "9:16";
  if (/\b(paysage|horizontal|wide|banni[èe]re|bandeau|wallpaper|fond d'[éé]cran|header|couverture)\b/i.test(lower)) return "16:9";
  if (/\b(portrait|affiche|poster|flyer|carte|couverture de livre)\b/i.test(lower)) return "3:4";
  return "1:1";
}

/**
 * Extrait le prompt effectif du message utilisateur : on retire les formules
 * d'introduction (« génère-moi une image de ... », « je voudrais un dessin
 * de… », « peux-tu me faire un logo pour… ») pour laisser au modèle un
 * descriptif propre. Ne renvoie jamais une chaîne vide.
 */
export function extractImagePrompt(message: string): string {
  let prompt = message.trim();
  prompt = prompt.replace(
    /^(?:s'il\s+te\s+pla[îi]t[,]?\s*|s'il\s+vous\s+pla[îi]t[,]?\s*|stp[,]?\s*|svp[,]?\s*)?(?:peux(?:-|\s)?tu[,]?\s*|pourrais(?:-|\s)?tu[,]?\s*)?(?:(?:j'|je\s+)(?:voudrais|aimerais|souhaiterais|souhaite|veux|d[ée]sire)\s*(?:bien|vraiment)?\s*(?:que\s+tu\s+)?)?(?:me\s+)?(?:g[ée]n[èe]re(?:-|\s)?(?:moi)?|cr[ée]e(?:r|-|\s)?(?:moi)?|dessine(?:r|-|\s)?(?:moi)?|faire|fais(?:-|\s)?moi|fabrique(?:r|-|\s)?(?:moi)?|produis(?:-|\s)?moi|imagine(?:r|-|\s)?(?:moi)?|peins(?:-|\s)?(?:moi)?)?\s*(?:une?\s+|des\s+|le\s+|la\s+|l'\s*|mon\s+|ma\s+|mes\s+)?(?:belle\s+|jolie\s+|superbe\s+|très\s+r[ée]aliste\s+|ultra\s+r[ée]aliste\s+|photor[ée]aliste\s+)?(?:image(?:s)?|photo(?:s)?|photographie(?:s)?|visuel(?:s)?|illustration(?:s)?|dessin(?:s)?|paysage(?:s)?|affiche(?:s)?|logo(?:s)?|poster(?:s)?|banni[èe]re(?:s)?|ic[ôo]ne(?:s)?|avatar|fond\s+d'?[éé]cran|miniature(?:s)?|thumbnail(?:s)?|picture(?:s)?|portrait(?:s)?|artwork(?:s)?)\b\s*(?:de|du|d'|pour|sur|repr[ée]sentant|montre|montrant|avec|:)?\s*/i,
    "",
  );
  prompt = prompt.replace(
    /^(?:j'ai\s+besoin\s+d'une?\s+|j'ai\s+besoin\s+de\s+(?:une?\s+)?|j'ai\s+envie\s+d'une?\s+)?(?:image(?:s)?|photo(?:s)?|visuel(?:s)?|illustration(?:s)?|dessin(?:s)?|logo(?:s)?|affiche(?:s)?|poster(?:s)?)\b\s*(?:de|du|d'|pour|sur|:)?\s*/i,
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
  /** Garde-fou de durée propre à la surface appelante (défaut 90 s). */
  timeoutMs?: number;
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
  const timeoutMs = options.timeoutMs ?? IMAGE_TIMEOUT_MS;

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
