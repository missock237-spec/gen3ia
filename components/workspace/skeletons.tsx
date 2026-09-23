/**
 * Skeletons de navigation (route-level loading.tsx).
 *
 * Objectif UX : la navigation entre les pages de l'espace de travail affiche
 * IMMÉDIATEMENT une silhouette de la page cible (au lieu d'un écran figé),
 * puis les données arrivent. Composants serveur purs (zéro JS client) :
 * les fichiers app/workspace/**\/loading.tsx les rendent pendant le
 * chargement du segment.
 *
 * Les formes reprennent les gabarits réels de chaque page (grille de cartes
 * projets, colonnes conversations, liste de fichiers) pour minimiser la
 * perception de saut de layout (CLS) à l'arrivée des données.
 */

export function PageHeaderSkeleton() {
  return (
    <div className="mb-4 space-y-2">
      <div className="h-6 w-52 animate-pulse rounded-lg bg-neutral-200/70" />
      <div className="h-3.5 w-80 animate-pulse rounded-lg bg-neutral-200/50" />
    </div>
  );
}

export function CardGridSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Chargement du contenu">
      {Array.from({ length: cards }, (_, i) => (
        <li key={i} className="g3-card !p-4">
          <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-200/70" />
          <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-neutral-200/50" />
          <div className="mt-3 space-y-1.5">
            <div className="h-3 w-full animate-pulse rounded bg-neutral-200/40" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-neutral-200/40" />
          </div>
          <div className="mt-3 flex gap-1.5">
            <div className="h-4 w-20 animate-pulse rounded-full bg-neutral-200/60" />
            <div className="h-4 w-14 animate-pulse rounded-full bg-neutral-200/60" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Chargement de la liste">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="g3-card flex items-center justify-between gap-3 !p-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3.5 w-1/2 animate-pulse rounded bg-neutral-200/70" />
            <div className="h-3 w-1/4 animate-pulse rounded bg-neutral-200/50" />
          </div>
          <div className="h-7 w-16 shrink-0 animate-pulse rounded-lg bg-neutral-200/60" />
        </div>
      ))}
    </div>
  );
}

/** Silhouette de l'espace conversation : colonnes gauche + centre. */
export function ConversationColumnsSkeleton() {
  return (
    <div className="flex h-full gap-4" aria-busy="true" aria-label="Chargement de l'espace de conversation">
      <div className="hidden w-64 shrink-0 flex-col gap-3 md:flex">
        <div className="h-9 animate-pulse rounded-lg bg-neutral-200/70" />
        <div className="h-8 animate-pulse rounded-lg bg-neutral-200/50" />
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-neutral-200/40" />
          ))}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3">
        <div className="h-10 animate-pulse rounded-xl bg-neutral-200/50" />
        <div className="flex-1 space-y-3 py-2">
          <div className="h-16 w-3/4 animate-pulse rounded-2xl bg-neutral-100" />
          <div className="ml-auto h-16 w-2/3 animate-pulse rounded-2xl bg-neutral-100" />
          <div className="h-16 w-2/3 animate-pulse rounded-2xl bg-neutral-100" />
        </div>
        <div className="h-16 animate-pulse rounded-2xl bg-neutral-200/60" />
      </div>
    </div>
  );
}
