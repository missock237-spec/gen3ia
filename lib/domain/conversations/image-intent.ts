import type { MessageAttachment } from "./types";

/**
 * Détection d'intention « éditer une image » (étape 8 du plan 20).
 *
 * La demande porte sur une image EXISTANTE (jointe au message ou générée
 * plus tôt dans la conversation) : retouche, changement de fond, recolorisation,
 * stylisation, ajout/retrait d'éléments, agrandissement… Totalement
 * déterministe (regex FR + EN) — aucune variance LLM sur le routage.
 *
 * Différence essentielle avec la GÉNÉRATION : ici le message référence
 * l'image à modifier (« cette image », « la photo », « le logo »…) — un
 * verbe de modification seul ne suffit pas.
 */

/** Verbes/actions d'édition d'image (FR + EN). */
const EDIT_VERBS =
  /\b(modifi\w*|édit\w*|edit\w*|retouch\w*|retouches?\b|corrige\w*|amélior\w*|transform\w*|change\w*|remplac\w*|recolor\w*|recolore\w*|colori\w*|stylis\w*|stylize\w*|rend[se]?\b|met[s]?\b|supprim\w*|retir\w*|enlèv\w*|enleve\w*|ajout\w*|agrandi\w*|rédui\w*|redui\w*|redimensionn\w*|détour\w*|detour\w*|découp\w*|decoup\w*|crop\w*|resize\w*|upscale\w*|blur\w*|flout\w*|remove\w*|add\w*|make\w*|turn\w*)/i;

/** Références à une image existante (FR + EN). */
const IMAGE_REFERENCES =
  /\b(cette image|cette photo|cette illustration|cette banni[èe]re|ce logo|ce visuel|ce schéma|ce schema|cette capture|l'image|l'image g[ée]n[ée]r[ée]e|la photo|l'illustration|le logo|le visuel|l'arrière-?plan|le fond|la couleur|les couleurs|mon image|ma photo|mon logo|the image|this image|this photo|the picture|the logo|the background|the colors?|my image|my photo)\b/i;

/** Modifications ciblées parlant d'elles-mêmes même sans référence explicite. */
const TARGETED_EDITS =
  /\b(arrière-?plan|fond (blanc|noir|flou|uni)|en noir et blanc|noir et blanc|en haute définition|en 4k|en vectoriel|détour[ée]|flout\w*|pixelis\w*)\b/i;

/** Les questions explicatives ne sont pas des demandes d'édition. */
const QUESTION_PREFIX = /^(?:comment|pourquoi|est-ce que tu peux m'expliquer|c'est quoi|qu'est-ce qu')/i;

/**
 * Le message exprime-t-il une intention d'ÉDITION d'image ?
 * (verbe d'édition + référence d'image existante, ou modification ciblée
 * typique d'une retouche).
 */
export function looksLikeImageEditRequest(message: string): boolean {
  const text = message.trim();
  if (text.length < 6 || text.length > 4000) return false;
  if (QUESTION_PREFIX.test(text)) return false;
  // Une demande de CRÉATION pure (« dessine un chat », « génère un logo »)
  // reste une génération : le verbe de création prime.
  return (EDIT_VERBS.test(text) && IMAGE_REFERENCES.test(text)) || TARGETED_EDITS.test(text);
}

/** Un attachment du message est-il une image exploitable en source ? */
export function hasImageAttachment(attachments: readonly MessageAttachment[] | undefined): boolean {
  return (attachments ?? []).some((attachment) => {
    const byType = attachment.contentType?.startsWith("image/") ?? false;
    const byName = /\.(png|jpe?g|gif|webp)$/i.test(attachment.filename ?? "");
    const hasResource = Boolean(attachment.path || attachment.url);
    return (byType || byName) && hasResource;
  });
}

/**
 * Décision de routage : édition SI intention d'édition ET qu'une source est
 * plausible (image jointe au message, OU image déjà présente dans la
 * conversation — la dernière image générée/importée). Pure et testable.
 */
export function shouldRouteImageEdit(
  message: string,
  options: { hasImageAttachment: boolean; hasConversationImage: boolean },
): boolean {
  if (!looksLikeImageEditRequest(message)) return false;
  return options.hasImageAttachment || options.hasConversationImage;
}
