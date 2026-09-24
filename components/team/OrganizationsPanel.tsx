"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Panneau Organisations (multi-tenant) : crée une organisation, invite des
 * membres, gère les rôles et affiche les quotas du plan. Toutes les
 * opérations passent par l'API serveur /api/organizations (Admin SDK).
 */

type OrgRole = "owner" | "admin" | "member";
type OrgPlan = "free" | "pro" | "enterprise";

type Organization = {
  id: string;
  name: string;
  plan: OrgPlan;
  isolation: "pool" | "silo";
  ownerId: string;
  memberCount: number;
  myRole: OrgRole;
  createdAt: string | null;
};

type Member = { userId: string; email: string; displayName: string; role: OrgRole; joinedAt: string | null };
type Invitation = { id: string; email: string; role: OrgRole; status: string; expiresAt: string | null };
type PendingInvitation = Invitation & { orgId: string; orgName: string; valid: boolean };
type Quotas = { maxMembers: number; maxAgents: number; maxProjects: number; monthlyCredits: number; storageGb: number };

const ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Membre" };

export function OrganizationsPanel() {
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ members: Member[]; invitations: Invitation[]; quotas: Quotas } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/organizations", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Organisations indisponibles.");
      setOrganizations((data.organizations ?? []) as Organization[]);
      setPendingInvitations((data.invitations ?? []) as PendingInvitation[]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Organisations indisponibles.");
      setOrganizations([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function loadDetail(orgId: string) {
    setDetailLoading(true);
    try {
      const response = await fetch(`/api/organizations/${orgId}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Détail indisponible.");
      setDetail({ members: data.members ?? [], invitations: data.invitations ?? [], quotas: data.quotas });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Détail indisponible.");
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function createOrganization() {
    if (!name.trim() || creating) return;
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create", name: name.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Création impossible.");
      setName("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible.");
    } finally {
      setCreating(false);
    }
  }

  async function acceptInvitation(invitation: PendingInvitation) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "accept", orgId: invitation.orgId, invitationId: invitation.id }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Acceptation impossible.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Acceptation impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function memberAction(orgId: string, body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/organizations/${orgId}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Opération impossible.");
      await loadDetail(orgId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Opération impossible.");
    } finally {
      setBusy(false);
    }
  }

  function toggleExpand(org: Organization) {
    if (expanded === org.id) { setExpanded(null); setDetail(null); return; }
    setExpanded(org.id);
    setDetail(null);
    void loadDetail(org.id);
  }

  const canManage = (org: Organization) => org.myRole === "owner" || org.myRole === "admin";

  return (
    <section className="anim-fade-up rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] md:p-8" aria-label="Organisations">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-serif text-2xl font-semibold">Organisations</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
            Espace multi-tenant : isolez agents, projets et membres par organisation, avec quotas par plan.
          </p>
        </div>
        <span className="rounded-full bg-[var(--g3-elevated)] px-3 py-1 text-xs font-semibold text-[var(--g3-muted)]">
          {organizations ? `${organizations.length} organisation${organizations.length > 1 ? "s" : ""}` : "…"}
        </span>
      </div>

      {error && <p role="alert" className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{error}</p>}

      {pendingInvitations.length > 0 && (
        <div className="mt-5 space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-faint)]">Invitations en attente</p>
          {pendingInvitations.map((invitation) => (
            <div key={invitation.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3">
              <span className="min-w-0 flex-1 text-xs text-sky-900">
                <strong className="block truncate text-sm">{invitation.orgName}</strong>
                Rôle proposé : {ROLE_LABEL[invitation.role]}
              </span>
              <button
                type="button"
                disabled={busy || !invitation.valid}
                onClick={() => void acceptInvitation(invitation)}
                className="g3-btn g3-btn-primary rounded-full px-4 py-2 text-xs disabled:opacity-40"
              >
                {invitation.valid ? "Rejoindre" : "Expirée"}
              </button>
            </div>
          ))}
        </div>
      )}

      {organizations === null ? (
        <div className="mt-6 h-16 animate-pulse rounded-2xl bg-[var(--g3-elevated)]" aria-hidden="true" />
      ) : organizations.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-dashed border-[var(--g3-border-strong)] bg-[var(--g3-elevated)]/60 p-5 text-sm leading-6 text-[var(--g3-muted)]">
          Aucune organisation. Créez-en une pour structurer votre entreprise : isolation des données, rôles et quotas par plan.
        </p>
      ) : (
        <ul className="mt-5 space-y-3">
          {organizations.map((org) => (
            <li key={org.id} className="rounded-2xl border border-[rgba(23,23,20,0.09)]">
              <button
                type="button"
                onClick={() => toggleExpand(org)}
                aria-expanded={expanded === org.id}
                className="flex w-full items-center gap-4 p-4 text-left transition hover:bg-[var(--g3-elevated)]"
              >
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-violet-100 font-serif text-lg font-semibold text-violet-700">
                  {org.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-semibold text-[var(--g3-text)]">{org.name}</span>
                    <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-violet-700">{org.plan}</span>
                    <span className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--g3-muted)]">{ROLE_LABEL[org.myRole]}</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-[var(--g3-muted)]">{org.memberCount} membre{org.memberCount > 1 ? "s" : ""} · isolation {org.isolation === "silo" ? "silo (dédiée)" : "pool (partagée)"}</span>
                </span>
                <span aria-hidden="true" className="text-[var(--g3-faint)]">{expanded === org.id ? "−" : "+"}</span>
              </button>

              {expanded === org.id && (
                <div className="border-t border-[rgba(23,23,20,0.09)] p-4">
                  {detailLoading || !detail ? (
                    <p className="text-xs text-[var(--g3-faint)]">Chargement des membres…</p>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 gap-2 text-[11px] text-[var(--g3-muted)] sm:grid-cols-4">
                        <span className="rounded-xl bg-[var(--g3-elevated)] px-3 py-2">Membres : <strong>{detail.members.length}/{detail.quotas.maxMembers}</strong></span>
                        <span className="rounded-xl bg-[var(--g3-elevated)] px-3 py-2">Agents : <strong>{detail.quotas.maxAgents}</strong></span>
                        <span className="rounded-xl bg-[var(--g3-elevated)] px-3 py-2">Crédits/mois : <strong>{detail.quotas.monthlyCredits.toLocaleString("fr-FR")}</strong></span>
                        <span className="rounded-xl bg-[var(--g3-elevated)] px-3 py-2">Stockage : <strong>{detail.quotas.storageGb} Go</strong></span>
                      </div>

                      <ul className="mt-4 space-y-2">
                        {detail.members.map((member) => (
                          <li key={member.userId} className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--g3-elevated)] px-3 py-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold text-[var(--g3-text)]">{member.displayName || member.email}</span>
                              <span className="block truncate text-[10px] text-[var(--g3-faint)]">{member.email}</span>
                            </span>
                            <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${member.role === "owner" ? "bg-violet-100 text-violet-700" : member.role === "admin" ? "bg-sky-100 text-sky-700" : "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
                              {ROLE_LABEL[member.role]}
                            </span>
                            {canManage(org) && member.role !== "owner" && (
                              <>
                                <select
                                  aria-label={`Rôle de ${member.email}`}
                                  value={member.role}
                                  disabled={busy}
                                  onChange={(event) => void memberAction(org.id, { action: "role", memberId: member.userId, role: event.target.value })}
                                  className="rounded-lg border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-1 text-[10px]"
                                >
                                  <option value="member">Membre</option>
                                  <option value="admin">Admin</option>
                                </select>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void memberAction(org.id, { action: "remove", memberId: member.userId })}
                                  className="rounded-lg border border-red-200 bg-[var(--g3-surface)] px-2 py-1 text-[10px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40"
                                >
                                  Retirer
                                </button>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>

                      {detail.invitations.length > 0 && canManage(org) && (
                        <div className="mt-3">
                          <p className="text-[10px] font-bold uppercase tracking-[.2em] text-[var(--g3-faint)]">Invitations en attente</p>
                          <ul className="mt-2 space-y-1.5">
                            {detail.invitations.map((invitation) => (
                              <li key={invitation.id} className="flex items-center gap-2 text-xs text-[var(--g3-muted)]">
                                <span className="min-w-0 flex-1 truncate">{invitation.email} · {ROLE_LABEL[invitation.role]}</span>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void memberAction(org.id, { action: "revoke", invitationId: invitation.id })}
                                  className="rounded-lg border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-1 text-[10px] font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)] disabled:opacity-40"
                                >
                                  Révoquer
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {canManage(org) && (
                        <div className="mt-4 flex flex-wrap items-end gap-2">
                          <div className="min-w-[200px] flex-1">
                            <label htmlFor={`invite-${org.id}`} className="g3-label">Inviter par email</label>
                            <input
                              id={`invite-${org.id}`}
                              type="email"
                              value={inviteEmail}
                              onChange={(event) => setInviteEmail(event.target.value)}
                              placeholder="collegue@entreprise.com"
                              className="g3-input"
                            />
                          </div>
                          <select
                            aria-label="Rôle de l'invitation"
                            value={inviteRole}
                            onChange={(event) => setInviteRole(event.target.value as "admin" | "member")}
                            className="g3-input w-auto"
                          >
                            <option value="member">Membre</option>
                            <option value="admin">Admin</option>
                          </select>
                          <button
                            type="button"
                            disabled={busy || !inviteEmail.trim()}
                            onClick={() => void memberAction(org.id, { action: "invite", email: inviteEmail.trim(), role: inviteRole })}
                            className="g3-btn g3-btn-primary rounded-full disabled:opacity-40"
                          >
                            Inviter
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-end gap-2 border-t border-[rgba(23,23,20,0.09)] pt-5">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="new-org-name" className="g3-label">Nouvelle organisation</label>
          <input
            id="new-org-name"
            type="text"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ex. Agence Nord SARL"
            className="g3-input"
          />
        </div>
        <button
          type="button"
          onClick={() => void createOrganization()}
          disabled={creating || !name.trim()}
          className="g3-btn g3-btn-primary rounded-full disabled:opacity-40"
        >
          {creating ? "Création…" : "Créer l'organisation"}
        </button>
      </div>
    </section>
  );
}
