"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { ResourceList, type ResourceRow } from "@/components/shells/resource-list";
import { EmptyState, LoadingState } from "@/components/shells/states";

/**
 * /admin/users — comptes et équipes de la plateforme (admin uniquement).
 */

interface AdminUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
  plan: string | null;
  createdAt: { _seconds?: number; _nanoseconds?: number } | null;
  disabled: boolean;
}

interface AdminTeam {
  id: string;
  name: string;
  ownerId: string | null;
  memberCount: number | null;
  createdAt: { _seconds?: number } | null;
}

function formatDate(value: AdminUser["createdAt"]): string {
  const seconds = value?._seconds;
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [teams, setTeams] = useState<AdminTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/admin/users", { cache: "no-store" });
      const body = (await response.json()) as { users?: AdminUser[]; teams?: AdminTeam[]; error?: string };
      if (response.status === 403) throw new Error("Accès réservé aux administrateurs.");
      if (!response.ok) throw new Error(body.error ?? "Chargement impossible.");
      setUsers(body.users ?? []);
      setTeams(body.teams ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingState rows={5} label="Chargement des comptes…" />;

  if (error) {
    return <div className="rounded-2xl border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-300" role="alert">{error}</div>;
  }

  const userRows: ResourceRow[] = users.map((user) => ({
    id: user.id,
    icon: (user.displayName ?? user.email ?? "?").slice(0, 1).toUpperCase(),
    title: user.displayName || user.email || user.id,
    meta: `${user.email ?? "e-mail inconnu"} · créé le ${formatDate(user.createdAt)}`,
    tags: [user.role, ...(user.plan ? [user.plan] : [])],
  }));

  const teamRows: ResourceRow[] = teams.map((team) => ({
    id: team.id,
    icon: "◎",
    title: team.name,
    meta: `${team.memberCount ?? "?"} membre(s) · propriétaire ${team.ownerId ?? "inconnu"}`,
  }));

  return (
    <div className="space-y-7">
      <section aria-label="Utilisateurs">
        <h2 className="mb-3 text-lg font-bold text-[var(--g3-text-secondary)]">Comptes ({users.length} plus récents)</h2>
        <ResourceList
          rows={userRows}
          ariaLabel="Comptes utilisateurs"
          emptyState={<EmptyState icon="◎" title="Aucun compte" description="Les comptes apparaîtront ici dès la première inscription." />}
          className="[&_li]:border-white/10 [&_li]:bg-[var(--g3-surface)]/5 [&_li_*.text-[var(--g3-text)]]:text-[var(--g3-text-secondary)]"
        />
      </section>

      <section aria-label="Équipes">
        <h2 className="mb-3 text-lg font-bold text-[var(--g3-text-secondary)]">Équipes</h2>
        <ResourceList
          rows={teamRows}
          ariaLabel="Équipes"
          emptyState={<EmptyState icon="◈" title="Aucune équipe" description="Les équipes créées par les utilisateurs apparaîtront ici." />}
        />
      </section>
    </div>
  );
}
