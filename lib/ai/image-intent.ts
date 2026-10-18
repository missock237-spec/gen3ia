/**
 * DÉTECTION D'INTENTION VISUELLE — module PUR extrait de l'ancienne
 * couche de génération d'images (lib/ai/image-generation.ts, supprimée
 * avec les IA externes).
 *
 * Toutes les fonctions ici sont déterministes, gratuites et sans appel
 * réseau : elles servent à orienter une demande utilisateur vers
 * l'effecteur visuel NEURONAL Gen3 (lib/neural/effecteurs/visual.ts)
 * quand le moteur reconnaît une intention de création graphique.
 *
 * Aucune dépendance Node — utilisable côté serveur comme côté client.
 */

/** Ratios visuels supportés par l'effecteur neuronal. */
export const IMAGE_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"] as const;

export type ImageRatio = (typeof IMAGE_RATIOS)[number];

/* FRONTIÈRES UNICODE : `\b`/`\w` ASCII ne connaissent PAS « é » —
 * « Créé une image », « généré une image » échoueraient sur le `\b`
 * final. Garde-fous \p{L}/\p{N} (flag `u`) + stems unicode. */
const IMAGE_U_START = "(?<![\\p{L}\\p{N}_])";
const IMAGE_U_END = "(?![\\p{L}\\p{N}_])";

const IMAGE_VERBS = new RegExp(
  `${IMAGE_U_START}(?:g[éeè]n[éeè]r\\p{L}*|dessin\\p{L}*|cr[ée]\\p{L}*|fais(?:-|\\s)?moi|faisons|faire|fabriqu\\p{L}*|produis(?:-|\\s)?moi|imagin\\p{L}*|peins(?:-|\\s)?(?:moi)?|veux|voudrais|aimerais|souhait\\p{L}*|besoin|render|generate|generating|create|draw|make|produce|design|illustrate)${IMAGE_U_END}`,
  "iu",
);

const IMAGE_NOUNS = new RegExp(
  `${IMAGE_U_START}(?:image|images|photo|photos|photographie|visuel|visuels|logo|logos|illustration|illustrations|dessin|dessins|paysage|paysages|affiche|affiches|poster|posters|banni[èe]re|banni[èe]res|banner|banners|bandeaux?|flyer|flyers|ic[ôo]ne|ic[ôo]nes|icone|icon|icons|avatar|avatars|fond d'[éé]cran|wallpaper|wallpapers|thumbnail|thumbnails|miniature|miniatures|sticker|stickers|picture|pictures|portrait|artwork|tableau|couverture|cover|covers|mockup|mockups|sketch|sketches|rendu|rendus|banni[èe]re publicitaire|image de couverture)${IMAGE_U_END}`,
  "iu",
);

/**
 * Vraies questions méta : l'utilisateur demande une EXPLICATION ou une
 * définition, pas la production d'un visuel. Détectées par un marqueur
 * interrogatif EN TÊTE de message (français ET anglais).
 */
const META_QUESTION_RE =
  /^\s*(?:c['’]est quoi|qu['’]est-ce|qu['’]est ce|que\b|quoi\b|pourquoi|comment|qui\b|où\b|quand\b|quel(?:le|s)?\b|combien\b|est-ce que tu (?:peux|pourrais)\s+(?:m['’]|me\s+)?expliquer|what|why|how|who|where|which)\b/i;

function isMetaQuestion(text: string): boolean {
  return META_QUESTION_RE.test(text);
}

/** Message qui COMMENCE par un nom visuel précédé d'un déterminant. */
const IMAGE_NOUN_LEAD =
  /^\s*(?:une?|des|les|le|la|mon|ma|mes|ton|ta|tes|ce|cette)\s+(?:IMAGE_NOUNS_PLACEHOLDER)/i;

/** Verbes d'analyse/édition : l'utilisateur agit sur une image EXISTANTE. */
const IMAGE_NON_GENERATION_VERBS =
  /\b(analys\w*|expliqu\w*|comprends?|comprendre|interpr[èe]t\w*|d[ée]cris|d[ée]crire|examin\w*|identifi\w*|ouvre[rz]?|ouvrir|t[ée]l[ée]charg\w*|supprim\w*|modifi\w*|renomme[rz]?|partag\w*|envoy\w*|ins[èe]r\w*|ajout\w*|retouch\w*|rogne[rz]?|redimensionn\w*)\b/i;

/** Verbes de GÉNÉRATION explicites (lèvent le garde d'analyse/édition). */
const IMAGE_GENERATION_VERBS = new RegExp(
  `${IMAGE_U_START}(?:g[éeè]n[éeè]r\\p{L}*|dessin\\p{L}*|peins?(?:-\\s?moi)?|imagin\\p{L}*|cr[ée]\\p{L}*|fabriqu\\p{L}*|produis(?:-\\s?moi)?|draw|generate|create|illustrate|render)${IMAGE_U_END}`,
  "iu",
);

/**
 * Détection déterministe d'intention « générer une image » : un verbe
 * d'action + un nom d'objet visuel, en français ou en anglais.
 */
