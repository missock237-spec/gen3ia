// lib/team/useTeam.ts
'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Couche client du module equipes.
 *
 * Toutes les operations passent par les routes API serveur (/api/teams/*)
 * qui utilisent l'Admin SDK : le SDK Firestore cote navigateur visait une
 * base non provisionnee et faisait echouer creation, invitations et
 * acceptation (erreur « Invitation invalide ou expiree »).
 */

export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface Team {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  memberCount: number;
  isArchived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  photoURL: string;
  role: TeamRole;
  joinedAt: string | null;
}

export interface TeamInvitation {
  id: string;
  teamId: string;
  teamName: string;
  invitedEmail: string;
  invitedBy: { userId: string; displayName: string };
  role: TeamRole;
  status: string;
  expiresAt: string | null;
  valid: boolean;
}

export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  owner: 'Propriétaire',
  admin: 'Admin',
  editor: 'Éditeur',
  viewer: 'Observateur',
};

async function callApi<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string } & T;
  if (!response.ok) {
    throw new Error(body?.error || 'Une erreur est survenue. Reessayez.');
  }
  return body;
}

export function useTeam(teamId?: string) {
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [myRole, setMyRole] = useState<TeamRole | null>(null);
  const [loading, setLoading] = useState(Boolean(teamId));
  const [error, setError] = useState<string | null>(null);

  const loadTeam = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await callApi<{ team: Team; members: TeamMember[]; myRole: TeamRole }>(`/api/teams/${encodeURIComponent(id)}`);
      setTeam(data.team);
      setMembers(data.members);
      setMyRole(data.myRole);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Equipe indisponible');
      setTeam(null);
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (teamId) void loadTeam(teamId);
  }, [teamId, loadTeam]);

  const fetchMyTeams = useCallback(async (): Promise<Team[]> => {
    const data = await callApi<{ teams: Team[] }>('/api/teams');
    return data.teams ?? [];
  }, []);

  const createTeam = useCallback(async (name: string, description?: string): Promise<string> => {
    const data = await callApi<{ team: Team }>('/api/teams', {
      method: 'POST',
      body: JSON.stringify({ name, description: description ?? '' }),
    });
    return data.team.id;
  }, []);

  const inviteMember = useCallback(async (email: string, role: TeamRole): Promise<string> => {
    if (!teamId) throw new Error('Aucune equipe selectionnee');
    const data = await callApi<{ token: string }>('/api/teams/invite', {
      method: 'POST',
      body: JSON.stringify({ teamId, email, role }),
    });
    return data.token;
  }, [teamId]);

  const acceptInvitation = useCallback(async (token: string): Promise<string> => {
    const data = await callApi<{ teamId: string }>('/api/teams/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    return data.teamId;
  }, []);

  const updateMemberRole = useCallback(async (memberId: string, role: TeamRole): Promise<void> => {
    if (!teamId) throw new Error('Aucune equipe selectionnee');
    await callApi(`/api/teams/${encodeURIComponent(teamId)}/members`, {
      method: 'PATCH',
      body: JSON.stringify({ memberId, role }),
    });
  }, [teamId]);

  const removeMember = useCallback(async (memberId: string): Promise<void> => {
    if (!teamId) throw new Error('Aucune equipe selectionnee');
    await callApi(`/api/teams/${encodeURIComponent(teamId)}/members`, {
      method: 'DELETE',
      body: JSON.stringify({ memberId }),
    });
  }, [teamId]);

  return {
    team,
    members,
    myRole,
    loading,
    error,
    reload: teamId ? () => loadTeam(teamId) : undefined,
    fetchMyTeams,
    createTeam,
    inviteMember,
    acceptInvitation,
    updateMemberRole,
    removeMember,
  };
}
