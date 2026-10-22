import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Identifiant de build EFFECTIVEMENT servi par ce process — .next/BUILD_ID.
 *
 * `next build` régénère ce fichier à chaque build ; sur le VPS,
 * cd-finisher.sh swappe .next atomiquement à chaque déploiement : lire ce
 * fichier donne une empreinte qui change à CHAQUE mise en production
 * (correctif 2026-10-22 — l'ancienne chaîne Vercel retombait sur
 * « local-dev » constant sur le VPS auto-hébergé, rendant le
 * rechargement automatique des onglets aveugle aux déploiements).
 *
 * Module volontairement MINUSCULE et sans dépendance : appelé par
 * /api/deploy-info, sondé toutes les ~90 s par chaque onglet ouvert.
 *
 * @param cwd racine de l'application (injectable pour les tests) —
 *            défaut : process.cwd(), là où `next start` sert .next.
 * @returns l'identifiant de build trimé, ou null s'il est absent ou vide
 *          (dev sans build, disque illisible) — JAMAIS d'exception.
 */
export function readBuildId(cwd: string = process.cwd()): string | null {
  try {
    const raw = readFileSync(join(cwd, ".next", "BUILD_ID"), "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    // Fichier absent (dev), swap en cours, permissions : repli côté appelant.
    return null;
  }
}
