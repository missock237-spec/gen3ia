import Link from "next/link";

/**
 * Page 404 soignée : les routes dynamiques invalides (marketplace/[id],
 * approvals/[id], team/[teamId], client/[agentId], fautes de frappe…)
 * doivent offrir une issue claire au lieu du 404 par défaut du framework.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--g3-bg)] p-5 text-neutral-900 md:p-8">
      <section className="anim-scale-in w-full max-w-lg rounded-3xl border border-[var(--g3-border)] bg-white p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100 text-2xl">🧭</div>
        <p className="mt-5 text-xs font-semibold uppercase tracking-[.25em] text-amber-600">Gen3ia · page introuvable</p>
        <h1 className="mt-3 font-serif text-2xl font-semibold">Cette page n&apos;existe pas (ou plus)</h1>
        <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-neutral-500">
          Le lien est peut-être incorrect, ou la ressource a été déplacée ou supprimée.
          Vérifiez l&apos;adresse, ou reprenez depuis votre tableau de bord.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/studio" className="g3-btn g3-btn-primary rounded-full">
            Tableau de bord
          </Link>
          <Link href="/studio" className="g3-btn g3-btn-ghost rounded-full">
            Ouvrir le Studio
          </Link>
        </div>
      </section>
    </div>
  );
}
