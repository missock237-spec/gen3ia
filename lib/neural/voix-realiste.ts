import "server-only";

/**
 * VOIX RÉALISTE — post-traitement audio AUTOMATIQUE des voix de synthèse.
 *
 * Demande propriétaire (2026-11-14) : « utilise le même système que pour
 * que la génération d'images soit photoréaliste sans que l'utilisateur ne
 * le demande — pour que la génération vidéo ET AUDIO de gen3 soit pareille
 * et fonctionne comme d'autres IA avec des rendus réalistes ». L'équivalent
 * audio de durcirPromptImage est CE post-traitement : la voix brute du
 * moteur TTS (Edge-TTS / passerelle) est polie en FFmpeg — équalisation,
 * compression douce, salle discrète, normalisation loudness — pour un
 * rendu plus naturel (voix de studio) SANS que l'utilisateur ait rien à
 * demander ni configurer.
 *
 * JAMAIS BLOQUANT : tout incident (FFmpeg absent, format inattendu) rend
 * la voix BRUTE d'origine — un polissage raté ne doit jamais coûter une
 * narration. Le champ `poli` porte l'honnêteté du résultat.
 */

/** Chaîne de filtres audio du rendu voix réaliste (documentée, ordre fixe) :
 *  1. highpass 75 Hz — coupe les ronflements basses du TTS ;
 *  2. acompressor doux (2.5:1, attaque 8 ms) — densité de studio ;
 *  3. aecho très court (35 ms, 10 %) — pièce discrète, casque au sec ;
 *  4. loudnorm (−16 LUFS, TP −1,5 dB) — niveau de diffusion constant. */
export const CHAINE_VOIX_REALISTE =
  "highpass=f=75,acompressor=threshold=-20dB:ratio=2.5:attack=8:release=120:makeup=2,aecho=0.7:0.6:35:0.10,loudnorm=I=-16:TP=-1.5:LRA=11";

export interface VoixPolie {
  buffer: Buffer;
  mime: string;
  /** TRUE quand le polissage FFmpeg a réellement produit l'audio final. */
  poli: boolean;
  /** Détail honnête en cas de repli à la voix brute (journal/télémetrie). */
  detail?: string;
}

/** Taille minimale d'un flux audio valide (un MP3/WAV de moins de 512 o
 *  est un silence/erreur — inutile de le polir). */
const SEUIL_OCTETS = 512;

/**
 * Polit un flux audio de voix de synthèse (WAV ou MP3) → MP3 192 k.
 * Ré entrant et sans dépendance top-level vers le moteur vidéo (import
 * paresseux de lib/video/ffmpeg DANS la fonction — aucun cycle de module
 * : la couche neural reste chargeable sans le pipeline vidéo).
 */
export async function polirVoixRealiste(brut: { buffer: Buffer; mime: string }): Promise<VoixPolie> {
  if (!brut?.buffer || brut.buffer.length < SEUIL_OCTETS) {
    return { buffer: brut?.buffer ?? Buffer.alloc(0), mime: brut?.mime ?? "audio/mpeg", poli: false, detail: "flux trop court pour polissage" };
  }
  let dir: string | undefined;
  try {
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    dir = await mkdtemp(join(tmpdir(), "gen3ia-voix-"));
    // Chemins ABSOLUS : runFfmpeg vérifie chaque sortie via assertInsideDir
    // (résolue depuis cwd) — le moteur vidéo passe lui-même des chemins
    // absolus du tmpDir du job ; même contrat ici.
    const entree = join(dir, "voix_brute.source");
    const sortie = join(dir, "voix_polie.mp3");
    await writeFile(entree, brut.buffer);
    const { runFfmpeg } = await import("@/lib/video/ffmpeg");
    await runFfmpeg({
      args: ["-i", entree, "-af", CHAINE_VOIX_REALISTE, "-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100", "-y", sortie],
      cwd: dir,
      outputDurationSec: 30,
      outputPaths: [sortie],
    });
    const poli = await readFile(sortie);
    if (poli.length < SEUIL_OCTETS) throw new Error("polissage : sortie anormalement courte");
    return { buffer: poli, mime: "audio/mpeg", poli: true };
  } catch (erreur) {
    return {
      buffer: brut.buffer,
      mime: brut.mime,
      poli: false,
      detail: `repli voix brute : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
    };
  } finally {
    if (dir) {
      const { rm } = await import("node:fs/promises");
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
