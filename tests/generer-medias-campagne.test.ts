import { describe, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  genererVisuelNeuralBrut,
  genererAudioNeuralEtPersister,
  genererVideoNeuralEtPersister,
} from "@/lib/neural/media-service";

/**
 * HARNISSE DE GÉNÉRATION MÉDIA (campagne de tests gen3ia, 2026-10-24).
 *
 * Exerce les MOTEURS LOCAUX RÉELS de gen3 — les mêmes que l'atelier média du
 * cerveau et que les routes de la plateforme :
 *  - image  : gen3-snn-visuel-v2-scene (scène → rasterisation sharp → PNG) ;
 *  - audio  : synthèse acoustique du SNN (ondes → PCM → WAV) ;
 *  - vidéo  : storyboard animé SMIL (MoteurVideoCpu, scènes + caméra + météo).
 *
 * R2 n'est pas configuré sur ce poste : la persistance bascule sur son repli
 * inline documenté (data URI) — on décode et on écrit les fichiers sous
 * /home/z/my-project/download/tests-gen3ia/.
 */

const SORTIE = process.env.GEN3IA_MEDIA_OUT ?? "/tmp/gen3ia-medias";

// FIX (10-2026) : le dossier de sortie était créé manuellement hors test —
// un /tmp nettoyé (nouvelle sandbox, runner CI) faisait échouer les 3 écritures
// avec ENOENT. Création récursive idempotente avant chaque campagne.
function assurerSortie(): void {
  mkdirSync(SORTIE, { recursive: true });
}

function decoderDataUri(uri: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new Error(`URI inattendue : ${uri.slice(0, 60)}…`);
  const mime = m[1]!;
  if (m[2]) return { mime, bytes: Buffer.from(m[3]!, "base64") };
  return { mime, bytes: Buffer.from(decodeURIComponent(m[3]!), "utf8") };
}

describe("génération média gen3 (campagne de tests)", () => {
  it("IMAGE — scène photoréaliste structurée « chat au bord de la mer au coucher de soleil »", async () => {
    assurerSortie();
    const rendu = await genererVisuelNeuralBrut({
      prompt: "un chat noir au bord de la mer au coucher de soleil",
      ratio: "16:9",
    });
    writeFileSync(`${SORTIE}/media-image-chat-mer.png`, rendu.image);
    writeFileSync(`${SORTIE}/media-image-chat-mer.svg`, rendu.svg, "utf8");
    console.log(
      `IMAGE OK ${rendu.width}x${rendu.height} ${rendu.image.length} octets, moteur=${rendu.meta.moteur}`,
    );
  });

  it("AUDIO — synthèse acoustique SNN « narration chaleureuse »", async () => {
    assurerSortie();
    const rendu = await genererAudioNeuralEtPersister({
      userId: "testeur-campagne",
      prompt: "voix off chaude et posée pour présenter la plateforme gen3ia",
      dureeSecondes: 6,
    });
    const { bytes } = decoderDataUri(rendu.url);
    writeFileSync(`${SORTIE}/media-audio-voix-gen3.wav`, bytes);
    console.log(`AUDIO OK ${bytes.length} octets, storage=${rendu.storage}, moteur=${rendu.meta?.moteur ?? "n/a"}`);
  });

  it("VIDÉO — storyboard animé « un phare dans la tempête. puis la ville la nuit »", async () => {
    assurerSortie();
    const rendu = await genererVideoNeuralEtPersister({
      userId: "testeur-campagne",
      prompt: "un phare dans la tempête. puis la ville la nuit",
      dureeSecondes: 8,
    });
    const { bytes } = decoderDataUri(rendu.url);
    const cible = `${SORTIE}/media-video-phare-ville.svg`;
    writeFileSync(cible, bytes, "utf8");
    console.log(`VIDEO OK ${bytes.length} octets, storage=${rendu.storage}, moteur=${rendu.meta?.moteur ?? "n/a"}`);
  });
});
