import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import {
  DUREE_MAX_S,
  DUREE_MIN_S,
  appliquerModulations,
  idsStylesMusique,
  parseStyleMusique,
  styleParId,
} from "@/lib/media/musique/styles";
import { composerMusique } from "@/lib/media/musique/composition";
import { synthetiserMusique } from "@/lib/media/musique/synthese";
import { persistGeneratedBuffer } from "@/lib/media/persist";
import { urlDurableAbsolue } from "@/lib/media/url-durable";

/**
 * Outil musique.creer — VRAIE MUSIQUE GÉNÉRÉE, LIVRÉE DANS LA CONVERSATION.
 *
 * Mission propriétaire gen3ia (Task 2-a AUDIO) : « crée une musique de
 * 2 min » doit livrer un VRAI fichier audio de ~120 s — pas une nappe
 * muette déguisée en musique, pas un faux succès.
 *
 * CHAÎNE RÉELLE : parseStyleMusique (français naturel : style, durée
 * « 2 min » / « 90 secondes », humeur, tempo, instruments) → composerMusique
 * (composition algorithmique DÉTERMINISTE — graine = hash de la demande ;
 * accords, mélodie, basse, percussions légères, structure
 * intro/couplet/refrain/outro ; PCM 44 100 Hz stéréo 16 bits, Node pur) →
 * synthetiserMusique (WAV natif toujours possible ; MP3 FFmpeg quand le
 * binaire existe — repli WAV honnête signalé) → persistance PERMANENTE R2
 * (même convention que le chat : users/<uid>/permanent/musique/…, clé
 * DÉTERMINISTE de contenu : même demande = mêmes octets = même objet) →
 * ecouterUrl DURABLE (/api/media/durable?path=…, re-signé à chaque
 * résolution — le message persisté reste jouable).
 *
 * HONNÊTETÉ (jamais de faux succès) :
 *  - une composition muette (RMS ≈ 0) JETTE — jamais de « silence de 2 min »
 *    livré comme de la musique ;
 *  - ni archivage permanent ni envoi inline possible → ÉCHEC nommé (R2 non
 *    configuré + fichier trop volumineux), avec la marche à suivre ;
 *  - la note rappelle que c'est une composition ALGORITHMIQUE instrumentale
 *    (pas un modèle génératif type Suno, pas de chant).
 */

const MusiqueCreerInput = z.object({
  demande: z.string().min(5).max(600).describe(
    "La demande musicale de l'utilisateur EN FRANÇAIS NATUREL, texte brut : " +
      "« crée une musique de 2 min », « une musique calme au piano de 90 secondes », " +
      "« un morceau lofi détendu ». Style, durée (« 2 min », « 90 secondes »), humeur, " +
      "tempo (« 120 bpm ») et instruments cités sont extraits automatiquement.",
  ),
  dureeSecondes: z.number().int().min(30).max(300).optional().describe(
    "Durée cible en secondes (30–300). Facultatif : par défaut la durée citée " +
      "dans la demande (« 2 min » → 120 s), sinon 120 s.",
  ),
  style: z.string().max(40).optional().describe(
    "Id de style imposé parmi : " + idsStylesMusique().join(", ") +
      ". Facultatif : par défaut le style détecté dans la demande (sinon pop).",
  ),
});

/** Sortie typée — contrat stable pour les planners et la livraison chat. */
export interface MusiqueCreerOutput {
  /** Clé R2 PERMANENTE (users/<uid>/permanent/musique/…) quand archivé. */
  url?: string;
  /** "r2" = archivage permanent réussi ; "inline" = data URI (fichier borné). */
  storage: "r2" | "inline";
  /** Lien d'écoute DURABLE (route canonique re-signée ; data URI en inline). */
  ecouterUrl: string;
  /** Data URI jouable (repli inline uniquement — jamais de fichier géant). */
  audioDataUri?: string;
  mimeType: "audio/mpeg" | "audio/wav";
  /** Durée RÉELLE mesurée sur les échantillons PCM (à l'image près). */
  dureeReelle: number;
  /** Durée cible retenue après analyse de la demande. */
  dureeDemandee: number;
  /** Durée explicitement citée par l'utilisateur ? */
  dureeDetectee: boolean;
  style: string;
  styleLabel: string;
  humeur: string;
  tempoBpm: number;
  /** Premiers accords de la progression (transparence musicale). */
  accords: string[];
  /** Graine déterministe (hash de la demande). */
  seed: string;
  tailleOctets: number;
  nomFichier: string;
  /** Conteneur réel : MP3 (FFmpeg) ou WAV natif. */
  moteur: string;
  note: string;
}

