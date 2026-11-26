/**
 * FRAME BUFFER + SELECTOR — mission GEN3IA LIVE Phase 3 (« Ne pas analyser
 * toutes les images systématiquement »). Décodage RÉEL des pixels via sharp
 * (dépendance locale du dépôt, pas une IA) : downscale gris → dHash
 * perceptuel (64 bits déterministe) → distance de Hamming pour le
 * changement grossier, puis diff pixel EXACTE bornée à la résolution
 * réduite pour la mesure fine. Une frame identique est IGNORÉE (dédup),
 * une frame changée est SÉLECTIONNÉE avec sa zone de modification mesurée.
 */

export interface FrameAnalysable {
  horodatage: number;
  /** Hash perceptuel 64 bits (dHash — déterministe). */
  hash: string;
  /** Grille réduite de luminance [0..255] (diff fine exacte). */
  grille: Uint8Array;
  largeur: number;
  hauteur: number;
  /** Distance de Hamming avec la frame précédente retenue. */
  distanceHash: number;
  /** Diff moyenne absolue vs précédente [0..255]. */
  diffMoyenne: number;
  /** Proportion de pixels changés au-delà du seuil [0..1]. */
  proportionChangee: number;
  /** true si la frame doit être ANALYSÉE (changement réel). */
  selectionnee: boolean;
  raison: "premiere-frame" | "identique-ignoree" | "changement-detecte";
}

const GRILLE_W = 64;
const GRILLE_H = 32;
const SEUIL_PIXEL = 18; // /255 : bruit de compression toléré (mission : détection de changement réelle)

/** dHash 64 bits couvrant TOUTE la grille (8 lignes × 9 colonnes réparties). */
function dHash(grille: Uint8Array, largeur: number, hauteur: number): string {
  const bits: number[] = [];
  for (let y = 0; y < 8; y++) {
    const ligne = Math.floor((y * hauteur) / 8);
    const base = ligne * largeur;
    for (let x = 0; x < 9; x++) {
      const i = base + Math.floor((x * largeur) / 9);
      bits.push(i + 1 < grille.length && grille[i + 1] < grille[i] ? 1 : 0);
    }
  }
  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += (bits[i] * 8 + bits[i + 1] * 4 + bits[i + 2] * 2 + bits[i + 3]).toString(16);
  }
  return hex;
}

function distanceHamming(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    d += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return d;
}

/** Analyse une frame JPEG réelle et décide : analyser ou ignorer. */
export async function analyserFrame(
  jpeg: Buffer,
  precedente: FrameAnalysable | null,
  decoderGrille: (b: Buffer) => Promise<{ grille: Uint8Array; largeur: number; hauteur: number }>,
  options: { seuilChangement?: number } = {},
): Promise<FrameAnalysable> {
  const { grille, largeur } = await decoderGrille(jpeg);
  const hash = dHash(grille, largeur, GRILLE_H);
  if (!precedente) {
    return {
      horodatage: Date.now(), hash, grille, largeur, hauteur: GRILLE_H,
      distanceHash: 0, diffMoyenne: 0, proportionChangee: 0,
      selectionnee: true, raison: "premiere-frame",
    };
  }
  const distanceHash = distanceHamming(hash, precedente.hash);
  let somme = 0;
  let changes = 0;
  const n = Math.min(grille.length, precedente.grille.length);
  for (let i = 0; i < n; i++) {
    const d = Math.abs(grille[i] - precedente.grille[i]);
    somme += d;
    if (d > SEUIL_PIXEL) changes++;
  }
  const diffMoyenne = somme / n;
  const proportionChangee = changes / n;
  const seuil = options.seuilChangement ?? 0.02; // 2 % de pixels changés → sélection
  const selectionnee = distanceHash >= 6 || proportionChangee >= seuil;
  return {
    horodatage: Date.now(), hash, grille, largeur, hauteur: GRILLE_H,
    distanceHash, diffMoyenne, proportionChangee, selectionnee,
    raison: selectionnee ? "changement-detecte" : "identique-ignoree",
  };
}

/** Fabrique réelle de grille via sharp (downscale gris, déterministe). */
export function fabriqueGrilleSharp(): (b: Buffer) => Promise<{ grille: Uint8Array; largeur: number; hauteur: number }> {
  return async (b: Buffer) => {
    const sharpMod = (await import("sharp")).default;
    const brut = await sharpMod(b)
      .resize(GRILLE_W, GRILLE_H, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer();
    return { grille: new Uint8Array(brut), largeur: GRILLE_W, hauteur: GRILLE_H };
  };
}

/** Buffer borné des frames retenues (mémoire temporelle — mission Phase 3-C). */
export function creerFrameBuffer(tailleMax = 20) {
  const frames: FrameAnalysable[] = [];
  return {
    ajouter(f: FrameAnalysable): void {
      frames.push(f);
      if (frames.length > tailleMax) frames.shift();
    },
    frames(): readonly FrameAnalysable[] { return frames; },
    derniere(): FrameAnalysable | null { return frames.length ? frames[frames.length - 1] : null; },
  };
}
