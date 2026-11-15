// lib/team/types.ts

export type TeamRole = 'owner' | 'admin' | 'editor' | 'viewer';

export interface Team {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
  memberCount: number;
  isArchived: boolean;
}

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: TeamRole;
  joinedAt: Date;
  invitedBy: string;
}

export interface TeamInvitation {
  id: string;
  teamId: string;
  teamName: string;
  invitedEmail: string;
  invitedBy: {
    userId: string;
    displayName: string;
  };
  role: TeamRole;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  token: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface TeamWorkspace {
  teamId: string;
  // Vos agents, documents, ressources partagés
  agents: string[];
  documents: string[];
  sessions: string[];
  settings: {
    allowMemberInvite: boolean;
    defaultRole: TeamRole;
    maxMembers: number;
  };
}
