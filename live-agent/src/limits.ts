/**
 * Helpers purs du live-agent — bornage d'intervalles et hygiène des logs.
 *
 * Pourquoi des ensembles FINIS de valeurs ? Les intervalles de heartbeat et
 * de capture d'écran proviennent du message `hello.ack` du gateway (donnée
 * distante). Boulonner la valeur distante sur un barillet CONSTANT garantit
 * qu'aucune valeur contrôlée par le réseau ne peut piloyer directement un
 * `setInterval` (resource-exhaustion) : la fonction renvoie toujours un
 * élément du tableau, jamais la valeur distante elle-même.
 */

/** Barillets d'heartbeat — plancher 5 s (l'agent doit rester « vivant »), plafond 60 s. */
export const HEARTBEAT_INTERVAL_BUCKETS_MS = [5_000, 10_000, 15_000, 30_000, 60_000] as const;

/** Barillets de capture — plancher 900 ms (cadence productive), plafond 60 s (économie batterie/CPU). */
export const FRAME_INTERVAL_BUCKETS_MS = [900, 1_500, 2_000, 3_000, 5_000, 10_000, 30_000, 60_000] as const;

/**
 * Renvoie le PLUS PETIT barillet >= valeur demandée (le gateway obtient une
 * cadence légèrement plus rapide, jamais plus lente que demandée) ; repli
 * sur la valeur par défaut si la demande est absente/non numérique ; clamps
 * sur le dernier barillet si la demande dépasse le plafond.
 */
export function nextIntervalBucket(
  requested: unknown,
  buckets: readonly number[],
  fallback: number,
): number {
  const value = Number(requested);
  if (!Number.isFinite(value)) return fallback;
  for (const bucket of buckets) {
    if (bucket >= value) return bucket;
  }
  return buckets[buckets.length - 1]!;
}

/**
 * Purge les caractères de contrôle C0/C1 (sauts de ligne, retours chariot,
 * séquences ANSI, octets nuls) d'une chaîne destinée aux journaux : un texte
 * distant ne peut ni forger de fausses lignes de log ni polluer le terminal.
 * Longueur plafonnée pour éviter un déluge de journal.
 */
export function sanitizeLogText(value: string, maxLength = 200): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}
