/**
 * RNG DÉTERMINISTE (adaptation (a) du portage, documentée).
 *
 * La source Python utilisait le module `random` global : deux exécutions
 * donnaient deux réseaux différents. Pour un système neuronal dont on veut
 * tester la plasticité, sauvegarder l'état et rejouer les cycles, la
 * reproductibilité est essentielle : on remplace `random` par mulberry32,
 * générateur pseudo-aléatoire 32 bits de qualité suffisante pour un SNN,
 * totalement déterministe et seedé.
 *
 * Module PUR — aucune dépendance Node.
 */

/**
 * Crée un générateur pseudo-aléatoire déterministe (mulberry32).
 * Retourne un flottant dans [0, 1) — équivalent de `random.random()` Python.
 */
export function createRng(seed: number): () => number {
  // La graine est normalisée en uint32 (comme mulberry32 l'attend).
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Flottant uniforme dans [min, max) — équivalent de `random.uniform` Python,
 * appelé par la génération initiale des poids synaptiques.
 */
export function randUniform(
  rng: () => number,
  min: number,
  max: number,
): number {
  return min + rng() * (max - min);
}
