/**
 * CONDITIONNEUR D'ONDES — portage fidèle de `WaveConditioner.ts` : il
 * convertit une requête utilisateur en spectre d'ondes cibles SANS
 * aucune API externe. Deux voies :
 *
 *  · TEXTE → onde harmonique : l'empreinte fréquentielle de base est
 *    dérivée du hachage du prompt, modulée par 10 harmoniques — le
 *    même texte produit TOUJOURS la même onde cible (déterminisme) ;
 *  · IMAGE → onde spatiale : la luminance (Rec. 601 : 0.299 R +
 *    0.587 G + 0.114 B) des pixels échantillonnés devient l'amplitude
 *    de l'onde cible, normalisée [-1, 1].
 *
 * Ces ondes cibles alimentent l'entraîneur RPIA (entrainement-rpia.ts),
 * le synthétiseur acoustique (synthese-acoustique.ts) et le rendu
 * spatiotemporel (rendu-spatiotemporel.ts) : c'est le point d'entrée
 * qui « met la requête en résonance ».
 *
 * Module PUR : aucune dépendance Node ni navigator.
 */

/**
 * Hachage 31 bits du prompt (fidèle à la source : hash·31 + code, signé
 * 32 bits). Conserver exactement cet algorithme garantit qu'une onde
 * cible produite aujourd'hui reste reproductible plus tard.
 */
export function hachagePrompt(prompt: string): number {
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    hash = (hash << 5) - hash + prompt.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Convertit un texte en onde cible de `nbNoeuds` valeurs (portage
 * fidèle de `encodeTextPrompt`) : fréquence de base induite par le
 * texte (100 – 1099), harmonique (i % 10) + 1, enveloppe cosinus du
 * hachage. Sortie dans [-1, 1] par construction (produit de sinusoïdes).
 */
export function encoderTexteEnOndeCible(prompt: string, nbNoeuds: number): Float32Array {
  if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1) {
    throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (entier ≥ 1 requis).`);
  }
  const ondeCible = new Float32Array(nbNoeuds);
  const hash = hachagePrompt(prompt);

  const frequenceBase = Math.abs(hash % 1000) + 100;

  for (let i = 0; i < nbNoeuds; i++) {
    const harmonique = (i % 10) + 1;
    ondeCible[i] =
      Math.sin((i * frequenceBase * harmonique) / nbNoeuds) * Math.cos(hash / 10000);
  }

  return ondeCible;
}

/**
 * Convertit une image RGBA en onde cible spatiale (portage fidèle de
 * `encodeImageReference`) : chaque nœud échantillonne la luminance d'un
 * pixel (pas régulier), normalisée [-1, 1] (0 → −1, 255 → +1).
 *
 * Adaptation défensive : si l'image contient moins de pixels que de
 * nœuds, le pas est forcé à 1 et les nœuds au-delà du contenu reçoivent
 * 0 (au lieu de lire hors bornes comme la source).
 */
export function encoderImageEnOndeCible(
  pixels: Uint8Array | Uint8ClampedArray,
  largeur: number,
  hauteur: number,
  nbNoeuds: number,
): Float32Array {
  if (!Number.isInteger(nbNoeuds) || nbNoeuds < 1) {
    throw new Error(`Nombre de nœuds invalide : ${nbNoeuds} (entier ≥ 1 requis).`);
  }
  if (largeur * hauteur * 4 !== pixels.length) {
    throw new Error(
      `Taille d'image incohérente : ${pixels.length} octets pour ${largeur}×${hauteur} RGBA.`,
    );
  }
  const ondeCible = new Float32Array(nbNoeuds);
  const totalPixels = largeur * hauteur;
  const pas = Math.max(1, Math.floor((totalPixels * 4) / nbNoeuds));

  for (let i = 0; i < nbNoeuds; i++) {
    const indexPixel = i * pas;
    if (indexPixel + 2 >= pixels.length) break; // au-delà du contenu → 0
    const r = pixels[indexPixel] ?? 0;
    const g = pixels[indexPixel + 1] ?? 0;
    const b = pixels[indexPixel + 2] ?? 0;
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255.0;
    ondeCible[i] = luminance * 2.0 - 1.0;
  }

  return ondeCible;
}

/** Fabrique une image RGBA synthétique (utilitaire de tests et démos). */
export function imageSynthetique(
  largeur: number,
  hauteur: number,
  remplir: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(largeur * hauteur * 4);
  for (let y = 0; y < hauteur; y++) {
    for (let x = 0; x < largeur; x++) {
      const [r, g, b] = remplir(x, y);
      const i = (y * largeur + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}