/** Plafond du repli inline (data URI dans la réponse JSON du tool). */
const INLINE_MAX_OCTETS = 2_800_000;

/**
 * Clé permanente DÉTERMINISTE : même demande + style + durée + conteneur →
 * même objet R2 (cache de contenu idempotent — regénérer n'accumule pas de
 * doublons). Le seed (hash de la demande) garantit l'unicité inter-styles.
 */
function cleContenuMusique(params: {
  userId: string;
  seed: string;
  styleId: string;
  tempoBpm: number;
  dureeSecondes: number;
  extension: "mp3" | "wav";
}): string {
  return (
    `users/${params.userId}/permanent/musique/` +
    `${params.styleId}-${params.seed}-${Math.round(params.dureeSecondes)}s-${params.tempoBpm}bpm-${params.extension === "mp3" ? "160k" : "pcm16"}.${params.extension}`
  );
}

export const musiqueCreerTool: ToolDefinition<
  z.infer<typeof MusiqueCreerInput>,
  MusiqueCreerOutput
> = {
  id: "musique.creer",
  name: "musique.creer",
  description:
    "Compose une VRAIE MUSIQUE instrumentale à partir de la demande utilisateur en français " +
    "naturel (« crée une musique de 2 min », « une musique calme au piano de 90 secondes ») et " +
    "livre un fichier audio JOUABLE : styles lofi/pop/cinématique/électronique/acoustique/jazz/" +
    "ambient/rock/classique (tempo, gamme, progression d'accords, timbres, percussions), durée " +
    "30–300 s extraite de la demande (« 2 min » → 120 s), composition déterministe (accords, " +
    "mélodie, basse, percussions, intro/couplet/refrain/outro), rendu 44 100 Hz stéréo — MP3 " +
    "via FFmpeg quand disponible, sinon WAV natif jouable — archivé en PERMANENCE (lien durable). " +
    "Honnête : c'est une composition algorithmique, pas du chant ; une demande hors bornes est " +
    "bornée et signalée ; aucun faux succès (musique muette ou illivrable = échec nommé).",
  category: "media",
  risk: "low",
  inputSchema: MusiqueCreerInput,
  async execute(input, context): Promise<MusiqueCreerOutput> {
    // ── 1) ANALYSE de la demande (style/durée/humeur/tempo/instruments) ──
    const parsee = parseStyleMusique(input.demande);

    // Style imposé explicitement : doit exister (aucun style fantôme) — les
    // nuances de la demande (humeur, instruments, tempo cité) restent appliquées.
    if (input.style !== undefined) {
      const baseImposee = styleParId(input.style);
      if (!baseImposee) {
        throw new Error(
          `Style « ${input.style} » inconnu — styles disponibles : ${idsStylesMusique().join(", ")}.`,
        );
      }
      const modulations = appliquerModulations(baseImposee, input.demande);
      parsee.style = modulations.style;
      parsee.humeur = modulations.humeur;
    }

    // Durée : paramètre explicite > durée citée dans la demande > défaut 120 s.
    const dureeDemandee = input.dureeSecondes ?? parsee.dureeSecondes;

    // ── 2) COMPOSITION déterministe (graine = hash de la demande) ──
    const composition = composerMusique({
      demande: input.demande,
      dureeSecondes: dureeDemandee,
      style: parsee.style,
    });

    // ── 3) SYNTHÈSE du conteneur (MP3 FFmpeg si dispo, sinon WAV natif) ──
    const rendu = await synthetiserMusique({
      pcm: composition.pcm,
      frequence: composition.frequence,
      canaux: composition.canaux,
      titre: `Musique ${parsee.style.label} gen3ia (${Math.round(composition.dureeSecondes)}s)`,
    });

    // ── 4) PERSISTANCE PERMANENTE (clé de contenu déterministe) ──
    // Repli inline borné : un data URI de plusieurs dizaines de Mo n'a pas
    // sa place dans une réponse JSON — au-delà, échec honnête ci-dessous.
    const inlinePossible = rendu.buffer.length <= INLINE_MAX_OCTETS;
    const persistance = await persistGeneratedBuffer({
      userId: context.userId,
      buffer: rendu.buffer,
      contentType: rendu.mime,
      prefix: "musique",
      fixedKey: cleContenuMusique({
        userId: context.userId,
        seed: composition.seed,
        styleId: parsee.style.id,
        tempoBpm: composition.tempoBpm,
        dureeSecondes: composition.dureeSecondes,
        extension: rendu.extension,
      }),
      ...(inlinePossible
        ? { fallbackUrl: `data:${rendu.mime};base64,${rendu.buffer.toString("base64")}` }
        : {}),
    });

    const estPermanent = persistance.storage === "r2" && typeof persistance.storagePath === "string";
    const dataUri = !estPermanent && inlinePossible ? persistance.url : undefined;
    if (!estPermanent && !dataUri) {
      // HONNÊTETÉ : ni R2 ni inline possible — jamais de faux succès.
      throw new Error(
        `Musique ${Math.round(composition.dureeSecondes)}s composée (${rendu.buffer.length} octets) mais illivrable : ` +
          "le stockage permanent (R2) n'est pas configuré et le fichier dépasse le plafond " +
          "inline. Configurez R2 (ou installez FFmpeg pour un MP3 compact) puis réessayez.",
      );
    }

    // ── 5) LIEN DURABLE (re-signé à chaque résolution — message persisté) ──
    const ecouterUrl = estPermanent && persistance.storagePath
      ? (urlDurableAbsolue(persistance.storagePath) ?? persistance.url)
      : (dataUri ?? persistance.url);

    const nomFichier = `musique-${parsee.style.id}-${Math.round(composition.dureeSecondes)}s.${rendu.extension}`;
    const accordsVisibles = composition.accords.slice(0, 8).join(" · ");
    const note =
      `VRAIE MUSIQUE composée ALGORITHMIQUEMENT (moteur gen3 local, déterministe seed=${composition.seed}) : ` +
      `style ${parsee.style.label}, tempo ${composition.tempoBpm} bpm, humeur ${parsee.humeur}, ` +
      `accords ${accordsVisibles}, structure ${composition.structure.map((s) => s.nom).join(" → ")}. ` +
      `Durée réelle mesurée : ${composition.dureeSecondes}s (demande : ${dureeDemandee}s${parsee.dureeDetectee ? " détectée dans le texte" : ", défaut"}). ` +
      `Conteneur : ${rendu.mime} (${rendu.moteur}${rendu.diagnostic ? ` — repli : ${rendu.diagnostic}` : ""}). ` +
      "Limite honnête : composition instrumentale générative — pas un modèle type Suno, sans chant ni voix." +
      (estPermanent ? " Archivage permanent R2, lien durable re-signé." : " Livré inline (data URI).");

    return {
      ...(estPermanent ? { url: persistance.storagePath } : {}),
      storage: estPermanent ? "r2" : "inline",
      ecouterUrl,
      ...(dataUri ? { audioDataUri: dataUri } : {}),
      mimeType: rendu.mime,
      dureeReelle: composition.dureeSecondes,
      dureeDemandee,
      dureeDetectee: parsee.dureeDetectee,
      style: parsee.style.id,
      styleLabel: parsee.style.label,
      humeur: parsee.humeur,
      tempoBpm: composition.tempoBpm,
      accords: composition.accords.slice(0, 8),
      seed: composition.seed,
      tailleOctets: rendu.buffer.length,
      nomFichier,
      moteur: rendu.moteur,
      note,
    };
  },
};

// Bornes réexportées pour la documentation du planner (source unique).
export const BORNES_DUREE_MUSIQUE = { min: DUREE_MIN_S, max: DUREE_MAX_S } as const;
