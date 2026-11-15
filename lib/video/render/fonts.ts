import "server-only";

/**
 * GEN3IA VIDEO AGENT — résolution de police pour drawtext/subtitles.
 *
 * Cherche une police TTF réelle dans les emplacements standards (DejaVu,
 * Noto, Liberation) ou via VIDEO_FONT_PATH. Si aucune n'est trouvée, les
 * textes brûlés sont DÉSACTIVÉS avec journal explicite (dégradation
 * honnête, jamais de commande qui échoue en silence).
 */

import { access, constants } from "node:fs/promises";

const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/opentype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
];

export async function resolveFontFile(): Promise<string | null> {
  const custom = process.env.VIDEO_FONT_PATH;
  const candidates = custom ? [custom, ...FONT_CANDIDATES] : FONT_CANDIDATES;
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
