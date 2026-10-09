import "server-only";

import { cacheWrap } from "@/lib/cache/redis";
import { getTwinProfile } from "@/lib/identity/twin";

/**
 * Task 114-b — VOIX DU JUMEAU : résolution de l'identifiant ElevenLabs à
 * utiliser pour la synthèse vocale d'un utilisateur donné.
 *
 * Chaîne de sélection (premier résultat utilisable gagne) :
 *  1. `twinProfile.defaultVoiceProfileId` → le VoiceProfile désigné de la
 *     bibliothèque vidéo (collection videoVoices) S'IL porte un
 *     `elevenLabsVoiceId` (voix clonée ou importée) ;
 *  2. sinon le profil par défaut de l'utilisateur (`isDefault`, à défaut le
 *     premier profil) s'il porte un `elevenLabsVoiceId` ;
 *  3. sinon null → l'appelant conserve son comportement historique (voix
 *     plateforme ELEVENLABS_VOICE_ID).
 *
 * Un profil « recording » non encore cloné (pas d'elevenLabsVoiceId) n'est
 * JAMAIS retourné : il ne peut pas servir un appel TTS direct — le clonage
 * reste du ressort du pipeline vidéo (voice-service). Fail-soft total :
 * toute erreur → null (jamais une panne de voix ne casse un tool ou un
 * tour vocal). Cache mémoire 120 s (les voix changent rarement).
 */

/** TTL du cache de résolution (process-local, lib/cache/redis.ts). */
const USER_VOICE_CACHE_TTL_SECONDS = 120;

/**
 * Identifiant ElevenLabs de la voix du jumeau, ou null (voix plateforme).
 * Ne lève JAMAIS.
 */
export async function resolveUserVoiceId(userId: string): Promise<string | null> {
  try {
    const { value } = await cacheWrap(
      `g3:voice:user:${userId}`,
      USER_VOICE_CACHE_TTL_SECONDS,
      async () => await resoudreVoixUtilisateur(userId),
    );
    // "" = « aucune voix » mis en cache (cacheWrap ne stocke pas null) ;
    // null réel = panne ou absence → null.
    return value || null;
  } catch (error) {
    console.warn(
      "[user-voice] résolution de la voix du jumeau impossible — voix plateforme conservée :",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * Chaîne de sélection réelle (peut lever : les erreurs sont absorbées par
 * resolveUserVoiceId). Retourne "" quand aucune voix utilisable n'existe.
 */
async function resoudreVoixUtilisateur(userId: string): Promise<string> {
  const jumeau = await getTwinProfile(userId);

  // 1) Voix désignée par le jumeau.
  const voixDesignee = jumeau.defaultVoiceProfileId?.trim();
  if (voixDesignee) {
    // Import dynamique : la pile vidéo (voice-service) n'est chargée que
    // pour un utilisateur qui a réellement configuré une voix.
    const { getVoiceProfile } = await import("@/lib/video/voice-service");
    const voix = await getVoiceProfile(userId, voixDesignee);
    if (voix?.elevenLabsVoiceId) return voix.elevenLabsVoiceId;
  }

  // 2) Profil par défaut de l'utilisateur (isDefault, sinon premier).
  const { listVoiceProfiles } = await import("@/lib/video/voice-service");
  const voixList = await listVoiceProfiles(userId);
  const parDefaut = voixList.find((v) => v.isDefault) ?? voixList[0];
  if (parDefaut?.elevenLabsVoiceId) return parDefaut.elevenLabsVoiceId;

  // 3) Aucune voix ElevenLabs utilisable → voix plateforme.
  return "";
}
