import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import { genererAudioNeuralEtPersister } from "@/lib/neural/media-service";
import { VOIX_PROFESSEUR, estVoixEspace, choisirVoixSelonPersonnage } from "@/lib/neural/professeur-media";

/**
 * Outil voice.speak — SYNTHÈSE VOCALE PARLÉE RÉELLE (deux modes honnêtes).
 *
 * Rend réel le contrat annoncé depuis longtemps au planificateur
 * (unified-agent AUDIO RULE, catalogue conversationnel) : l'outil
 * voice.speak était PROMIS mais aucun exécuteur n'existait — toute étape
 * planifiée échouait « Unknown tool: voice.speak » (audit multimodal).
 *
 * MODE 1 — VOIX HUMAINE RÉELLE (par défaut dès que le professeur média
 * est configuré, loi CONTRAINTE-ONDES) : le texte part vers le TTS réel
 * du professeur — voix humaine naturelle, choisie dans le roster
 * documenté (VOIX_PROFESSEUR : tongtong, chuichui, xiaochen, jam, kazi,
 * douji, luodo), vitesse réglable 0.5–2. Chaque œuvre porte la mention
 * honnête `echafaudage: true` (échafaudage supprimable : le signal
 * d'onde gen3 prendra le relais après distillation).
 *
 * MODE 2 — REPLI LOCAL HONNÊTE (professeur absent) : composition
 * harmonique neuronale déterministe (mêmes moteurs que les signaux audio
 * du corps sémantique) — rythme et tons dérivés du texte. CE N'EST PAS de
 * la parole humaine naturelle ; la note du résultat le dit alors
 * explicitement, pour que ni le planner ni l'utilisateur ne soient trompés.
 *
 * Sortie compatible avec le contrat artefact du moteur conversationnel
 * (lib/domain/conversations/engine.ts) :
 *  - `url` = clé R2 PERMANENTE (users/<uid>/permanent/…) réutilisée
 *    telle quelle comme storagePath de l'artefact (Task 113) ;
 *  - `audioDataUri` = repli inline quand R2 est indisponible.
 */

const VoiceSpeakInput = z.object({
  text: z.string().min(1).max(4000).describe(
    "Le texte EXACT source de la synthèse (fidèle à la demande utilisateur).",
  ),
  dureeSecondes: z.number().int().min(1).max(30).optional().describe(
    "Durée souhaitée en secondes (défaut dérivé du texte, borné 4–30 s). " +
      "Mode voix humaine réelle : la durée suit le texte (ce paramètre est indicatif).",
  ),
  voix: z.string().optional().refine(
    (v) => v === undefined || (VOIX_PROFESSEUR as readonly string[]).includes(v) || estVoixEspace(v),
    { message: "Voix inconnue — rosters admis : passerelle (tongtong, chuichui, xiaochen, jam, kazi, douji, luodo) et espace public Edge-TTS (fr-FR-DeniseNeural, fr-FR-HenriNeural…)." },
  ).describe(
    "Voix humaine du mode voix réelle. Défaut : selon le PERSONNAGE décrit dans le texte " +
      "(« une femme… » → Denise, « un homme… » → Henri). Rosters : passerelle " +
      "(tongtong, chuichui, xiaochen, jam, kazi, douji, luodo) et espace public Edge-TTS " +
      "(13 voix françaises : Denise, Éloïse, Vivienne, Henri, Rémy + variantes BE/CA/CH).",
  ),
  vitesse: z.number().min(0.5).max(2).optional().describe(
    "Vitesse de parole en mode voix humaine réelle (0.5 = lent, 2 = rapide, défaut 1).",
  ),
});

/** Sortie typée de l'outil (contrat stable pour les planners). */
interface VoiceSpeakToolOutput {
  /** Clé R2 permanente (users/<uid>/permanent/ai-audio/…) quand archivé. */
  url?: string;
  /** "r2" = archivé en permanence ; "inline" = repli data URI. */
  storage: "r2" | "inline";
  /** Data URI audio (repli inline uniquement). */
  audioDataUri?: string;
  /** URL signée d'écoute immédiate (expire — le handle durable est url). */
  ecouterUrl: string;
  mimeType: "audio/wav" | "audio/mpeg";
  dureeSecondes: number;
  moteur: string;
  /** Note d'honnêteté : mode voix humaine réelle vs repli local. */
  note: string;
}

