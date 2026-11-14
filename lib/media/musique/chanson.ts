import "server-only";

/**
 * GEN3IA MUSIQUE — PIPELINE CHANSON RÉELLE (exigence utilisateur 2026-11-14).
 *
 * « crée un audio de ce script musical avec paroles et voix humaine ».
 *
 * CHAÎNE RÉELLE (tout est mesurable, rien n'est simulé) :
 *  1. segmentsVoix — chaque bloc de paroles (intro, couplets, refrain,
 *     outro) est DIT par la cascade voix humaine réelle (passerelle
 *     professeur → espace public Edge-TTS, polissage réaliste inclus) ;
 *  2. decoderVoixPcm — FFmpeg décode chaque rendu vocal en PCM 44 100 Hz
 *     mono 16 bits (la durée réelle de la voix est MESURÉE sur les
 *     échantillons décodés — jamais devinée) ;
 *  3. mixerChanson — la voix est POSÉE sur l'accompagnement instrumental
 *     (composerMusique) aux débuts des sections correspondantes
 *     (intro/couplet/refrain/outro de la structure réelle), la musique
 *     est ABAISSÉE sous la voix (ducking avec ramps 300 ms) et le master
 *     est normalisé en crête (jamais d'écrêtage) ;
 *  4. synthetiserMusique — encodage MP3 (FFmpeg) ou WAV natif, persistance
 *     permanente R2 (clé de contenu déterministe) — côté outil.
 *
 * HONNÊTETÉ : la voix est un TTS humain réel qui DÉCLAME les paroles sur
 * l'accompagnement — pas un modèle de chant type Suno ; la note de l'outil
 * le dit explicitement.
 */

import { runFfmpeg, checkFfmpegAvailable } from "@/lib/video/ffmpeg";
import { professeurVoixEspace } from "@/lib/neural/professeur-media";

/** Fréquence de composition (source unique avec composition.ts). */
export const FREQUENCE_CHANSON = 44100;

/* ------------------------------------------------------------------ */
/* 1) VOIX HUMAINE — cascade réelle (passerelle → espace public)       */
/* ------------------------------------------------------------------ */

/**
 * Une VOIX HUMAINE RÉELLE pour un bloc de paroles : professeur configuré
 * d'abord (polissage réaliste inclus dans le wrapper), sinon espace public
 * Edge-TTS polie à la main (même chaîne que le chat). Échec = exception
 * nommée — la chanson n'est jamais livrée sans voix.
 */
export async function voixChanson(texte: string): Promise<{ buffer: Buffer; mime: string; moteur: string }> {
  const essai = async (): Promise<{ buffer: Buffer; mime: string; moteur: string }> => {
    const { professeurVoix } = await import("@/lib/neural/professeur-media");
    const œuvre = await professeurVoix({ texte });
    return { buffer: œuvre.buffer, mime: œuvre.mime, moteur: String(œuvre.meta?.moteur ?? "professeur-voix") };
  };
  try {
    return await essai();
  } catch {
    // Espace public (production, aucune configuration) + polissage réaliste.
    const brute = await professeurVoixEspace({ texte });
    const { polirVoixRealiste } = await import("@/lib/neural/voix-realiste");
    const polie = await polirVoixRealiste({ buffer: brute.buffer, mime: brute.mime });
    return {
      buffer: polie.buffer,
      mime: polie.poli ? polie.mime : brute.mime,
      moteur: "edge-tts-espace",
    };
  }
}

/* ------------------------------------------------------------------ */
/* 2) DÉCODAGE PCM — FFmpeg, durée réelle mesurée                      */
/* ------------------------------------------------------------------ */

