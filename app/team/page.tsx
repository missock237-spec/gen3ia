"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";
import { OrganizationsPanel } from "@/components/team/OrganizationsPanel";
import { useTeam, type Team } from "@/lib/team/useTeam";

/**
 * Espace Équipes — liste les équipes de l'utilisateur, permet d'en créer
 * une nouvelle et de rejoindre une équipe via un code d'invitation.
 * Accessible uniquement aux utilisateurs connectés. Les données passent
 * par l'API serveur (/api/teams) qui écrit dans la base Firestore Admin.
 */

function TeamsContent() {
  const { createTeam, fetchMyTeams } = useTeam();
  const router = useRouter();
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinToken, setJoinToken] = useState("");

  const refresh = useCallback(async () => {
    try {
      const loaded = await fetchMyTeams();
      setTeams(loaded);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Impossible de charger vos équipes pour le moment.");
      setTeams([]);
    }
  }, [fetchMyTeams]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const teamId = await createTeam(name.trim(), description.trim());
      router.push(`/team/${teamId}`);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Création impossible.");
    } finally {
      setCreating(false);
    }
  };

  const handleJoinToken = () => {
    const token = joinToken.trim();
    if (!token) return;
    router.push(`/team/join?token=${encodeURIComponent(token)}`);
  };

  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-neutral-900">
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-8 md:py-14">
        {/* En-tête */}
        <header className="anim-fade-up text-center">
          <p className="g3-eyebrow">Gen3ia · Collaboration</p>
          <h1 className="mt-3 font-serif text-4xl font-semibold tracking-tight md:text-5xl">
            Vos équipes, au même endroit.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-neutral-500 md:text-base">
            Créez un espace partagé, invitez vos collaborateurs et gardez vos agents,
            documents et sessions accessibles à toute l&apos;équipe.
          </p>
        </header>

        <div className="mt-10 anim-fade-up anim-delay-1">
          <OrganizationsPanel />
        </div>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-5">
          {/* Colonne principale : mes équipes */}
          <section className="anim-fade-up anim-delay-1 lg:col-span-3" aria-label="Mes équipes">
            <div className="rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] md:p-8">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-serif text-2xl font-semibold">Mes équipes</h2>
                <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold text-neutral-500">
                  {teams ? `${teams.length} équipe${teams.length > 1 ? "s" : ""}` : "…"}
                </span>
              </div>

              {loadError && (
                <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                  {loadError}
                </p>
              )}

              {teams === null && !loadError && (
                <div className="mt-6 space-y-3" aria-hidden="true">
                  {[0, 1].map((index) => (
                    <div key={index} className="h-20 animate-pulse rounded-2xl bg-neutral-100" />
                  ))}
                </div>
              )}

              {teams?.length === 0 && (
                <div className="mt-6 rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/60 p-8 text-center">
                  <p className="font-serif text-lg font-semibold text-neutral-800">Aucune équipe pour l&apos;instant</p>
                  <p className="mt-2 text-sm leading-6 text-neutral-500">
                    Créez votre premier espace d&apos;équipe avec le formulaire « Nouvelle équipe »,
                    ou rejoignez-en une grâce au code d&apos;invitation reçu par email.
                  </p>
                </div>
              )}

              {teams && teams.length > 0 && (
                <ul className="mt-6 space-y-3">
                  {teams.map((team) => (
                    <li key={team.id}>
                      <Link
                        href={`/team/${team.id}`}
                        className="group flex items-center justify-between gap-4 rounded-2xl border border-[var(--g3-border)] bg-white p-4 transition hover:border-neutral-300 hover:shadow-[0_10px_30px_-12px_rgba(15,23,42,0.18)]"
                      >
                        <span className="flex min-w-0 items-center gap-4">
                          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-sky-100 font-serif text-lg font-semibold text-sky-700">
                            {team.name.charAt(0).toUpperCase()}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-neutral-900">{team.name}</span>
                            <span className="mt-0.5 block truncate text-xs text-neutral-500">
                              {Number(team.memberCount ?? 1)} membre{Number(team.memberCount ?? 1) > 1 ? "s" : ""}
                              {team.description ? ` · ${team.description}` : ""}
                            </span>
                          </span>
                        </span>
                        <svg
                          width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
                          className="shrink-0 text-neutral-300 transition group-hover:translate-x-1 group-hover:text-neutral-500"
                        >
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* Colonne latérale : créer + rejoindre */}
          <aside className="anim-fade-up anim-delay-2 space-y-6 lg:col-span-2">
            <div className="rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
              <h2 className="font-serif text-xl font-semibold">Nouvelle équipe</h2>
              <p className="mt-1.5 text-xs leading-5 text-neutral-500">
                Vous en devenez le propriétaire et pourrez inviter des membres.
              </p>
              <div className="mt-4 space-y-3">
                <div>
                  <label htmlFor="team-name" className="g3-label">Nom de l&apos;équipe</label>
                  <input
                    id="team-name"
                    type="text"
                    maxLength={200}
                    placeholder="Ex. Studio Marketing"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="g3-input"
                  />
                </div>
                <div>
                  <label htmlFor="team-description" className="g3-label">Description (optionnel)</label>
                  <textarea
                    id="team-description"
                    rows={2}
                    maxLength={2000}
                    placeholder="À quoi servira cette équipe ?"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    className="g3-textarea"
                  />
                </div>
                {createError && (
                  <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
                    {createError}
                  </p>
                )}
                <button
                  type="button"
                  onClick={handleCreate}
                  disabled={creating || !name.trim()}
                  className="g3-btn g3-btn-primary w-full rounded-full"
                >
                  {creating ? "Création…" : "Créer l'équipe"}
                </button>
              </div>
            </div>

            <div className="rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
              <h2 className="font-serif text-xl font-semibold">Rejoindre une équipe</h2>
              <p className="mt-1.5 text-xs leading-5 text-neutral-500">
                Collez le code reçu dans l&apos;invitation (le lien contient <code className="rounded bg-neutral-100 px-1">?token=…</code>).
              </p>
              <div className="mt-4 space-y-3">
                <input
                  type="text"
                  placeholder="Code d'invitation"
                  value={joinToken}
                  onChange={(event) => setJoinToken(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") handleJoinToken(); }}
                  className="g3-input"
                  aria-label="Code d'invitation"
                />
                <button
                  type="button"
                  onClick={handleJoinToken}
                  disabled={!joinToken.trim()}
                  className="g3-btn g3-btn-ghost w-full rounded-full"
                >
                  Ouvrir l&apos;invitation
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default function TeamsPage() {
  return (
    <FeatureAuthGate
      feature="Espace Équipes"
      description="Connectez-vous pour retrouver vos équipes, en créer une nouvelle ou accepter une invitation."
    >
      <TeamsContent />
    </FeatureAuthGate>
  );
}
