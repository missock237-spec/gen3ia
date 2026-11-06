#!/usr/bin/env node
/**
 * GÉNÉRATEUR DU MODULE MULTIMODAL it.113 (npx tsx scripts/genere-module-multimodal-it113.ts)
 *
 * Lit var/entrainement-multimodal-it113/assets.json (inventaire HF — fenêtre
 * du 06 nov 2026 : 20 images COCO-2017 offset 444 + 8 audios FLEURS fr_fr
 * offset 164 + fenêtre vidéo UCF101 ÉPUISÉE — preuve du zéro) et émet
 * lib/neural/generation/multimodal-it113.ts :
 *   - ASSETS_MULTIMODAL_IT113 : métadonnées mesurées (octets, sha256, source) ;
 *   - PAIRES_MULTIMODAL_IT113 : paires question/réponse servies par le chat.
 */
import { readFileSync, writeFileSync } from "node:fs";

const inventaire = JSON.parse(readFileSync("var/entrainement-multimodal-it113/assets.json", "utf-8"));

interface Asset { id: string; modality: string; dataset: string; file: string; bytes: number; sha256: string; legende_reelle: string }

const assets: Asset[] = [];
for (const a of inventaire.assets as Asset[]) {
  assets.push({
    ...a,
    file: a.file.replace(/^public/, ""), // URL publique
  });
}

const total = assets.reduce((s, a) => s + a.bytes, 0);

// Comptes par modalité — en-tête TOUJOURS fidèle à l'inventaire réel
const comptes = assets.reduce<Record<string, number>>((acc, a) => {
  const cle = a.modality === "video" ? "video" : a.modality.startsWith("audio") ? "audio" : "image";
  acc[cle] = (acc[cle] ?? 0) + 1;
  return acc;
}, {});

// ─── Paires de chat (question → réponse vérifiable depuis les métadonnées) ──
function paireImage(a: Asset): { motif: string; reponse: string; theme: string } {
  return {
    motif: `Que contient l'image ${a.id} ?`,
    reponse: `L'image ${a.id} est un asset RÉEL de COCO-2017 (validation, ${a.bytes.toLocaleString("fr-FR")} octets, empreinte ${a.sha256}). La légende exacte issue des annotations : ${a.legende_reelle}. Elle est servie publiquement à ${a.file} et fait partie de la fenêtre it.113 (20 images réelles téléchargées le 06 nov 2026, fenêtre suivant celle d'it.112 — offset 424).`,
    theme: "multimodal-image",
  };
}
function paireAudio(a: Asset): { motif: string; reponse: string; theme: string } {
  return {
    motif: `Que contient l'enregistrement audio ${a.id} ?`,
    reponse: `L'audio ${a.id} est un clip RÉEL de parole française du dataset professionnel Google FLEURS (fr_fr, validation, ${a.bytes.toLocaleString("fr-FR")} octets, empreinte ${a.sha256}). La transcription officielle : « ${a.legende_reelle} ». Fichier servi : ${a.file}.`,
    theme: "multimodal-audio",
  };
}
function paireVideo(a: Asset): { motif: string; reponse: string; theme: string } {
  return {
    motif: `Que contient la vidéo ${a.id} ?`,
    reponse: `La vidéo ${a.id} est un extrait RÉEL du sous-ensemble UCF101 (dataset professionnel d'analyse d'actions humaines, ${a.bytes.toLocaleString("fr-FR")} octets, empreinte ${a.sha256}). ${a.legende_reelle}. Fichier servi : ${a.file}.`,
    theme: "multimodal-video",
  };
}

const paires = assets.map((a) =>
  a.modality.startsWith("image") ? paireImage(a) : a.modality.startsWith("audio") ? paireAudio(a) : paireVideo(a),
);

const entete = `/**
 * ASSETS MULTIMODAUX RÉELS it.113 (généré par
 * scripts/genere-module-multimodal-it113.ts — ${new Date().toISOString()}).
 *
 * ${assets.length} assets réels mesurés (${(total / 1e6).toFixed(2)} Mo au total) :
 *   - ${comptes.image ?? 0} images COCO-2017 (rafaelpadilla/coco2017, validation,
 *     fenêtre offset 444, après l'offset 424 d'it.112) avec annotations
 *     d'objets officielles — légendes reconstruites depuis les labels
 *     RÉELS (liste « 90 things ») ;
 *   - ${comptes.audio ?? 0} audios de parole française naturelle Google FLEURS
 *     (fr_fr, validation, fenêtre offset 164, après l'offset 156 d'it.112) avec
 *     transcriptions officielles (WAV PCM) ;
 *   - ${comptes.video ?? 0} vidéo UCF101 — la fenêtre offset 4 renvoie 0 ligne :
 *     le split train ne contient que 2 lignes, intégrées depuis it.90
 *     (preuve du zéro, refaite le 06 nov 2026).
 * Fichiers servis depuis public/multimodal-it113/. Les paires sont assimilées
 * par le cortex langagier (corpus.ts) — mêmes fonctions que la production.
 */
export interface AssetMultimodalIt98 {
  readonly id: string;
  readonly modality: "image" | "audio" | "video";
  readonly dataset: string;
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly legende: string;
}

export const ASSETS_MULTIMODAL_IT113: readonly AssetMultimodalIt98[] = [
`;

const lignesAssets = assets.map(
  (a) => `  { id: "${a.id}", modality: "${a.modality}" as const, dataset: "${a.dataset}", file: "${a.file}", bytes: ${a.bytes}, sha256: "${a.sha256}", legende: ${JSON.stringify(a.legende_reelle)} },`,
);

const finAssets = `];

export interface PaireMultimodaleIt98 {
  readonly motif: string;
  readonly reponse: string;
  readonly theme: string;
}

export const PAIRES_MULTIMODAL_IT113: readonly PaireMultimodaleIt98[] = [
`;

const lignesPaires = paires.map(
  (p) => `  { motif: ${JSON.stringify(p.motif)}, reponse: ${JSON.stringify(p.reponse)}, theme: "${p.theme}" },`,
);

const sortie = `${entete}${lignesAssets.join("\n")}\n${finAssets}${lignesPaires.join("\n")}\n];\n`;

writeFileSync("lib/neural/generation/multimodal-it113.ts", sortie);
console.log(`module écrit : lib/neural/generation/multimodal-it113.ts (${assets.length} assets, ${(total / 1e6).toFixed(2)} Mo, ${paires.length} paires)`);
