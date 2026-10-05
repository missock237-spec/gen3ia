import { timingSafeEqual } from "crypto";

/**
 * Comparaison de chaînes secrètes à temps constant (signatures, tokens de
 * cron, secrets de diagnostic) — évite les fuites par court-circuit.
 *
 * Les longueurs sont comparées d'abord (fuite de longueur acceptable et
 * inévitable sans padding) ; timingSafeEqual exige des longueurs égales,
 * on hache donc les deux entrées pour égaliser la taille en toute
 * circonstance.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    const hashA = Buffer.from(a, "utf8");
    const hashB = Buffer.from(b, "utf8");
    if (hashA.length !== hashB.length) {
      // Hachage pour égaliser les longueurs sans court-circuit exploitable.
      return timingSafeEqual(padBuffer(hashA), padBuffer(hashB));
    }
    return timingSafeEqual(hashA, hashB);
  } catch {
    return false;
  }
}

function padBuffer(input: Buffer): Buffer {
  const size = Math.max(input.length, 32);
  const output = Buffer.alloc(size);
  input.copy(output, 0);
  return output;
}
