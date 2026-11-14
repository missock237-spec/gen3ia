import { z } from "zod";
import type { ToolDefinition } from "@/lib/tools/types";
import {
  appliquerModulations,
  idsStylesMusique,
  parseStyleMusique,
  styleParId,
} from "@/lib/media/musique/styles";
import { composerMusique } from "@/lib/media/musique/composition";
import { synthetiserMusique } from "@/lib/media/musique/synthese";
import {
  extraireTitreChanson,
  inventerTitreChanson,
  ecrireParolesChanson,
} from "@/lib/media/musique/paroles";
import {
  FREQUENCE_CHANSON,
  demandeClipMusical,
  decoderVoixPcm,
  mixerChanson,
  planChant,
  produireClipMusical,
  voixChanson,
  type SegmentVoix,
} from "@/lib/media/musique/chanson";
import { persistGeneratedBuffer } from "@/lib/media/persist";
import { urlDurableAbsolue } from "@/lib/media/url-durable";
import { createHash } from "node:crypto";

/**
 * Outil musique.chanson — CHANSON COMPLÈTE avec TITRE, PAROLES et VOIX
 * HUMAINE (exigence utilisateur 2026-11-14).
 *
 * CONTRAT PROPRIÉTAIRE :
 *  - titre CITÉ par l'utilisateur → détecté et respecté ;
 *  - titre absent → gen3 invente un titre à partir du thème ;
 *  - PAROLES écrites SUR CE TITRE (moteur gen3, repli déterministe honnête) ;
 *  - AUDIO réellement produit : voix humaine (cascade TTS réelle) qui
 *    déclame les paroles SUR l'accompagnement instrumental (composition
 *    déterministe, ducking sous la voix) — MP3/WAV jouable, lien durable.
 *  - VIDÉO MUSICALE SEULEMENT si demandée (« clip », « vidéo musicale ») :
 *    diaporama FFmpeg réel muxé avec le son de la chanson. PAR DÉFAUT :
 *    AUDIO SEUL.
 *
 * HONNÊTETÉ : la voix DÉCLAME (TTS humain réel) — pas un modèle de chant
 * type Suno ; la source des paroles (moteur gen3 ou repli) est rapportée.
 */

const MusiqueChansonInput = z.object({
  demande: z.string().min(5).max(600).describe(
    "La demande musicale de l'utilisateur EN FRANÇAIS NATUREL, texte brut : " +
      "« crée une chanson sur le thème de la mer », « une musique dont le titre est « Étoiles » », " +
      "« une chanson intitulée « Promesse » style pop ». Titre cité, style, durée, humeur sont détectés.",
  ),
  dureeSecondes: z.number().int().min(45).max(300).optional().describe(
    "Durée cible en secondes (45–300). Facultatif : par défaut la durée citée, sinon 90 s (une chanson).",
  ),
  style: z.string().max(40).optional().describe(
    "Id de style imposé parmi : " + idsStylesMusique().join(", ") + ". Facultatif.",
  ),
  /** Override de la détection vidéo (les planners peuvent forcer). */
  clipMusical: z.boolean().optional().describe(
    "TRUE pour livrer AUSSI un clip musical MP4 (par défaut : détecté dans la demande).",
  ),
  /** Demande explicite d'une chanson INSTRUMENTALE (sans voix). */
  instrumentale: z.boolean().optional().describe(
    "TRUE pour composer la chanson SANS voix (instrumental titré, sans paroles).",
  ),
});

/** Sortie typée — contrat stable pour les planners et la livraison chat. */
export interface MusiqueChansonOutput {
  titre: string;
  /** Le titre était CITÉ par l'utilisateur ? */
  titreDetecte: boolean;
  paroles: {
    intro: string[];
    couplets: string[][];
    refrain: string[];
    outro: string[];
    source: "moteur-gen3" | "repli-deterministe";
  };
  storage: "r2" | "inline";
  /** Clé R2 permanente de l'audio (users/<uid>/permanent/musique/…). */
  url?: string;
  ecouterUrl: string;
  mimeType: "audio/mpeg" | "audio/wav";
  dureeReelle: number;
  style: string;
  styleLabel: string;
  humeur: string;
  /** Segments de chant réellement posés (sections + durées de voix). */
  chant: Array<{ nom: string; debutSec: number; dureeVoixSec: number; voix: string }>;
  /** Clip musical MP4 livré AUSSI ? (vidéo demandée seulement) */
  clip?: {
    storage: "r2" | "inline";
    url?: string;
    ecouterUrl: string;
    plans: number;
    tailleOctets: number;
  };
  tailleOctets: number;
  nomFichier: string;
  moteurVoix: string;
  note: string;
}

