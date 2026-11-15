import "server-only";

/**
 * GEN3IA VIDEO AGENT — Transform des clips image rendus (Task 106-b).
 *
 * La timeline porte un `transform` par clip (x/y/scale/opacity, spec §12
 * Timeline Engine) mais le planner de rendu l'ignorait : le rendu n'était
 * pas fidèle au montage. Ce module traduit le transform d'un clip image en
 * filtres FFmpeg RÉELS (scale + pad/crop + atténuation d'opacité) appliqués
 * au niveau canvas, APRÈS la caméra (zoompan) et AVANT les effets/textes.
 *
 * types.ts étant hors périmètre d'écriture (Task 106-b), le type du champ
 * est déclaré ICI (SegmentTransform) ainsi que l'extension structurelle de
 * RenderSegment (TransformableRenderSegment) — l'orchestrateur pourra
 * replacer ces déclarations dans types.ts plus tard sans changer un appel.
 *
 * Toutes les fonctions sont PURES et déterministes (convention du dépôt).
 */

import type { RenderSegment, VideoTimeline } from "@/lib/video/types";

/**
 * Transform de clip appliqué au rendu. Champs optionnels : absent =
 * valeur neutre. Reprend le sous-ensemble utile de ClipTransform
 * (x/y/scale/opacity) — la rotation du clip passe par le MotionSpec
 * (keyframes rotationDeg, cf. planner).
 */
export interface SegmentTransform {
  /** Décalage horizontal en fraction d'écran (-1..1, 0 = centré). */
  x?: number;
  /** Décalage vertical en fraction d'écran (-1..1, 0 = centré). */
  y?: number;
  /** Échelle du clip sur le canvas (1 = pleine taille, bornes timeline 0.1..4). */
  scale?: number;
  /** Opacité 0..1 (1 = opaque). */
  opacity?: number;
}

/** RenderSegment étendu du champ optionnel `transform` (Task 106-b). */
export type TransformableRenderSegment = RenderSegment & { transform?: SegmentTransform };

const EPSILON = 1e-6;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Dimensions paires (encodeurs H.264). */
function evenize(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

/** Transform neutre (aucun filtre généré) ? */
export function isIdentityTransform(t: SegmentTransform | undefined): boolean {
  if (!t) return true;
  const { x = 0, y = 0, scale = 1, opacity = 1 } = t;
  return (
    Math.abs(x) < EPSILON &&
    Math.abs(y) < EPSILON &&
    Math.abs(scale - 1) < EPSILON &&
    Math.abs(opacity - 1) < EPSILON
  );
}

/**
 * Extrait le transform du clip image correspondant à la scène (id
 * conventionnel `clip_img_<sceneId>`, toutes pistes image/vidéo confondues).
 * Renvoie UNDEFINED quand : clip absent, transform absent, ou transform
 * neutre — le segment reste alors STRICTEMENT identique à l'historique
 * (zéro régression, aucun champ superflu sérialisé).
 */
export function extractSegmentTransform(timeline: VideoTimeline | undefined, sceneId: string): SegmentTransform | undefined {
  if (!timeline) return undefined;
  const clipId = `clip_img_${sceneId}`;
  let clipTransform: SegmentTransform | undefined;
  for (const track of timeline.tracks) {
    if (track.kind !== "image" && track.kind !== "video") continue;
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) {
      const t = clip.transform;
      if (t) clipTransform = { x: t.x, y: t.y, scale: t.scale, opacity: t.opacity };
      break;
    }
  }
  if (isIdentityTransform(clipTransform)) return undefined;
  return clipTransform;
}

/**
 * Filtres FFmpeg du transform (ordre fixe : géométrie puis opacité).
 *
 * - scale ≠ 1 : redimensionnement du contenu puis
 *     • scale < 1 → `pad` : le clip réduit est posé sur un canvas noir
 *       (le fond noir matérialise l'absence de clip hors de ses bornes) ;
 *     • scale > 1 → `crop` : le clip agrandi déborde, recadrage centré
 *       décalé de (x, y).
 * - offsets (x, y) en pixels = fraction × dimensions du canvas. À échelle
 *   1 avec offsets, un léger pré-agrandissement garantit la marge du
 *   décalage (pas de barres noires involontaires, pas de clamp FFmpeg).
 * - opacity < 1 : atténuation multiplicative des canaux RGB (composite
 *   équivalent sur fond noir) + alpha conservé via format=rgba — sans
 *   coût de compositing overlay.
 *
 * Retourne [] pour transform absent/neutre → chaîne de filtres inchangée.
 */
export function buildTransformFilters(
  transform: SegmentTransform | undefined,
  dims: { width: number; height: number },
): string[] {
  if (isIdentityTransform(transform)) return [];
  const { width: W, height: H } = dims;

  const scale = clamp(
    typeof transform!.scale === "number" && Number.isFinite(transform!.scale) ? transform!.scale : 1,
    0.1,
    4,
  );
  const x = clamp(
    typeof transform!.x === "number" && Number.isFinite(transform!.x) ? transform!.x : 0,
    -1,
    1,
  );
  const y = clamp(
    typeof transform!.y === "number" && Number.isFinite(transform!.y) ? transform!.y : 0,
    -1,
    1,
  );
  const opacity = clamp(
    typeof transform!.opacity === "number" && Number.isFinite(transform!.opacity) ? transform!.opacity : 1,
    0,
    1,
  );

  const px = Math.round(x * W);
  const py = Math.round(y * H);
  const filters: string[] = [];

  if (Math.abs(scale - 1) > EPSILON || px !== 0 || py !== 0) {
    if (scale < 1) {
      // Clip réduit sur canvas noir (position = centré + offset, borné ≥ 0 :
      // pad FFmpeg n'accepte pas d'origine négative — documenté).
      const sw = evenize(Math.round(W * scale));
      const sh = evenize(Math.round(H * scale));
      const x0 = Math.max(0, Math.round((W - sw) / 2 + px));
      const y0 = Math.max(0, Math.round((H - sh) / 2 + py));
      filters.push(`scale=${sw}:${sh}`);
      filters.push(`pad=${W}:${H}:${x0}:${y0}:black`);
    } else {
      // Clip à taille pleine (offsets seuls) ou agrandi : marge suffisante
      // pour le décalage, recadrage centré décalé (aucune barre noire).
      const marginRatio = Math.max(0, Math.abs(px) / W, Math.abs(py) / H);
      const effectiveScale = Math.max(scale, 1 + 2 * marginRatio);
      const sw = evenize(Math.round(W * effectiveScale));
      const sh = evenize(Math.round(H * effectiveScale));
      const x0 = clamp(Math.round((sw - W) / 2 + px), 0, Math.max(0, sw - W));
      const y0 = clamp(Math.round((sh - H) / 2 + py), 0, Math.max(0, sh - H));
      filters.push(`scale=${sw}:${sh}`);
      filters.push(`crop=${W}:${H}:${x0}:${y0}`);
    }
  }

  if (opacity < 1 - EPSILON) {
    const o = opacity.toFixed(3);
    // Atténuation RGB (dim vers noir = composite sur fond noir) + alpha
    // explicite : le yuv420p final aplatit sans compositing coûteux.
    filters.push(`format=rgba,colorchannelmixer=aa=${o}:rr=${o}:gg=${o}:bb=${o}`);
  }

  return filters;
}
