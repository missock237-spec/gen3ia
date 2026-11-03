#!/usr/bin/env node
/**
 * GÉNÉRATEUR DU MODULE MULTIMODAL it.90 (npx tsx scripts/genere-module-multimodal-it90.ts)
 *
 * Lit var/entrainement-multimodal-it90/assets.json (30 assets RÉELS HF :
 * 20 images COCO-2017 + 8 audios FLEURS fr_fr + 2 vidéos UCF101) et y ajoute
 * les 4 clips TTS voix naturelle générés localement — émet
 * lib/neural/generation/multimodal-it90.ts :
 *   - ASSETS_MULTIMODAL_IT90 : métadonnées mesurées (octets, sha256, source) ;
 *   - PAIRES_MULTIMODAL_IT90 : paires question/réponse servies par le chat.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const inventaire = JSON.parse(readFileSync("var/entrainement-multimodal-it90/assets.json", "utf-8"));

const TTS = [
  {
    id: "kext90_tts_001", modality: "audio-généré", dataset: "génération locale (TTS voix naturelle)",
    file: "/multimodal-it90/audio/tts_couleurs_melange.mp3",
    legende: "Voix naturelle : le mélange additif de lumière rouge et verte donne du jaune (somme des canaux bornée à 255).",
    texte: "le mélange additif de lumière rouge et verte donne du jaune",
  },
  {
    id: "kext90_tts_002", modality: "audio-généré", dataset: "génération locale (TTS voix naturelle)",
    file: "/multimodal-it90/audio/tts_couleurs_hexa.mp3",
    legende: "Voix naturelle : lecture d'un code hexadécimal par paires rouge/vert/bleu, exemple #00FF (bleu pur).",
    texte: "un code hexadécimal se lit par paires rouge, vert, bleu",
  },
  {
    id: "kext90_tts_003", modality: "audio-généré", dataset: "génération locale (TTS voix naturelle)",
    file: "/multimodal-it90/audio/tts_palette_gen3.mp3",
    legende: "Voix naturelle : les cinq couleurs principales de la palette Gen3 et leurs propriétés (température, luminosité).",
    texte: "chacune possède une température, chaude ou froide, et une luminosité",
  },
  {
    id: "kext90_tts_004", modality: "audio-généré", dataset: "génération locale (TTS voix naturelle)",
    file: "/multimodal-it90/audio/tts_pigments_vs_lumiere.mp3",
    legende: "Voix naturelle : mélange soustractif des pigments (bleu+jaune=vert) contre mélange additif de la lumière (bleu+vert=cyan).",
    texte: "le bleu et le jaune donnent du vert",
  },
];

function stat(file: string): { bytes: number } {
  const chemin = file.startsWith("/") ? `public${file}` : file;
  return { bytes: statSync(chemin).size };
}

function sha16(file: string): string {
  const chemin = file.startsWith("/") ? `public${file}` : file;
  return createHash("sha256").update(readFileSync(chemin)).digest("hex").slice(0, 16);
}

interface Asset { id: string; modality: string; dataset: string; file: string; bytes: number; sha256: string; legende_reelle: string }

const assets: Asset[] = [];
for (const a of inventaire.assets as Array<{ id: string; modality: string; dataset: string; file: string; bytes: number; sha256: string; legende_reelle: string }>) {
  assets.push({
    ...a,
    file: a.file.replace(/^public/, ""), // URL publique
  });
}
for (const t of TTS) {
  if (!existsSync(`public${t.file}`)) throw new Error(`TTS absent : ${t.file}`);
  assets.push({
    id: t.id, modality: t.modality, dataset: t.dataset, file: t.file,
    bytes: stat(t.file).bytes, sha256: sha16(t.file), legende_reelle: t.legende,
  });
}

const total = assets.reduce((s, a) => s + a.bytes, 0);

// ─── Paires de chat (question → réponse vérifiable depuis les métadonnées) ──
function paireImage(a: Asset): { motif: string; reponse: string; theme: string } {
  return {
    motif: `Que contient l'image ${a.id} ?`,
    reponse: `L'image ${a.id} est un asset RÉEL de COCO-2017 (validation, ${a.dataset.split("#")[1] ?? "val"}, ${a.bytes.toLocaleString("fr-FR")} octets, empreinte ${a.sha256}). La légende exacte issue des annotations : ${a.legende_reelle}. Elle est servie publiquement à ${a.file} et fait partie des 20 images réelles intégrées au cerveau de gen3 au tick it.90.`,
    theme: "multimodal-image",
  };
}
function paireAudio(a: Asset): { motif: string; reponse: string; theme: string } {
  const gen = a.modality === "audio-généré";
  return {
    motif: `Que contient l'enregistrement audio ${a.id} ?`,
    reponse: gen
      ? `L'audio ${a.id} est un clip GÉNÉRÉ à voix naturelle (TTS, MP3 ${a.bytes.toLocaleString("fr-FR")} octets, empreinte ${a.sha256}) : ${a.legende_reelle} Fichier servi : ${a.file}.`
      : `L'audio ${a.id} est un clip RÉEL de parole française du dataset professionnel Google FLEURS (fr_fr, validation, ${a.bytes.toLocaleString("fr-FR")} octets, empreinte ${a.sha256}). La transcription officielle : « ${a.legende_reelle} ». Fichier servi : ${a.file}.`,
    theme: "multimodal-audio",
  };
}
function paireVideo(a: Asset): { motif: string; reponse: string; theme: string } {
  return {
    motif: `Que contient la vidéo ${a.id} ?`,
    reponse: `La vidéo ${a.id} est un extrait RÉEL du sous-ensemble UCF101 (dataset professionnel d'analyse d'actions humaines, converti en MP4 H.264, ${a.bytes.toLocaleString("fr-FR")} octets, empreinte ${a.sha256}). ${a.legende_reelle}. Fichier servi : ${a.file}.`,
    theme: "multimodal-video",
  };
}

const paires = assets.map((a) =>
  a.modality.startsWith("image") ? paireImage(a) : a.modality.startsWith("audio") ? paireAudio(a) : paireVideo(a),
);

const entete = `/**
 * ASSETS MULTIMODAUX RÉELS it.90 (généré par
 * scripts/genere-module-multimodal-it90.ts — ${new Date().toISOString()}).
 *
 * ${assets.length} assets réels mesurés (${(total / 1e6).toFixed(2)} Mo au total) :
 *   - 20 images COCO-2017 (rafaelpadilla/coco2017, validation) avec
 *     annotations d'objets officielles — légendes reconstruites depuis les
 *     labels RÉELS (liste « 90 things », vérifiée sur pièce) ;
 *   - 8 audios de parole française naturelle Google FLEURS (fr_fr,
 *     validation) avec transcriptions officielles ;
 *   - 2 vidéos UCF101 (sayakpaul/ucf101-subset) converties MP4 H.264 ;
 *   - 4 clips TTS à voix naturelle générés localement.
 * Fichiers servis depuis public/multimodal-it90/. Les paires sont assimilées
 * par le cortex langagier (corpus.ts) — mêmes fonctions que la production.
 */
export interface AssetMultimodalIt90 {
  readonly id: string;
  readonly modality: "image" | "audio" | "audio-généré" | "video";
  readonly dataset: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly legende: string;
}

export const ASSETS_MULTIMODAL_IT90: readonly AssetMultimodalIt90[] = [
`;

const corpsAssets = assets
  .map((a) => `  ${JSON.stringify({
    id: a.id,
    modality: a.modality === "video" ? "video" : a.modality.startsWith("audio") ? a.modality : "image",
    dataset: a.dataset,
    file: a.file,
    bytes: a.bytes,
    sha256: a.sha256,
    legende: a.legende_reelle.slice(0, 300),
  })},`)
  .join("\n");

const corpsPaires = paires
  .map((p) => `  ${JSON.stringify(p)},`)
  .join("\n");

const sortie = `${entete}${corpsAssets}
];

export const PAIRES_MULTIMODAL_IT90: readonly { motif: string; reponse: string; theme: string }[] = [
${corpsPaires}
];
`;
writeFileSync("lib/neural/generation/multimodal-it90.ts", sortie);
console.log(`module écrit : lib/neural/generation/multimodal-it90.ts (${assets.length} assets, ${(total / 1e6).toFixed(2)} Mo, ${paires.length} paires)`);