/** Clé permanente déterministe (titre + paroles + composition). */
function cleChanson(params: {
  userId: string;
  empreinte: string;
  styleId: string;
  dureeSecondes: number;
  extension: "mp3" | "wav";
}): string {
  return (
    `users/${params.userId}/permanent/musique/chansons/` +
    `${params.styleId}-${params.empreinte}-${Math.round(params.dureeSecondes)}s-${params.extension === "mp3" ? "192k" : "pcm16"}.${params.extension}`
  );
}

export const musiqueChansonTool: ToolDefinition<
  z.infer<typeof MusiqueChansonInput>,
  MusiqueChansonOutput
> = {
  id: "musique.chanson",
  name: "musique.chanson",
  description:
    "Crée une VRAIE CHANSON : le titre cité par l'utilisateur est détecté (« dont le titre est », « intitulée », « appelée »…), " +
    "sinon gen3 invente un titre à partir du thème ; les PAROLES sont écrites sur ce titre (intro, couplets, refrain, outro) ; " +
    "l'AUDIO est produit avec une VOIX HUMAINE réelle qui déclame les paroles sur l'accompagnement musical (ducking), en MP3/WAV " +
    "archivé en permanence (lien durable). Un CLIP MUSICAL MP4 n'est produit que si la demande le précise (« clip », « vidéo musicale ») ; " +
    "PAR DÉFAUT l'audio seul est livré. Honnête : la voix déclame (TTS réel), la source des paroles est rapportée, " +
    "les demandes d'instrumental pur restent sur musique.creer.",
  category: "media",
  risk: "low",
  inputSchema: MusiqueChansonInput,
  async execute(input, context): Promise<MusiqueChansonOutput> {
    // ── 1) STYLE/HUMEUR (analyse déterministe existante) ──
    const parsee = parseStyleMusique(input.demande);
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
    const dureeDemandee = input.dureeSecondes ?? parsee.dureeSecondes ?? 90;

    // ── 2) TITRE : CITÉ → détecté ; sinon → INVENTÉ par gen3 ──
    const titreDetecte = extraireTitreChanson(input.demande);
    const titre = titreDetecte ?? inventerTitreChanson(input.demande);

    // ── 3) PAROLES écrites SUR ce titre (moteur gen3 + repli honnête) ──
    const paroles = input.instrumentale
      ? { titre, intro: [], couplets: [], refrain: [], outro: [], source: "repli-deterministe" as const }
      : await ecrireParolesChanson({ titre, demande: input.demande, styleLabel: parsee.style.label, humeur: parsee.humeur });

    // ── 4) ACCOMPAGNEMENT instrumental (composition déterministe réelle) ──
    const composition = composerMusique({
      demande: `${input.demande} chanson ${titre}`,
      dureeSecondes: dureeDemandee,
      style: parsee.style,
    });

    // ── 5) VOIX HUMAINE RÉELLE : chaque bloc est DIT puis décodé PCM ──
    // PARALLÈLE (sonde production 2026-11-14 : le tour chat est plafonné à
    // 300 s — `maxDuration` de la route stream — et des TTS SÉQUENTIELS
    // réseau le dépassaient) : tous les blocs partent EN MÊME TEMPS (le
    // cache de contenu dédoublonne le refrain répété), l'ordre est
    // restauré par indice — jamais de désordre dans le chant.
    const segments: SegmentVoix[] = [];
    const chant: MusiqueChansonOutput["chant"] = [];
    let moteurVoix = "aucune";
    if (!input.instrumentale && paroles.couplets.length > 0) {
      const blocs = planChant({ paroles, structure: composition.structure });
      const rendus = await Promise.all(
        blocs.map(async (bloc) => {
          const voix = await voixChanson(bloc.texte);
          const pcm = await decoderVoixPcm(voix.buffer, voix.mime);
          return { bloc, voix, pcm };
        }),
      );
      for (const { bloc, voix, pcm } of rendus) {
        moteurVoix = voix.moteur;
        segments.push({ debutSec: bloc.debutSec, pcm });
        chant.push({
          nom: bloc.nom,
          debutSec: Math.round(bloc.debutSec * 10) / 10,
          dureeVoixSec: Math.round((pcm.length / FREQUENCE_CHANSON) * 10) / 10,
          voix: bloc.texte.slice(0, 90),
        });
      }
      // HONNÊTETÉ : une voix muette (TTS vide) n'est jamais acceptée.
      const vocalRms = segments.reduce((acc, s) => acc + Math.sqrt(s.pcm.reduce((a, v) => a + v * v, 0) / Math.max(1, s.pcm.length)), 0) / Math.max(1, segments.length);
      if (segments.length === 0 || !Number.isFinite(vocalRms) || vocalRms < 0.005) {
        throw new Error("La voix humaine est restée silencieuse (TTS indisponible ?) — la chanson n'est pas livrée en faux succès. Réessayez ou demandez une composition instrumentale.");
      }
    }

    // ── 6) MIXAGE voix + musique (ducking) puis encodage maître ──
    // composition.pcm est Int16 entrelacé (L,R) : dé-sentrelacé en Float32
    // par canal pour le mixage, puis ré-entrelacé pour la synthèse.
    const echantillons = composition.echantillons;
    const musiqueGauche = new Float32Array(echantillons);
    const musiqueDroite = new Float32Array(echantillons);
    for (let i = 0; i < echantillons; i += 1) {
      musiqueGauche[i] = composition.pcm.readInt16LE(i * 4) / 32768;
      musiqueDroite[i] = composition.pcm.readInt16LE(i * 4 + 2) / 32768;
    }
    const mixe = mixerChanson({
      musiqueGauche,
      musiqueDroite,
      segments,
      frequence: composition.frequence,
    });
    const pcmEntrelace = new Float32Array(echantillons * 2);
    for (let i = 0; i < echantillons; i += 1) {
      pcmEntrelace[2 * i] = mixe.gauche[i];
      pcmEntrelace[2 * i + 1] = mixe.droite[i];
    }
    const pcm16 = Float32VersInt16(pcmEntrelace);
    const rendu = await synthetiserMusique({
      pcm: pcm16,
      frequence: composition.frequence,
      canaux: 2,
      titre: `${titre} — chanson gen3ia`,
    });

    // ── 7) PERSISTANCE PERMANENTE (clé de contenu déterministe) ──
    const empreinte = createHash("sha256")
      .update(JSON.stringify({ titre, paroles: paroles.couplets, demande: input.demande, duree: dureeDemandee }))
      .digest("hex")
      .slice(0, 16);
    const persistance = await persistGeneratedBuffer({
      userId: context.userId,
      buffer: rendu.buffer,
      contentType: rendu.mime,
      prefix: "musique",
      fixedKey: cleChanson({
        userId: context.userId,
        empreinte,
        styleId: parsee.style.id,
        dureeSecondes: composition.dureeSecondes,
        extension: rendu.extension,
      }),
    });
    const estPermanent = persistance.storage === "r2" && typeof persistance.storagePath === "string";
    if (!estPermanent) {
      // Une chanson (souvent > 2 Mo) sans R2 ne se transmet pas inline.
      throw new Error(
        `Chanson « ${titre} » composée (${rendu.buffer.length} octets) mais le stockage permanent (R2) est indisponible — ` +
          "le fichier dépasse le plafond inline. Configurez R2 puis réessayez.",
      );
    }
    const ecouterUrl = urlDurableAbsolue(persistance.storagePath!) ?? persistance.url;

    // ── 8) CLIP MUSICAL SEULEMENT SI DEMANDÉ (par défaut : audio seul) ──
    const veutClip = input.clipMusical ?? demandeClipMusical(input.demande);
    let clip: MusiqueChansonOutput["clip"] | undefined;
    if (veutClip && rendu.mime === "audio/mpeg") {
      try {
        const renduClip = await produireClipMusical({
          audioMp3: rendu.buffer,
          titre,
          dureeSec: composition.dureeSecondes,
          styleLabel: parsee.style.label,
        });
        const persistanceClip = await persistGeneratedBuffer({
          userId: context.userId,
          buffer: renduClip.buffer,
          contentType: renduClip.mime,
          prefix: "musique",
          fixedKey: `users/${context.userId}/permanent/musique/chansons/clips/${empreinte}-${Math.round(composition.dureeSecondes)}s.${renduClip.extension}`,
        });
        const clipPermanent = persistanceClip.storage === "r2" && typeof persistanceClip.storagePath === "string";
        clip = {
          storage: clipPermanent ? "r2" : "inline",
          ...(clipPermanent ? { url: persistanceClip.storagePath } : {}),
          ecouterUrl: clipPermanent
            ? (urlDurableAbsolue(persistanceClip.storagePath!) ?? persistanceClip.url)
            : persistanceClip.url,
          plans: renduClip.plans,
          tailleOctets: renduClip.buffer.length,
        };
      } catch (erreurClip) {
        // Le clip est un PLUS : son échec ne fait jamais échouer la chanson
        // (l'audio, livrable, reste la base).
        clip = undefined;
        chant.push({
          nom: "clip",
          debutSec: 0,
          dureeVoixSec: 0,
          voix: `clip indisponible : ${(erreurClip instanceof Error ? erreurClip.message : String(erreurClip)).slice(0, 120)}`,
        });
      }
    }

    const note =
      `CHANSON « ${titre} » — titre ${titreDetecte ? `CITÉ par vous et respecté` : `INVENTÉ par gen3 (aucun titre donné)`} ; ` +
      `paroles ${paroles.source === "moteur-gen3" ? "écrites par le moteur gen3" : "en repli déterministe (moteur indisponible)"}, ` +
      `voix humaine réelle (${moteurVoix}) qui DÉCLAME les paroles sur l'accompagnement ${parsee.style.label} ` +
      `(ducking automatique), ${composition.dureeSecondes}s, ${rendu.mime}${rendu.diagnostic ? ` (${rendu.diagnostic})` : ""}. ` +
      "Honnête : TTS déclamé — pas un modèle de chant type Suno." +
      (clip ? ` CLIP MUSICAL livré aussi (${clip.plans} plans, MP4).` : " Livraison AUDIO (clip musical seulement sur demande explicite).");

    return {
      titre,
      titreDetecte: titreDetecte !== null,
      paroles: {
        intro: paroles.intro,
        couplets: paroles.couplets,
        refrain: paroles.refrain,
        outro: paroles.outro,
        source: paroles.source,
      },
      storage: estPermanent ? "r2" : "inline",
      ...(estPermanent ? { url: persistance.storagePath } : {}),
      ecouterUrl,
      mimeType: rendu.mime,
      dureeReelle: composition.dureeSecondes,
      style: parsee.style.id,
      styleLabel: parsee.style.label,
      humeur: parsee.humeur,
      chant,
      ...(clip ? { clip } : {}),
      tailleOctets: rendu.buffer.length,
      nomFichier: `chanson-${titre.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${Math.round(composition.dureeSecondes)}s.${rendu.extension}`,
      moteurVoix,
      note,
    };
  },
};

/** Float32 entrelacé → Int16 PCM (contrat synthetiserMusique). */
function Float32VersInt16(entrelace: Float32Array): Buffer {
  const sortie = Buffer.alloc(entrelace.length * 2);
  for (let i = 0; i < entrelace.length; i += 1) {
    const echantillon = Math.max(-1, Math.min(1, entrelace[i]));
    sortie.writeInt16LE(Math.round(echantillon * 32767), i * 2);
  }
  return sortie;
}