/** Durée par défaut dérivée du texte (≈ 0,45 s/mot, bornée 4–30 s). */
export function dureeDuTexte(texte: string): number {
  const mots = texte.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(4, Math.min(30, Math.round(mots * 0.45) || 6));
}

export const voiceSpeakTool: ToolDefinition<
  z.infer<typeof VoiceSpeakInput>,
  VoiceSpeakToolOutput
> = {
  id: "voice.speak",
  name: "voice.speak",
  description:
    "Synthétise un AUDIO PARLÉ à partir d'un texte. VOIX HUMAINE RÉELLE via le professeur média " +
    "temporaire quand il est configuré (loi CONTRAINTE-ONDES) : voix féminine/masculine selon le " +
    "personnage (Denise/Henri — espace public Edge-TTS ; roster passerelle : tongtong, chuichui, " +
    "xiaochen, jam, kazi, douji, luodo), vitesse 0.5–2, archivage permanent. " +
    "Repli local honnête quand le professeur est absent : composition harmonique neuronale " +
    "déterministe — ce n'est PAS de la parole, et le résultat le signale.",
  category: "media",
  risk: "low",
  inputSchema: VoiceSpeakInput,
  async execute(input, context): Promise<VoiceSpeakToolOutput> {
    // Défaut INTELLIGENT : la voix suit le personnage décrit dans le texte
    // (féminine/masculine, déterministe) quand aucune voix n'est imposée.
    const voixRésolue = input.voix ?? choisirVoixSelonPersonnage(input.text).voixEspace;
    const rendu = await genererAudioNeuralEtPersister({
      userId: context.userId,
      prompt: input.text.trim(),
      dureeSecondes: input.dureeSecondes ?? dureeDuTexte(input.text),
      frequenceEchantillonnage: 22050,
      voix: voixRésolue,
      ...(input.vitesse !== undefined ? { vitesse: input.vitesse } : {}),
    });

    const estPermanent = rendu.storage === "r2" && typeof rendu.cleStockage === "string";
    const estProfesseur = rendu.meta?.echafaudage === true;
    const voixUtilisée = typeof rendu.meta?.voix === "string" ? rendu.meta.voix : null;
    // LIVRAISON DURABLE (2026-11-12) : le texte final du planner cite
    // ecouterUrl — s'il était présigné (TTL 1 h), le lien du message
    // persisté mourrait (« l'audio n'est pas réellement envoyé »). Quand la
    // clé permanente existe, ecouterUrl = URL canonique re-signée à chaque
    // résolution ; repli : présignée d'origine (jamais de perte).
    const { urlDurableAbsolue } = await import("@/lib/media/url-durable");
    const ecouter =
      estPermanent && rendu.cleStockage ? (urlDurableAbsolue(rendu.cleStockage) ?? rendu.url) : rendu.url;
    return {
      // Contrat artefact : `url` = clé permanente résolvable (Task 113).
      ...(estPermanent ? { url: rendu.cleStockage } : {}),
      storage: rendu.storage,
      // Repli inline : data URI lisible par le lecteur embarqué (bornée).
      ...(rendu.storage === "inline" ? { audioDataUri: rendu.url } : {}),
      ecouterUrl: ecouter,
      mimeType: rendu.mime === "audio/mpeg" ? "audio/mpeg" : "audio/wav",
      dureeSecondes: typeof rendu.meta.duree === "number" ? rendu.meta.duree : 0,
      moteur: String(rendu.meta.moteur ?? "gen3-snn-audio-v1"),
      note: estProfesseur
        ? "Voix humaine RÉELLE générée par le professeur média temporaire (loi CONTRAINTE-ONDES — échafaudage supprimable ; le signal d'onde gen3 prendra le relais après distillation)." +
          (voixUtilisée ? ` Voix utilisée : ${voixUtilisée}.` : "")
        : "Audio synthétisé localement par le moteur neuronal Gen3 (composition harmonique dérivée du texte). " +
          "Ce rendu n'est pas une parole humaine naturelle — le professeur média n'est pas configuré, " +
          "aucune synthèse vocale parlée n'est disponible dans ce mode.",
    };
  },
};
