import "server-only";

import { cacheWrap } from "@/lib/cache/redis";
import { logger } from "@/lib/observability/logger";

import { TwinProfileSchema, type TwinProfile } from "./schema";
import { getIdentitySafe, updateIdentity } from "./service";

/**
 * Task 114-b — service du « Jumeau Créatif » (profil créatif UTILISATEUR).
 *
 * Le jumeau décrit la signature créative de l'utilisateur : style
 * d'écriture, univers, valeurs, ton + sa voix (profil voix par défaut de la
 * bibliothèque vidéo). Il est stocké DANS le document d'identité R2
 * (`twinProfile`, champ privé — jamais exposé par publicIdentity) et il est
 * INJECTÉ (fail-soft) dans :
 *  - le chat des agents (lib/agents/chat-engine.ts) ;
 *  - les missions planifiées (planAgentTask + chemin universel unified-agent) ;
 *  - les prompts d'image (lib/ai/image-prompt-enhancer.ts) ;
 *  - la synthèse vocale (lib/voice/user-voice.ts → voix clonée par défaut).
 *
 * Invariants :
 *  - AUCUNE erreur twin ne casse jamais un chat, une mission ou une
 *    génération : les lectures sont fail-soft ({} / undefined) ;
 *  - les écritures valident par le schéma (refus honnête des dépassements) ;
 *  - la directive système est COMPACTE (≤ 1200 caractères) pour ne pas
 *    diluer les chartes d'agents ni gonfler les prompts image.
 */

/** TTL du cache mémoire de la directive système (panne R2 masquée 60 s). */
const TWIN_DIRECTIVE_CACHE_TTL_SECONDS = 60;

/** TTL du cache mémoire de l'extrait image (idem). */
const TWIN_IMAGE_HINT_CACHE_TTL_SECONDS = 60;

/** Longueur maximale de la directive système compilée. */
export const MAX_TWIN_DIRECTIVE_LENGTH = 1200;

/** Longueur maximale de l'extrait compact pour prompt image. */
export const MAX_TWIN_IMAGE_HINT_LENGTH = 300;

/** Budgets par section de la directive (le total reste plafonné ci-dessus). */
const DIRECTIVE_SECTION_BUDGETS = {
  writingStyle: 400,
  universe: 350,
  tone: 120,
  valueLength: 60,
  valueCount: 6,
} as const;

/**
 * Lit le profil jumeau d'un utilisateur. Ne lève JAMAIS : identité absente,
 * illisible ou stockage indisponible → profil vide ({}).
 */
export async function getTwinProfile(userId: string): Promise<TwinProfile> {
  try {
    const identity = await getIdentitySafe(userId);
    return identity?.twinProfile ?? {};
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), userId },
      "[twin] lecture du profil jumeau impossible — profil vide appliqué",
    );
    return {};
  }
}

/**
 * Met à jour le profil jumeau (fusion patch ⊕ existant, champ par champ) :
 *  - validation ZOD d'abord : les dépassements (> 2000 caractères,
 *    > 12 valeurs…) sont refusés (ZodError propagée → 422 côté route) ;
 *  - une chaîne vide (ou des espaces) signifie EFFACEMENT du champ ;
 *  - `updatedAtMs` est posé par le serveur (jamais par le client) ;
 *  - identité absente → IdentityError("not_found") propagée (404).
 */
export async function updateTwinProfile(
  userId: string,
  patch: TwinProfileInput,
): Promise<TwinProfile> {
  const parsed = TwinProfileSchema.parse(patch ?? {});

  const actuel = await getTwinProfile(userId);
  const fusionne: TwinProfile = { ...actuel };

  const appliquerTexte = (
    champ: "writingStyle" | "universe" | "tone",
    valeur: string | undefined,
  ): void => {
    if (valeur === undefined) return;
    const propre = valeur.trim();
    if (propre) fusionne[champ] = propre;
    else delete fusionne[champ]; // chaîne vide = effacement explicite
  };

  appliquerTexte("writingStyle", parsed.writingStyle);
  appliquerTexte("universe", parsed.universe);
  appliquerTexte("tone", parsed.tone);

  if (parsed.values !== undefined) {
    const valeurs = parsed.values
      .map((valeur) => valeur.trim())
      .filter((valeur) => valeur.length > 0)
      .slice(0, 12);
    if (valeurs.length > 0) fusionne.values = valeurs;
    else delete fusionne.values;
  }

  if (parsed.defaultVoiceProfileId !== undefined) {
    const propre = parsed.defaultVoiceProfileId.trim();
    if (propre) fusionne.defaultVoiceProfileId = propre;
    else delete fusionne.defaultVoiceProfileId;
  }
  if (parsed.voiceEnabled !== undefined) {
    fusionne.voiceEnabled = parsed.voiceEnabled;
  }

  fusionne.updatedAtMs = Date.now();

  await updateIdentity(userId, { twinProfile: fusionne });
  return fusionne;
}

