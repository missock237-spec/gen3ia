/**
 * Squelette minimal g3 du chargement de /live/voix (Task 110-b) :
 * mêmes tokens que la page (pastille + fil de transcript en silhouette).
 */
export default function Loading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Chargement de la console Live Voix">
      <div className="h-9 w-56 animate-pulse rounded-xl bg-[var(--g3-elevated)]" />
      <div className="flex flex-col items-center gap-6 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8">
        <div className="h-32 w-32 animate-pulse rounded-full bg-[var(--g3-elevated)]" />
        <div className="h-6 w-64 animate-pulse rounded-lg bg-[var(--g3-elevated)]" />
        <div className="h-4 w-80 animate-pulse rounded-lg bg-[var(--g3-elevated)]" />
      </div>
      <div className="h-48 animate-pulse rounded-3xl bg-[var(--g3-elevated)]" />
    </div>
  );
}
