// app/team/[teamId]/page.tsx
'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTeam } from '@/lib/team/useTeam';
import { TeamMembersPanel } from '@/components/team/TeamMembersPanel';

export default function TeamPage() {
  const params = useParams();
  const teamId = params.teamId as string;
  const { team, loading, error } = useTeam(teamId);

  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-neutral-900">
      <div className="mx-auto max-w-5xl space-y-8 px-4 py-10 md:px-8 md:py-14">
        {loading && (
          <div className="rounded-3xl border border-[var(--g3-border)] bg-white p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-sky-500" />
            <p className="mt-4 text-sm text-neutral-500">Chargement de l&apos;équipe…</p>
          </div>
        )}

        {!loading && !team && (
          <div className="anim-scale-in mx-auto max-w-md rounded-3xl border border-[var(--g3-border)] bg-white p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-100 text-2xl">🔒</div>
            <h1 className="mt-5 font-serif text-2xl font-semibold">Équipe introuvable ou accès refusé</h1>
            <p className="mt-3 text-sm leading-6 text-neutral-500">
              {error
                ? error
                : "Cette équipe n'existe pas, ou votre compte n'en est pas encore membre."}
            </p>
            <Link href="/team" className="g3-btn g3-btn-primary mt-6 rounded-full">Aller à mes équipes</Link>
          </div>
        )}

        {!loading && team && (
          <>
            {/* En-tête équipe */}
            <header className="anim-fade-up rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] md:p-8">
              <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-4">
                  <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-sky-100 font-serif text-2xl font-semibold text-sky-700">
                    {team.name.charAt(0).toUpperCase()}
                  </span>
                  <div>
                    <p className="g3-eyebrow">Espace d&apos;équipe</p>
                    <h1 className="mt-1 font-serif text-3xl font-semibold tracking-tight">{team.name}</h1>
                    {team.description && <p className="mt-1.5 text-sm text-neutral-500">{team.description}</p>}
                    <p className="mt-1 text-xs font-medium text-neutral-400">
                      {Number(team.memberCount ?? 1)} membre{Number(team.memberCount ?? 1) > 1 ? "s" : ""}
                    </p>
                  </div>
                </div>
                <Link href="/team" className="g3-btn g3-btn-ghost w-fit shrink-0 rounded-full">
                  Toutes mes équipes
                </Link>
              </div>
            </header>

            {/* Intelligence d'équipe avancée */}
            <section
              className="anim-fade-up anim-delay-1 rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] md:p-8"
              aria-label="Intelligence d'équipe avancée"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-serif text-2xl font-semibold">Intelligence d&apos;équipe avancée</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-neutral-500">
                    Coordination automatique, mémoire de travail optimisée et anticipation
                    préventive des échecs pour vos agents collaboratifs.
                  </p>
                </div>
                <Link
                  href={`/team/${encodeURIComponent(teamId)}/advanced`}
                  className="g3-btn g3-btn-primary w-fit shrink-0 rounded-full"
                >
                  Ouvrir
                </Link>
              </div>
            </section>

            {/* Membres */}
            <section className="anim-fade-up anim-delay-2" aria-label="Membres de l'équipe">
              <div className="rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] md:p-8">
                <h2 className="font-serif text-2xl font-semibold">Membres de l&apos;équipe</h2>
                <div className="mt-5">
                  <TeamMembersPanel teamId={teamId} />
                </div>
              </div>
            </section>

            {/* Espace de travail partagé */}
            <section className="anim-fade-up anim-delay-3" aria-label="Espace de travail partagé">
              <div className="rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] md:p-8">
                <h2 className="font-serif text-2xl font-semibold">Espace de travail partagé</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">
                  Les agents, documents et sessions de cette équipe restent disponibles avec
                  l&apos;ensemble des fonctionnalités de Gen3ia, pour chaque membre autorisé.
                </p>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
