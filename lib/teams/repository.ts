import { FieldValue, Timestamp } from "@/lib/r2fs";

import { adminDb } from "@/lib/firebase/admin";

/**
 * Persistance Firestore des equipes via l'Admin SDK.
 *
 * Les fonctions equipe du client web passaient par le SDK Firestore cote
 * navigateur : la base Firestore visee par le projet web n'etant pas
 * provisionnee, toute lecture/ecriture echouait (d'ou les erreurs
 * « Invitation invalide ou expiree »). Toutes les operations passent
 * desormais par ces routes serveur qui utilisent la base Admin fonctionnele.
 */

const TEAMS = "teams";
const MEMBERS = "members";
const INVITATIONS = "invitations";
const USER_TEAMS = "userTeams";

export type TeamRole = "owner" | "admin" | "editor" | "viewer";

const VALID_ROLES: TeamRole[] = ["owner", "admin", "editor", "viewer"];

export interface TeamSummary {
  id: string;
  name: string;
  description: string;
  ownerId: string;
  memberCount: number;
  isArchived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TeamMemberView {
  userId: string;
  email: string;
  displayName: string;
  photoURL: string;
  role: TeamRole;
  joinedAt: string | null;
}

export interface InvitationView {
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

function iso(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

function toTeamSummary(id: string, data: Record<string, unknown>): TeamSummary {
  return {
    id,
    name: typeof data.name === "string" ? data.name : "Equipe",
    description: typeof data.description === "string" ? data.description : "",
    ownerId: typeof data.ownerId === "string" ? data.ownerId : "",
    memberCount: Number.isSafeInteger(Number(data.memberCount)) ? Number(data.memberCount) : 1,
    isArchived: data.isArchived === true,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  };
}

function toMemberView(id: string, data: Record<string, unknown>): TeamMemberView {
  const role = VALID_ROLES.includes(data.role as TeamRole) ? (data.role as TeamRole) : "viewer";
  return {
    userId: id,
    email: typeof data.email === "string" ? data.email : "",
    displayName: typeof data.displayName === "string" ? data.displayName : "Membre",
    photoURL: typeof data.photoURL === "string" ? data.photoURL : "",
    role,
    joinedAt: iso(data.joinedAt),
  };
}

async function getMemberRole(teamId: string, uid: string): Promise<TeamRole | null> {
  const snap = await adminDb.collection(TEAMS).doc(teamId).collection(MEMBERS).doc(uid).get();
  if (!snap.exists) return null;
  const role = snap.data()?.role;
  return VALID_ROLES.includes(role) ? (role as TeamRole) : null;
}

/** Cree une equipe dont l'appelant devient proprietaire unique membre. */
export async function createTeamForUser(
  user: { uid: string; email?: string; name?: string },
  input: { name: string; description?: string },
): Promise<TeamSummary> {
  const name = input.name.trim();
  if (!name || name.length > 200) throw new Error("Nom d'equipe invalide");
  const description = (input.description ?? "").trim().slice(0, 2000);

  const teamRef = adminDb.collection(TEAMS).doc();
  const now = FieldValue.serverTimestamp();

  await adminDb.runTransaction(async (tx) => {
    tx.set(teamRef, {
      name,
      description,
      ownerId: user.uid,
      memberCount: 1,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    });
    tx.set(teamRef.collection(MEMBERS).doc(user.uid), {
      userId: user.uid,
      email: user.email ?? "",
      displayName: user.name ?? "Utilisateur",
      photoURL: "",
      role: "owner" as TeamRole,
      joinedAt: now,
      invitedBy: user.uid,
    });
    tx.set(adminDb.collection(USER_TEAMS).doc(user.uid), {
      userId: user.uid,
      teams: FieldValue.arrayUnion(teamRef.id),
      primaryTeam: teamRef.id,
    }, { merge: true });
  });

  const snap = await teamRef.get();
  return toTeamSummary(teamRef.id, (snap.data() ?? {}) as Record<string, unknown>);
}

/** Liste les equipes de l'utilisateur (doc userTeams/{uid}). */
export async function listTeamsForUser(uid: string): Promise<TeamSummary[]> {
  const userTeamSnap = await adminDb.collection(USER_TEAMS).doc(uid).get();
  const rawTeams = userTeamSnap.data()?.teams;
  const teamIds = Array.isArray(rawTeams)
    ? (rawTeams as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  if (teamIds.length === 0) return [];
  const loaded = await Promise.all(
    teamIds.map(async (id) => {
      const snap = await adminDb.collection(TEAMS).doc(id).get();
      if (!snap.exists) return null;
      const team = toTeamSummary(id, (snap.data() ?? {}) as Record<string, unknown>);
      return team.isArchived ? null : team;
    }),
  );
  return loaded.filter((team): team is TeamSummary => team !== null);
}

/** Cree une invitation (l'appelant doit etre owner/admin de l'equipe). */
export async function createTeamInvitation(
  actorUid: string,
  input: { teamId: string; email: string; role: TeamRole },
): Promise<{ token: string; expiresAt: string }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Adresse email invalide");
  if (!VALID_ROLES.includes(input.role)) throw new Error("Role invalide");

  const actorRole = await getMemberRole(input.teamId, actorUid);
  if (!actorRole || (actorRole !== "owner" && actorRole !== "admin")) {
    throw new Error("Seuls les proprietaires et admins peuvent inviter des membres");
  }

  const teamSnap = await adminDb.collection(TEAMS).doc(input.teamId).get();
  if (!teamSnap.exists) throw new Error("Equipe introuvable");

  const token = crypto.randomUUID();
  const expiresAtDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const inviterSnap = await adminDb.collection(TEAMS).doc(input.teamId).collection(MEMBERS).doc(actorUid).get();
  await adminDb.collection(INVITATIONS).add({
    teamId: input.teamId,
    teamName: teamSnap.data()?.name ?? "",
    invitedEmail: email,
    invitedBy: { userId: actorUid, displayName: inviterSnap.data()?.displayName ?? "" },
    role: input.role,
    status: "pending",
    token,
    createdAt: FieldValue.serverTimestamp(),
    expiresAt: Timestamp.fromDate(expiresAtDate),
  });

  return { token, expiresAt: expiresAtDate.toISOString() };
}

/** Lit une invitation par token (sans la consommer). */
export async function getInvitationByToken(token: string): Promise<InvitationView> {
  const snap = await adminDb
    .collection(INVITATIONS)
    .where("token", "==", token)
    .limit(1)
    .get();
  if (snap.empty) throw new Error("Invitation introuvable");
  const doc = snap.docs[0];
  const data = doc.data() as Record<string, unknown>;
  const expiresAt = iso(data.expiresAt);
  const expired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : false;
  const invitedBy = (data.invitedBy ?? {}) as Record<string, unknown>;
  return {
    id: doc.id,
    teamId: typeof data.teamId === "string" ? data.teamId : "",
    teamName: typeof data.teamName === "string" ? data.teamName : "",
    invitedEmail: typeof data.invitedEmail === "string" ? data.invitedEmail : "",
    invitedBy: {
      userId: typeof invitedBy.userId === "string" ? invitedBy.userId : "",
      displayName: typeof invitedBy.displayName === "string" ? invitedBy.displayName : "",
    },
    role: VALID_ROLES.includes(data.role as TeamRole) ? (data.role as TeamRole) : "viewer",
    status: typeof data.status === "string" ? data.status : "unknown",
    expiresAt,
    valid: data.status === "pending" && !expired,
  };
}

/** Accepte une invitation par token (transaction atomique). */
export async function acceptTeamInvitation(
  user: { uid: string; email?: string; name?: string },
  token: string,
): Promise<{ teamId: string }> {
  const invitationSnap = await adminDb
    .collection(INVITATIONS)
    .where("token", "==", token)
    .limit(1)
    .get();
  if (invitationSnap.empty) throw new Error("Invitation introuvable");
  const invitationDoc = invitationSnap.docs[0];
  const current = invitationDoc.data() as Record<string, unknown>;
  const teamId = typeof current.teamId === "string" ? current.teamId : "";
  if (!teamId) throw new Error("Invitation corrompue");

  const teamRef = adminDb.collection(TEAMS).doc(teamId);
  const memberRef = teamRef.collection(MEMBERS).doc(user.uid);
  const userTeamRef = adminDb.collection(USER_TEAMS).doc(user.uid);

  await adminDb.runTransaction(async (tx) => {
    const [teamSnap, memberSnap, freshInvitation] = await Promise.all([
      tx.get(teamRef),
      tx.get(memberRef),
      tx.get(invitationDoc.ref),
    ]);
    if (!teamSnap.exists) throw new Error("Equipe introuvable");
    if (memberSnap.exists) throw new Error("Vous etes deja membre de cette equipe");
    const fresh = freshInvitation.data() as Record<string, unknown>;
    if (fresh.status !== "pending") throw new Error("Invitation deja utilisee ou annulee");
    const expiresAt = iso(fresh.expiresAt);
    if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
      throw new Error("Invitation expiree");
    }
    const currentCount = Number(teamSnap.data()?.memberCount ?? 0);
    if (!Number.isSafeInteger(currentCount) || currentCount < 0) throw new Error("Compteur de membres invalide");

    const now = FieldValue.serverTimestamp();
    const invitedBy = (fresh.invitedBy ?? {}) as Record<string, unknown>;
    tx.set(memberRef, {
      userId: user.uid,
      email: user.email ?? "",
      displayName: user.name ?? "Utilisateur",
      photoURL: "",
      role: VALID_ROLES.includes(fresh.role as TeamRole) ? (fresh.role as TeamRole) : "viewer",
      joinedAt: now,
      invitedBy: typeof invitedBy.userId === "string" ? invitedBy.userId : "",
    });
    tx.set(userTeamRef, {
      userId: user.uid,
      teams: FieldValue.arrayUnion(teamId),
      primaryTeam: teamId,
    }, { merge: true });
    tx.update(teamRef, { memberCount: currentCount + 1, updatedAt: now });
    tx.update(invitationDoc.ref, { status: "accepted", acceptedAt: now, acceptedBy: user.uid });
  });

  return { teamId };
}

/** Details d'une equipe + membres (l'appelant doit en etre membre). */
export async function getTeamWithMembers(teamId: string, viewerUid: string): Promise<{ team: TeamSummary; members: TeamMemberView[]; myRole: TeamRole }> {
  const myRole = await getMemberRole(teamId, viewerUid);
  if (!myRole) throw new Error("Acces refuse: vous n'etes pas membre de cette equipe");
  const teamSnap = await adminDb.collection(TEAMS).doc(teamId).get();
  if (!teamSnap.exists) throw new Error("Equipe introuvable");
  const membersSnap = await adminDb.collection(TEAMS).doc(teamId).collection(MEMBERS).get();
  return {
    team: toTeamSummary(teamId, (teamSnap.data() ?? {}) as Record<string, unknown>),
    members: membersSnap.docs.map((doc) => toMemberView(doc.id, (doc.data() ?? {}) as Record<string, unknown>)),
    myRole,
  };
}

/** Change le role d'un membre (l'appelant doit etre owner/admin). */
export async function updateMemberRole(actorUid: string, teamId: string, memberId: string, role: TeamRole): Promise<void> {
  if (!VALID_ROLES.includes(role)) throw new Error("Role invalide");
  const actorRole = await getMemberRole(teamId, actorUid);
  if (!actorRole || (actorRole !== "owner" && actorRole !== "admin")) {
    throw new Error("Seuls les proprietaires et admins peuvent modifier les roles");
  }
  const targetSnap = await adminDb.collection(TEAMS).doc(teamId).collection(MEMBERS).doc(memberId).get();
  if (!targetSnap.exists) throw new Error("Membre introuvable");
  if (targetSnap.data()?.role === "owner") throw new Error("Le proprietaire ne peut pas etre modifie");
  await adminDb.collection(TEAMS).doc(teamId).collection(MEMBERS).doc(memberId).update({ role });
}

/** Retire un membre (l'appelant admin, ou le membre lui-meme). */
export async function removeMember(actorUid: string, teamId: string, memberId: string): Promise<void> {
  const actorRole = await getMemberRole(teamId, actorUid);
  const isSelf = actorUid === memberId;
  if (!actorRole || (!isSelf && actorRole !== "owner" && actorRole !== "admin")) {
    throw new Error("Seuls les proprietaires et admins peuvent retirer des membres");
  }
  const memberRef = adminDb.collection(TEAMS).doc(teamId).collection(MEMBERS).doc(memberId);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) return;
  if (memberSnap.data()?.role === "owner") throw new Error("Le proprietaire ne peut pas etre retire");

  const teamRef = adminDb.collection(TEAMS).doc(teamId);
  await adminDb.runTransaction(async (tx) => {
    const teamSnap = await tx.get(teamRef);
    const count = Number(teamSnap.data()?.memberCount ?? 0);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Compteur de membres invalide");
    tx.delete(memberRef);
    tx.update(teamRef, { memberCount: count - 1, updatedAt: FieldValue.serverTimestamp() });
  });
}
