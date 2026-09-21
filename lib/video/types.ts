import { z } from "zod";

/**
 * Modèle de données du Studio Vidéo (génération multimodale) :
 * un projet = un brief + un storyboard de scènes (prompt visuel, narration,
 * texte à l'écran, durée, image clé) + un format cible (16:9, 9:16, 1:1).
 */

export const VIDEO_FORMATS = ["16:9", "9:16", "1:1"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

export const VideoSceneSchema = z.object({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().max(120).default(""),
  durationSeconds: z.number().int().min(2).max(60).default(6),
  visualPrompt: z.string().trim().min(1).max(1_000),
  narration: z.string().trim().max(1_200).default(""),
  onScreenText: z.string().trim().max(300).default(""),
  keyframePath: z.string().trim().max(500).optional(),
  keyframeFilename: z.string().trim().max(255).optional(),
});
export type VideoScene = z.infer<typeof VideoSceneSchema>;

export const VideoProjectSchema = z.object({
  title: z.string().trim().min(2).max(120),
  brief: z.string().trim().min(3).max(4_000),
  format: z.enum(VIDEO_FORMATS).default("16:9"),
  scenes: z.array(VideoSceneSchema).max(20).default([]),
  status: z.enum(["draft", "planned", "ready"]).default("planned"),
});
export type VideoProject = z.infer<typeof VideoProjectSchema>;

export function totalDurationSeconds(scenes: VideoScene[]): number {
  return scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0);
}

/** Consigne de cadrage injectée dans chaque prompt visuel selon le format. */
export function formatHint(format: VideoFormat): string {
  switch (format) {
    case "9:16":
      return "vertical 9:16 framing, portrait orientation, optimized for social media stories";
    case "1:1":
      return "square 1:1 framing";
    default:
      return "cinematic widescreen 16:9 framing";
  }
}