/**
 * Compile la directive système FRANÇAISE compacte du jumeau (fonction PURE).
 * Retourne "" pour un profil vide — les appelants n'injectent alors RIEN.
 */
export function buildTwinDirective(profile: TwinProfile): string {
  const sections: string[] = [];

  const style = (profile.writingStyle ?? "").trim();
  const universe = (profile.universe ?? "").trim();
  const tone = (profile.tone ?? "").trim();
  const values = (profile.values ?? [])
    .map((valeur) => valeur.trim())
    .filter(Boolean)
    .slice(0, DIRECTIVE_SECTION_BUDGETS.valueCount);

  if (!style && !universe && !tone && values.length === 0) return "";

  if (style) {
    sections.push(`- Style d'écriture : ${style.slice(0, DIRECTIVE_SECTION_BUDGETS.writingStyle)}`);
  }
  if (universe) {
    sections.push(`- Univers : ${universe.slice(0, DIRECTIVE_SECTION_BUDGETS.universe)}`);
  }
  if (values.length > 0) {
    sections.push(
      `- Valeurs : ${values.map((valeur) => valeur.slice(0, DIRECTIVE_SECTION_BUDGETS.valueLength)).join(" ; ")}`,
    );
  }
  if (tone) {
    sections.push(`- Ton : ${tone.slice(0, DIRECTIVE_SECTION_BUDGETS.tone)}`);
  }

  return [
    "PROFIL DU JUMEAU CRÉATIF DE L'UTILISATEUR (à respecter dans tes réponses et livrables) :",
    ...sections,
  ]
    .join("\n")
    .slice(0, MAX_TWIN_DIRECTIVE_LENGTH);
}

/**
 * Extrait COMPACT pour prompts image (fonction PURE, ≤ 300 caractères) :
 * style / univers / ton uniquement — les valeurs et la voix n'ont pas de
 * sens visuel direct. Retourne "" pour un profil vide.
 */
export function buildTwinImageHint(profile: TwinProfile): string {
  const style = (profile.writingStyle ?? "").trim().slice(0, 120);
  const universe = (profile.universe ?? "").trim().slice(0, 90);
  const tone = (profile.tone ?? "").trim().slice(0, 60);
  if (!style && !universe && !tone) return "";

  const parties = [
    style ? `Style : ${style}` : "",
    universe ? `Univers : ${universe}` : "",
    tone ? `Ambiance : ${tone}` : "",
  ].filter(Boolean);

  return parties.join(" ; ").slice(0, MAX_TWIN_IMAGE_HINT_LENGTH);
}

/** Forme d'entrée acceptée par updateTwinProfile (avant parse zod). */
export type TwinProfileInput = Partial<TwinProfile>;

/**
 * Directive système du jumeau pour un utilisateur (cache mémoire 60 s).
 * Fail-soft total : "" (profil vide) et panne → undefined (rien à injecter).
 */
export async function twinDirectiveForUser(userId: string): Promise<string | undefined> {
  try {
    const { value } = await cacheWrap(
      `g3:twin:directive:${userId}`,
      TWIN_DIRECTIVE_CACHE_TTL_SECONDS,
      async () => buildTwinDirective(await getTwinProfile(userId)),
    );
    return value ? value : undefined;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), userId },
      "[twin] directive du jumeau indisponible — injection ignorée",
    );
    return undefined;
  }
}

/**
 * Extrait image du jumeau pour un utilisateur (cache mémoire 60 s).
 * Fail-soft total : panne → undefined (prompt image inchangé).
 */
export async function twinImageHintForUser(userId: string): Promise<string | undefined> {
  try {
    const { value } = await cacheWrap(
      `g3:twin:image-hint:${userId}`,
      TWIN_IMAGE_HINT_CACHE_TTL_SECONDS,
      async () => buildTwinImageHint(await getTwinProfile(userId)),
    );
    return value ? value : undefined;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), userId },
      "[twin] extrait image du jumeau indisponible — prompt inchangé",
    );
    return undefined;
  }
}
