import "server-only";

/**
 * GEN3IA VIDEO AGENT — Task 120 : utilitaire de concurrence BORNÉE maison.
 *
 * Aucune dépendance npm (pico-limit, p-map…) : budget bundle surveillé — un
 * pool de ~25 lignes suffit. Contrats :
 *   - l'ORDRE des résultats suit l'ordre des entrées (index stable) ;
 *   - concurrence stricte : jamais plus de `limit` workers simultanés ;
 *   - erreurs ISOLÉES : un item qui jette n'interrompt pas les autres — le
 *     résultat porte status "rejected" (+ raison) ;
 *   - `shouldStart` consulté AVANT chaque démarrage : permet d'honorer un
 *     budget temps (deadline serverless) sans casser l'ordre — l'item non
 *     démarré est marqué "skipped" (le curseur/checkpoint de l'appelant
 *     reste maître de la reprise).
 */

export type ConcurrencyOutcome<R> =
  | { status: "fulfilled"; value: R }
  | { status: "rejected"; reason: unknown }
  | { status: "skipped" };

export interface MapWithConcurrencyOptions {
  /**
   * Consulté avant le démarrage de CHAQUE item (index passé). false →
   * l'item est marqué "skipped" SANS consommer de worker.
   */
  shouldStart?: (index: number) => boolean;
}

/**
 * Exécute `worker` sur chaque item avec au plus `limit` exécutions
 * simultanées. Retourne un résultat PAR ITEM, dans l'ordre d'entrée.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {},
): Promise<ConcurrencyOutcome<R>[]> {
  const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
  const results: ConcurrencyOutcome<R>[] = new Array(items.length).fill(null).map(() => ({ status: "skipped" }));
  let cursor = 0;

  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      if (options.shouldStart && !options.shouldStart(index)) {
        results[index] = { status: "skipped" };
        continue;
      }
      try {
        const value = await worker(items[index], index);
        results[index] = { status: "fulfilled", value };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(safeLimit, items.length); i += 1) {
    workers.push(runNext());
  }
  await Promise.all(workers);
  return results;
}

/** true si au moins un résultat est rejeté (helper de lisibilité). */
export function anyRejected<R>(outcomes: ReadonlyArray<ConcurrencyOutcome<R>>): boolean {
  return outcomes.some((o) => o.status === "rejected");
}

/** Première raison de rejet dans l'ORDRE des entrées (déterminisme). */
export function firstRejectedReason<R>(outcomes: ReadonlyArray<ConcurrencyOutcome<R>>): unknown {
  const rejected = outcomes.find((o) => o.status === "rejected");
  return rejected && rejected.status === "rejected" ? rejected.reason : undefined;
}