export function looksLikeImageRequest(message: string): boolean {
  const text = message.trim();
  if (text.length > 4000) return false;
  if (isMetaQuestion(text)) return false;
  if (EXPLICIT_DRAWING_VERBS.test(text)) return true;
  const wantsGeneration = IMAGE_VERBS.test(text);
  if (IMAGE_NON_GENERATION_VERBS.test(text) && !IMAGE_GENERATION_VERBS.test(text)) return false;
  const nounLead = new RegExp(
    IMAGE_NOUN_LEAD.source.replace(
      "IMAGE_NOUNS_PLACEHOLDER",
      IMAGE_NOUNS.source.replace(/^.*?\(\?:/, "").replace(/\)$/, ""),
    ),
    "i",
  );
  return (wantsGeneration && IMAGE_NOUNS.test(text)) || nounLead.test(text);
}

/**
 * Verbes de dessin/peinture EXPLICITES : ils signifient par eux-mêmes
 * « produire un visuel », même sans nom visuel dans la phrase.
 */
const EXPLICIT_DRAWING_VERBS =
  /\b(dessin(?:e[rz]?|es|er)\b|peins\b|peindre\b|draw\b|paint\b|sketch\b)/i;

/** Garde complémentaire : un verbe de dessin explicite suffit. */
export function looksLikeExplicitDrawingRequest(message: string): boolean {
  const text = message.trim();
  if (text.length > 4000) return false;
  if (isMetaQuestion(text)) return false;
  return EXPLICIT_DRAWING_VERBS.test(text);
}

/** Ratio d'image déduit de la demande (cadrage uniquement). */
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
 * Extrait le prompt effectif du message utilisateur : on retire les
 * formules d'introduction pour laisser à l'effecteur neuronal un
 * descriptif propre. Ne renvoie jamais une chaîne vide.
 */
export function extractImagePrompt(message: string): string {
  let prompt = message.trim();
  prompt = prompt.replace(
    /^(?:s'il\s+te\s+pla[îi]t[,]?\s*|s'il\s+vous\s+pla[îi]t[,]?\s*|stp[,]?\s*|svp[,]?\s*)?(?:peux(?:-|\s)?tu[,]?\s*|pourrais(?:-|\s)?tu[,]?\s*)?(?:(?:j'|je\s+)(?:voudrais|aimerais|souhaiterais|souhaite|veux|d[ée]sire)\s*(?:bien|vraiment)?\s*(?:que\s+tu\s+)?)?(?:me\s+)?(?:g[ée]n[èe]re(?:-|\s)?(?:moi)?|cr[ée]e(?:r|-|\s)?(?:moi)?|dessine(?:r|-|\s)?(?:moi)?|faire|fais(?:-|\s)?moi|fabrique(?:r|-|\s)?(?:moi)?|produis(?:-|\s)?(?:moi)?|imagine(?:r|-|\s)?(?:moi)?|peins(?:-|\s)?(?:moi)?)?\s*(?:une?\s+|des\s+|le\s+|la\s+|l'\s*|mon\s+|ma\s+|mes\s+)?(?:belle\s+|jolie\s+|superbe\s+|très\s+r[ée]aliste\s+|ultra\s+r[ée]aliste\s+|photor[ée]aliste\s+)?(?:image(?:s)?|photo(?:s)?|photographie(?:s)?|visuel(?:s)?|illustration(?:s)?|dessin(?:s)?|paysage(?:s)?|affiche(?:s)?|logo(?:s)?|poster(?:s)?|banni[èe]re(?:s)?|ic[ôo]ne(?:s)?|avatar|fond\s+d'?[éé]cran|miniature(?:s)?|thumbnail(?:s)?|picture(?:s)?|portrait(?:s)?|artwork(?:s)?)\b\s*(?:de|du|d'|pour|sur|repr[ée]sentant|montre|montrant|avec|:)?\s*/i,
    "",
  );
  prompt = prompt.replace(
    /^(?:j'ai\s+besoin\s+d'une?\s+|j'ai\s+besoin\s+de\s+(?:une?\s+)?|j'ai\s+envie\s+d'une?\s+)?(?:image(?:s)?|photo(?:s)?|visuel(?:s)?|illustration(?:s)?|dessin(?:s)?|logo(?:s)?|affiche(?:s)?|poster(?:s)?)\b\s*(?:de|du|d'|pour|sur|:)?\s*/i,
    "",
  );
  return prompt.trim() || message.trim();
}

/**
 * Compétence de brief visuel : transforme une demande courte en brief
 * exploitable par l'effecteur neuronal, sans changer l'intention.
 */
export function enhanceImagePrompt(message: string): string {
  const subject = extractImagePrompt(message).replace(/\s+/g, " ").trim();
  const quality = "composition équilibrée, harmonie chromatique, dynamique neuronale lisible";
  const constraints = "respecter strictement le sujet demandé, ne rien ajouter d'inutile";
  return `${subject}. ${quality}. ${constraints}.`.slice(0, 4000);
}
