// components/team/TeamMembersPanel.tsx
'use client';

import { useState } from 'react';
import { useTeam, TEAM_ROLE_LABELS, type TeamRole } from '@/lib/team/useTeam';

const ROLES: TeamRole[] = ['owner', 'admin', 'editor', 'viewer'];

export function TeamMembersPanel({ teamId }: { teamId: string }) {
  const { members, myRole, inviteMember, updateMemberRole, removeMember, reload } = useTeam(teamId);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<TeamRole>('editor');
  const [inviting, setInviting] = useState(false);
  const [busyMember, setBusyMember] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [lastToken, setLastToken] = useState<string | null>(null);

  const canManage = myRole === 'owner' || myRole === 'admin';

  const handleInvite = async () => {
    if (!inviteEmail.trim() || inviting) return;
    setInviting(true);
    setFeedback(null);
    try {
      const invitationToken = await inviteMember(inviteEmail.trim(), inviteRole);
      setLastToken(invitationToken);
      setFeedback({
        kind: 'ok',
        text: `Invitation créée pour ${inviteEmail.trim()}. Partagez ce lien sécurisé — il reste valable 7 jours.`,
      });
      setInviteEmail('');
    } catch (error) {
      const message = error instanceof Error ? error.message : "Échec de l'envoi de l'invitation.";
      setFeedback({ kind: 'error', text: message });
    } finally {
      setInviting(false);
    }
  };

  const handleChangeRole = async (memberId: string, role: TeamRole) => {
    setBusyMember(memberId);
    setFeedback(null);
    try {
      await updateMemberRole(memberId, role);
      await reload?.();
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Modification impossible.' });
    } finally {
      setBusyMember(null);
    }
  };

  const handleRemove = async (memberId: string) => {
    setBusyMember(memberId);
    setFeedback(null);
    try {
      await removeMember(memberId);
      await reload?.();
      setFeedback({ kind: 'ok', text: "Membre retiré de l'équipe." });
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : 'Suppression impossible.' });
    } finally {
      setBusyMember(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Formulaire d'invitation */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="invite-email" className="g3-label">Inviter par email</label>
          <input
            id="invite-email"
            type="email"
            placeholder="membre@exemple.com"
            value={inviteEmail}
            onChange={(event) => setInviteEmail(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void handleInvite(); }}
            className="g3-input"
          />
        </div>
        <div className="sm:w-44">
          <label htmlFor="invite-role" className="g3-label">Rôle</label>
          <select
            id="invite-role"
            value={inviteRole}
            onChange={(event) => setInviteRole(event.target.value as TeamRole)}
            className="g3-select"
          >
            {ROLES.filter((role) => role !== 'owner').map((role) => (
              <option key={role} value={role}>{TEAM_ROLE_LABELS[role]}</option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={handleInvite}
          disabled={inviting || !inviteEmail.trim() || !canManage}
          title={canManage ? undefined : 'Seuls les propriétaires et admins peuvent inviter'}
          className="g3-btn g3-btn-primary shrink-0 rounded-full"
        >
          {inviting ? 'Envoi…' : 'Inviter'}
        </button>
      </div>

      {!canManage && (
        <p className="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-xs leading-5 text-neutral-500">
          Seuls les propriétaires et admins de l&apos;équipe peuvent inviter et gérer les membres.
        </p>
      )}

      {feedback && (
        <div
          role="status"
          className={`rounded-2xl px-4 py-3 text-sm leading-6 ${
            feedback.kind === 'ok'
              ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border border-red-200 bg-red-50 text-red-700'
          }`}
        >
          <p>{feedback.text}</p>
          {feedback.kind === 'ok' && lastToken && (
            <code className="mt-2 block truncate rounded-lg bg-white/80 px-2 py-1 text-xs text-emerald-900">
              {`${typeof window !== 'undefined' ? window.location.origin : ''}/team/join?token=${lastToken}`}
            </code>
          )}
        </div>
      )}

      {/* Liste des membres */}
      <ul className="space-y-2.5">
        {members.map((member) => (
          <li
            key={member.userId}
            className="flex flex-col gap-3 rounded-2xl border border-[var(--g3-border)] bg-white p-4 transition hover:border-neutral-300 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-center gap-3">
              {member.photoURL ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={member.photoURL} alt="" className="h-10 w-10 shrink-0 rounded-full border border-neutral-200" />
              ) : (
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-neutral-100 text-sm font-semibold text-neutral-500">
                  {(member.displayName || member.email || '?').charAt(0).toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-neutral-900">{member.displayName || 'Membre'}</p>
                <p className="truncate text-xs text-neutral-500">{member.email}</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <select
                value={member.role}
                onChange={(event) => handleChangeRole(member.userId, event.target.value as TeamRole)}
                className="g3-select w-auto py-1.5 text-xs"
                disabled={member.role === 'owner' || !canManage || busyMember === member.userId}
                aria-label={`Rôle de ${member.displayName}`}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>{TEAM_ROLE_LABELS[role]}</option>
                ))}
              </select>
              {member.role !== 'owner' && canManage && (
                <button
                  type="button"
                  onClick={() => handleRemove(member.userId)}
                  disabled={busyMember === member.userId}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:opacity-50"
                >
                  Retirer
                </button>
              )}
            </div>
          </li>
        ))}
        {members.length === 0 && (
          <li className="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/60 p-6 text-center text-sm text-neutral-500">
            Aucun membre affiché pour le moment.
          </li>
        )}
      </ul>
    </div>
  );
}