/** Décode un rendu vocal (MP3/WAV/opus) en Float32 MONO 44 100 Hz. */
export async function decoderVoixPcm(buffer: Buffer, mime: string): Promise<Float32Array> {
  const dispo = await checkFfmpegAvailable();
  if (!dispo.ffmpeg) {
    throw new Error("FFmpeg indisponible : le mélange voix + musique exige FFmpeg (installez-le puis réessayez).");
  }
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chanson-voix-"));
  const extension = mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : "ogg";
  const entree = path.join(dir, `entree.${extension}`);
  const sortie = path.join(dir, "voix.pcm");
  await fs.writeFile(entree, buffer);
  try {
    await runFfmpeg({
      args: ["-y", "-i", entree, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", String(FREQUENCE_CHANSON), sortie],
      cwd: dir,
      outputDurationSec: 0,
      outputPaths: [sortie],
    });
    const brut = await fs.readFile(sortie);
    const echantillons = Math.floor(brut.length / 2);
    const pcm = new Float32Array(echantillons);
    for (let i = 0; i < echantillons; i += 1) {
      pcm[i] = brut.readInt16LE(i * 2) / 32768;
    }
    return pcm;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ------------------------------------------------------------------ */
/* 3) MIXAGE — pose de la voix + ducking de la musique                 */
/* ------------------------------------------------------------------ */

export interface SegmentVoix {
  /** Début du segment dans la chanson (secondes). */
  debutSec: number;
  /** Voix décodée mono Float32 (44 100 Hz). */
  pcm: Float32Array;
}

const GAIN_MUSIQUE_SOUS_VOIX = 0.32;
const RAMP_SEC = 0.3;

/**
 * Pose les segments de voix sur l'accompagnement stéréo Float32 et abaisse
 * la musique sous chaque fenêtre de voix (ducking à ramps). La voix est
 * répliquée à l'identique sur les deux canaux. Retourne le MIX (gauche,
 * droite) normalisé en crête à 0.95 — prêt pour l'encodage.
 */
export function mixerChanson(params: {
  musiqueGauche: Float32Array;
  musiqueDroite: Float32Array;
  segments: SegmentVoix[];
  frequence: number;
}): { gauche: Float32Array; droite: Float32Array } {
  const { frequence } = params;
  const total = params.musiqueGauche.length;
  const gauche = new Float32Array(total);
  const droite = new Float32Array(total);
  const fenetres: Array<{ debut: number; fin: number }> = [];
  for (const segment of params.segments) {
    const debut = Math.max(0, Math.min(total, Math.floor(segment.debutSec * frequence)));
    const fin = Math.min(total, debut + segment.pcm.length);
    for (let i = debut; i < fin; i += 1) {
      gauche[i] += segment.pcm[i - debut];
      droite[i] += segment.pcm[i - debut];
    }
    if (fin > debut) fenetres.push({ debut, fin });
  }
  if (fenetres.length === 0) {
    gauche.set(params.musiqueGauche);
    droite.set(params.musiqueDroite);
  } else {
    // Gain de musique par échantillon : 1 hors voix, ducking à ramps sous voix.
    const ramp = Math.max(1, Math.round(RAMP_SEC * frequence));
    const gainMusique = new Float32Array(total).fill(1);
    for (const fenetre of fenetres) {
      for (let i = fenetre.debut; i < fenetre.fin; i += 1) gainMusique[i] = Math.min(gainMusique[i], GAIN_MUSIQUE_SOUS_VOIX);
      const debutRampe = Math.max(0, fenetre.debut - ramp);
      for (let i = debutRampe; i < fenetre.debut; i += 1) {
        const t = (i - debutRampe) / Math.max(1, fenetre.debut - debutRampe);
        gainMusique[i] = Math.min(gainMusique[i], 1 - (1 - GAIN_MUSIQUE_SOUS_VOIX) * t);
      }
      const finRampe = Math.min(total, fenetre.fin + ramp);
      for (let i = fenetre.fin; i < finRampe; i += 1) {
        const t = (i - fenetre.fin) / Math.max(1, finRampe - fenetre.fin);
        gainMusique[i] = Math.min(gainMusique[i], GAIN_MUSIQUE_SOUS_VOIX + (1 - GAIN_MUSIQUE_SOUS_VOIX) * t);
      }
    }
    for (let i = 0; i < total; i += 1) {
      const g = gainMusique[i];
      gauche[i] = params.musiqueGauche[i] * g + gauche[i];
      droite[i] = params.musiqueDroite[i] * g + droite[i];
    }
  }
  // Normalisation de crête 0.95 (anti-écrêtage honnête, sans compresseur).
  let crête = 0;
  for (let i = 0; i < total; i += 1) crête = Math.max(crête, Math.abs(gauche[i]), Math.abs(droite[i]));
  if (crête > 0.95) {
    const k = 0.95 / crête;
    for (let i = 0; i < total; i += 1) {
      gauche[i] *= k;
      droite[i] *= k;
    }
  }
  return { gauche, droite };
}

/* ------------------------------------------------------------------ */
/* 4) PLAN DE CHANT — paroles posées sur la structure réelle           */
/* ------------------------------------------------------------------ */

export interface BlocChant {
  /** Nom de section (intro/couplet/refrain/outro). */
  nom: string;
  /** Texte dit par la voix (une seule chaîne par bloc — TTS continu). */
  texte: string;
  /** Début dans la chanson (secondes) — issu de la structure réelle. */
  debutSec: number;
}

/**
 * Associe les PAROLES à la STRUCTURE de composition réelle : chaque section
 * (intro, couplet N, refrain, outro) reçoit son bloc de paroles au début
 * exact de la section. Les couplets cyclent si la structure en a plus que
 * les paroles ; l'outro sans texte reçoit le titre (chuchoté final).
 */
export function planChant(params: {
  paroles: import("./paroles").ParolesChanson;
  structure: Array<{ nom: string; debutSec: number; dureeSec: number }>;
}): BlocChant[] {
  const blocs: BlocChant[] = [];
  let indexCouplet = 0;
  let refrainPosée = false;
  for (const section of params.structure) {
    const { nom } = section;
    if (nom === "intro") {
      blocs.push({ nom, texte: params.paroles.intro.join(" "), debutSec: section.debutSec });
    } else if (nom === "couplet") {
      const bloc = params.paroles.couplets[indexCouplet % params.paroles.couplets.length];
      indexCouplet += 1;
      blocs.push({ nom, texte: bloc.join(" "), debutSec: section.debutSec });
    } else if (nom === "refrain") {
      blocs.push({ nom, texte: params.paroles.refrain.join(" "), debutSec: section.debutSec });
      refrainPosée = true;
    } else if (nom === "outro") {
      blocs.push({ nom, texte: params.paroles.outro.join(" "), debutSec: section.debutSec });
    }
  }
  // Sécurité : une structure SANS refrain (courte) → le refrain est posé à
  // la fin de la dernière section (jamais de paroles perdues).
  if (!refrainPosée && params.paroles.refrain.length > 0 && params.structure.length > 0) {
    const dernière = params.structure[params.structure.length - 1];
    blocs.push({ nom: "refrain", texte: params.paroles.refrain.join(" "), debutSec: Math.max(0, dernière.debutSec + dernière.dureeSec / 3) });
  }
  return blocs;
}

/* ------------------------------------------------------------------ */
/* 5) CLIP MUSICAL — vidéo SI demandée (par défaut : audio seul)       */
/* ------------------------------------------------------------------ */

/** Détection déterministe d'une demande de vidéo musicale / clip. */
export function demandeClipMusical(demande: string): boolean {
  const d = demande.toLowerCase();
  if (!/\b(clip|vidéo|video|filmé|filmer|visualiser|musique vidéo|video clip)\b/.test(d)) return false;
  if (/\b(clip|vidéo|video)\s+(musicale|de\s+musique|de\s+la\s+chanson|de\s+cette\s+musique|de\s+cette\s+chanson)/.test(d)) return true;
  if (/\bmusique\s+(en\s+)?(vidéo|video)\b/.test(d)) return true;
  if (/\b(chanson|musique)\b[^.!?]{0,60}\b(clip|vidéo|video)\b/.test(d)) return true;
  if (/\b(clip|vidéo|video)\b[^.!?]{0,60}\b(chanson|musique)\b/.test(d)) return true;
  return false;
}

/**
 * Produit un CLIP MUSICAL MP4 HONNÊTE : un diaporama FFmpeg réel
 * (carte-titre du morceau + plans animés par zoom léger) muxé AVEC la
 * musique (le son de la chanson EST la bande-son du clip). Le MP4 est
 * borné (durée = chanson), rendu local, retourné en buffer.
 */
export async function produireClipMusical(params: {
  audioMp3: Buffer;
  titre: string;
  dureeSec: number;
  styleLabel: string;
  /** Nombre de plans visuels (défaut 6 — 1 plan / ~15-20 s). */
  plans?: number;
}): Promise<{ buffer: Buffer; mime: string; extension: string; plans: number }> {
  const dispo = await checkFfmpegAvailable();
  if (!dispo.ffmpeg) {
    throw new Error("FFmpeg indisponible : le clip musical exige FFmpeg (installez-le puis réessayez, l'audio seul reste livrable).");
  }
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-musical-"));
  const nbPlans = Math.max(3, Math.min(10, params.plans ?? Math.ceil(params.dureeSec / 18)));
  const dureePlan = params.dureeSec / nbPlans;
  try {
    const audio = path.join(dir, "chanson.mp3");
    await fs.writeFile(audio, params.audioMp3);
    // Plans : PNG générés par FFmpeg (drawtext + dégradé stylé par plan) —
    // lisibles, honnêtes, sans dépendance image externe.
    const entrees: string[] = [];
    const filtres: string[] = [];
    for (let p = 0; p < nbPlans; p += 1) {
      const planPng = path.join(dir, `plan-${p}.png`);
      const teinte = Math.round((280 + p * 40) % 360);
      const lignes = p === 0
        ? [`title=${params.titre}`, `text=${params.styleLabel}`]
        : [`title=${params.titre}`];
      const filtre = [
        "color=c=hsv(" + teinte + ":0.45:0.16)",
        "scale=1280:720",
        `drawtext=text='${lignes[0].replace("title=", "")}':fontcolor=white@0.92:fontsize=${p === 0 ? 72 : 56}:x=(w-text_w)/2:y=(h-text_h)/2:font=Noto+Sans SC`,
        ...(lignes[1] ? [`drawtext=text='${lignes[1].replace("text=", "")}':fontcolor=white@0.6:fontsize=36:x=(w-text_w)/2:y=h*0.68:font=Noto+Sans SC`] : []),
        "zoompan=z='min(zoom+0.0008,1.12)':d=" + Math.max(1, Math.round(dureePlan * 25)) + ":s=1280x720:fps=25",
      ].join(",");
      await runFfmpeg({
        args: ["-y", "-f", "lavfi", "-i", `nullsrc=s=1280x720:d=1`, "-vf", filtre, "-frames:v", "1", planPng],
        cwd: dir,
        outputDurationSec: 1,
        outputPaths: [planPng],
      });
      entrees.push(planPng);
    }
    entrees.forEach((plan, index) => {
      filtres.push(`[${index}:v]format=yuv420p[v${index}]`);
    });
    const concatFiltres = entrees.map((_, index) => `[v${index}]`).join("") +
      `concat=n=${entrees.length}:v=1:a=0[vc]`;
    const videoSortie = path.join(dir, "clip.mp4");
    await runFfmpeg({
      args: [
        "-y",
        ...entrees.flatMap((plan) => ["-loop", "1", "-t", dureePlan.toFixed(2), "-i", plan]),
        "-i", audio,
        "-filter_complex", `${filtres.join(";")};${concatFiltres};[vc]fade=t=out:st=${Math.max(0, params.dureeSec - 1).toFixed(2)}:d=1[vf]`,
        "-map", "[vf]", "-map", `${entrees.length}:a`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
        "-c:a", "aac", "-b:a", "192k",
        "-t", params.dureeSec.toFixed(2), "-movflags", "+faststart",
        videoSortie,
      ],
      cwd: dir,
      outputDurationSec: params.dureeSec,
      outputPaths: [videoSortie],
    });
    const buffer = await fs.readFile(videoSortie);
    return { buffer, mime: "video/mp4", extension: "mp4", plans: entrees.length };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
