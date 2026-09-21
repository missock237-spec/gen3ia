import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { adminDb } from "@/lib/firebase/admin";

/**
 * Multi-tenancy Gen3ia : organisations (tenants), membres et invitations.
 *
 * Cloisonnement : chaque ressource d'entreprise est rattachée à un orgId.
 * L'isolation est appliquée à la fois côté règles Firestore (vérification
 * exists(organizations/{orgId}/members/{uid})) et côté serveur (chaque
 * fonction vérifie le rôle de l'appelant avant lecture/écriture).
 *
 * Modèle d'isolation hybride :
 * - pool (défaut) : infrastructure partagée, isolation logique par orgId ;
 * - silo (enterprise, réservé) : namespace de données dédié — le champ
 *   `isolation` matérialise la décision et guide le provisionnement futur.
 */

const ORGANIZATIONS = "organizations";
const MEMBERS = "members";
const INVITATIONS = "invitations";
const MEMBERSHIP_INDEX = "orgMemberships";

export type OrgRole = "owner" | "admin" | "member";
export type OrgPlan = "free" | "pro" | "enterprise";
export type OrgIsolation = "pool" | "silo";

const VALID_ROLES: OrgRole[] = ["owner", "admin", "member"];
const VALID_PLANS: OrgPlan[] = ["free", "pro", "enterprise"];

export interface PlanQuotas {
  maxOrganizationsPerUser: number;
  maxMembers: number;
  maxAgents: number;
  maxProjects: number;
  monthlyCredits: number;
  storageGb: number;
  /** Fonctionnalités réservées du plan. */
  features: { api: boolean; silo: boolean; auditLog: boolean; mcp: boolean };
}

export const PLAN_QUOTAS: Record<OrgPlan, PlanQuotas> = {
  free: {
    maxOrganizationsPerUser: 1, maxMembers: 3, maxAgents: 3, maxProjects: 2,
    monthlyCredits: 500, storageGb: 1,
    features: { api: false, silo: false, auditLog: false, mcp: false },
  },
  pro: {
    maxOrganizationsPerUser: 5, maxMembers: 25, maxAgents: 50, maxProjects: 20,
    monthlyCredits: 50_000, storageGb: 50,
    features: { api: true, silo: false, auditLog: true, mcp: true },
  },
  enterprise: {
    maxOrganizationsPerUser: 25, maxMembers: 500, maxAgents: 1_000, maxProjects: 200,
    monthlyCredits: 1_000_000, storageGb: 1_000,
    features: { api: true, silo: true, auditLog: true, mcp: true },
  },
};

export function quotasForPlan(plan: OrgPlan): PlanQuotas {
  return PLAN_QUOTAS[plan] ?? PLAN_QUOTAS.free;
}

export interface OrganizationView {
  id: string;
  name: string;
  plan: OrgPlan;
  isolation: OrgIsolation;
  ownerId: string;
  memberCount: number;
  myRole: OrgRole;
  settings: Record<string, unknown>;
  createdAt: string | null;
}

export interface OrgMemberView {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  joinedAt: string | null;
}

export interface OrgInvitationView {
  id: string;
  email: string;
  role: OrgRole;
  status: string;
  invitedBy: string;
  expiresAt: string | null;
  valid: boolean;
}

function iso(value: unknown): string | null {
  return value instanceof Timestamp ? value.toDate().toISOString() : null;
}

function normalizeRole(role: unknown): OrgRole {
  return VALID_ROLES.includes(role as OrgRole) ? (role as OrgRole) : "member";
}

export function normalizePlan(plan: unknown): OrgPlan {
  return VALID_PLANS.includes(plan as OrgPlan) ? (plan as OrgPlan) : "free";
}

export function assertOrganizationName(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 120);
  if (clean.length < 2) throw new Error("Le nom de l'organisation doit contenir au moins 2 caractères.");
  return clean;
}

/** Crée une organisation et positionne l'appelant comme owner (membre + index). */
export async function createOrganization(userId: string, rawName: string, email: string): Promise<OrganizationView> {
  const name = assertOrganizationName(rawName);
  const userOrgs = await listUserOrganizations(userId);
  const plan = normalizePlan("free");
  if (userOrgs.length >= quotasForPlan(plan).maxOrganizationsPerUser) {
    throw new Error(`Le plan ${plan} autorise ${quotasForPlan(plan).maxOrganizationsPerUser} organisation(s). Passez à un plan supérieur.`);
  }

  const orgRef = adminDb.collection(ORGANIZATIONS).doc();
  const now = FieldValue.serverTimestamp();
  const batch = adminDb.batch();
  batch.set(orgRef, {
    name,
    plan,
    isolation: "pool" satisfies OrgIsolation,
    ownerId: userId,
    settings: {},
    createdAt: now,
    updatedAt: now,
  });
  batch.set(orgRef.collection(MEMBERS).doc(userId), {
    email: email.slice(0, 200),
    displayName: email.split("@")[0]?.slice(0, 100) ?? "Membre",
    role: "owner" satisfies OrgRole,
    joinedAt: now,
  });
  batch.set(adminDb.collection(MEMBERSHIP_INDEX).doc(`${userId}_${orgRef.id}`), {
    userId,
    orgId: orgRef.id,
    role: "owner" satisfies OrgRole,
    createdAt: now,
  });
  await batch.commit();

  return {
    id: orgRef.id, name, plan, isolation: "pool", ownerId: userId,
    memberCount: 1, myRole: "owner", settings: {}, createdAt: new Date().toISOString(),
  };
}

const orgRefMembers = (orgId: string) => adminDb.collection(ORGANIZATIONS).doc(orgId).collection(MEMBERS);

async function countMembers(orgId: string): Promise<number> {
  const counts = await orgRefMembers(orgId).count().get();
  return counts.data().count ?? 1;
}

/** Organisations de l'utilisateur, rôle joint (via l'index user→org). */
export async function listUserOrganizations(userId: string): Promise<OrganizationView[]> {
  const index = await adminDb.collection(MEMBERSHIP_INDEX).where("userId", "==", userId).limit(50).get();
  if (index.empty) return [];
  const views = await Promise.all(index.docs.map(async (doc) => {
    const orgId = String(doc.data().orgId ?? "");
    if (!orgId) return null;
    const [orgSnap, memberSnap] = await Promise.all([
      adminDb.collection(ORGANIZATIONS).doc(orgId).get(),
      orgRefMembers(orgId).doc(userId).get(),
    ]);
    if (!orgSnap.exists) return null;
    const data = orgSnap.data() as Record<string, unknown>;
    return {
      id: orgId,
      name: String(data.name ?? "Organisation"),
      plan: normalizePlan(data.plan),
      isolation: (data.isolation === "silo" ? "silo" : "pool") as OrgIsolation,
      ownerId: String(data.ownerId ?? ""),
      memberCount: await countMembers(orgId),
      myRole: normalizeRole(memberSnap.exists ? memberSnap.data()?.role : doc.data().role),
      settings: (data.settings ?? {}) as Record<string, unknown>,
      createdAt: iso(data.createdAt),
    } satisfies OrganizationView;
  }));
  return views.filter((view): view is OrganizationView => view !== null);
}

export interface OrgContext {
  orgId: string;
  role: OrgRole;
  plan: OrgPlan;
  name: string;
}

/** Garde d'accès : l'appelant doit être membre de l'organisation. */
export async function requireOrgContext(userId: string, orgId: string): Promise<OrgContext> {
  const [orgSnap, memberSnap] = await Promise.all([
    adminDb.collection(ORGANIZATIONS).doc(orgId).get(),
    orgRefMembers(orgId).doc(userId).get(),
  ]);
  if (!orgSnap.exists || !memberSnap.exists) throw new Error("Organisation introuvable ou accès refusé.");
  const data = orgSnap.data() as Record<string, unknown>;
  return {
    orgId,
    role: normalizeRole(memberSnap.data()?.role),
    plan: normalizePlan(data.plan),
    name: String(data.name ?? "Organisation"),
  };
}

function assertCanManage(context: OrgContext) {
  if (context.role !== "owner" && context.role !== "admin") {
    throw new Error("Seuls les owners et admins de l'organisation peuvent gérer les membres.");
  }
}

const EMAIL_RE = /^[^\s@]{1,100}@[^\s@]{1,200}\.[^\s@]{1,20}$/;

/** Invite un membre par email (invitation avec expiration 7 jours). */
export async function inviteMember(context: OrgContext, rawEmail: string, role: OrgRole): Promise<OrgInvitationView> {
  assertCanManage(context);
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error("Adresse email invalide.");
  if (role === "owner") throw new Error("Le rôle owner ne peut pas être invité : il se transfère via les réglages de l'organisation.");

  const quotas = quotasForPlan(context.plan);
  if (await countMembers(context.orgId) >= quotas.maxMembers) {
    throw new Error(`Le plan ${context.plan} autorise ${quotas.maxMembers} membres maximum.`);
  }

  const existing = await orgRefMembers(context.orgId).where("email", "==", email).limit(1).get();
  if (!existing.empty) throw new Error("Cet email fait déjà partie de l'organisation.");

  const pending = await adminDb.collection(ORGANIZATIONS).doc(context.orgId).collection(INVITATIONS)
    .where("email", "==", email).where("status", "==", "pending").limit(1).get();
  if (!pending.empty) throw new Error("Une invitation est déjà en attente pour cet email.");

  const now = FieldValue.serverTimestamp();
  const ref = adminDb.collection(ORGANIZATIONS).doc(context.orgId).collection(INVITATIONS).doc();
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  await ref.set({
    email,
    role: normalizeRole(role),
    status: "pending",
    invitedBy: context.name.slice(0, 200),
    createdAt: now,
    expiresAt,
  });

  return {
    id: ref.id, email, role: normalizeRole(role), status: "pending",
    invitedBy: context.name.slice(0, 200), expiresAt: expiresAt.toDate().toISOString(), valid: true,
  };
}

/** Accepte une invitation : devient membre, index user→org mis à jour. */
export async function acceptInvitation(userId: string, email: string, orgId: string, invitationId: string): Promise<OrganizationView> {
  const invitationRef = adminDb.collection(ORGANIZATIONS).doc(orgId).collection(INVITATIONS).doc(invitationId);
  const invitation = await invitationRef.get();
  if (!invitation.exists) throw new Error("Invitation introuvable.");
  const data = invitation.data() as Record<string, unknown>;
  if (data.status !== "pending") throw new Error("Cette invitation a déjà été traitée.");
  const expiresAt = data.expiresAt;
  if (expiresAt instanceof Timestamp && expiresAt.toDate().getTime() < Date.now()) {
    await invitationRef.update({ status: "expired" });
    throw new Error("Cette invitation a expiré.");
  }
  const invitedEmail = String(data.email ?? "").toLowerCase();
  if (email.trim().toLowerCase() !== invitedEmail) {
    throw new Error("Cette invitation a été émise pour une autre adresse email.");
  }

  const role = normalizeRole(data.role);
  const now = FieldValue.serverTimestamp();
  const orgRef = adminDb.collection(ORGANIZATIONS).doc(orgId);
  const batch = adminDb.batch();
  batch.set(orgRef.collection(MEMBERS).doc(userId), {
    email: invitedEmail.slice(0, 200),
    displayName: invitedEmail.split("@")[0]?.slice(0, 100) ?? "Membre",
    role,
    joinedAt: now,
  });
  batch.set(adminDb.collection(MEMBERSHIP_INDEX).doc(`${userId}_${orgId}`), {
    userId, orgId, role, createdAt: now,
  });
  batch.update(invitationRef, { status: "accepted", acceptedBy: userId, acceptedAt: now });
  await batch.commit();

  const orgSnap = await orgRef.get();
  return {
    id: orgId,
    name: String(orgSnap.data()?.name ?? "Organisation"),
    plan: normalizePlan(orgSnap.data()?.plan),
    isolation: ((orgSnap.data()?.isolation) === "silo" ? "silo" : "pool") as OrgIsolation,
    ownerId: String(orgSnap.data()?.ownerId ?? ""),
    memberCount: await countMembers(orgId),
    myRole: role,
    settings: (orgSnap.data()?.settings ?? {}) as Record<string, unknown>,
    createdAt: iso(orgSnap.data()?.createdAt),
  };
}

/** Invitations en attente adressées à un email donné (toutes organisations). */
export async function listPendingInvitationsForEmail(email: string): Promise<Array<OrgInvitationView & { orgId: string; orgName: string }>> {
  const emailLower = email.trim().toLowerCase();
  const snapshot = await adminDb.collectionGroup(INVITATIONS)
    .where("email", "==", emailLower).where("status", "==", "pending").limit(20).get();
  const views = await Promise.all(snapshot.docs.map(async (doc) => {
    const orgId = doc.ref.parent.parent?.id ?? "";
    if (!orgId) return null;
    const data = doc.data() as Record<string, unknown>;
    const expiresAt = data.expiresAt;
    const valid = !(expiresAt instanceof Timestamp) || expiresAt.toDate().getTime() > Date.now();
    const orgSnap = await adminDb.collection(ORGANIZATIONS).doc(orgId).get();
    return {
      id: doc.id, orgId, orgName: String(orgSnap.data()?.name ?? "Organisation"),
      email: emailLower, role: normalizeRole(data.role),
      status: String(data.status ?? "pending"), invitedBy: String(data.invitedBy ?? ""),
      expiresAt: iso(expiresAt), valid,
    };
  }));
  return views.filter((item): item is OrgInvitationView & { orgId: string; orgName: string } => item !== null);
}

export async function listMembers(context: OrgContext): Promise<OrgMemberView[]> {
  const snapshot = await orgRefMembers(context.orgId).limit(500).get();
  return snapshot.docs
    .map((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return {
        userId: doc.id,
        email: String(data.email ?? ""),
        displayName: String(data.displayName ?? ""),
        role: normalizeRole(data.role),
        joinedAt: iso(data.joinedAt),
      };
    })
    .sort((a, b) => (a.joinedAt ?? "").localeCompare(b.joinedAt ?? ""));
}

export async function listOrgInvitations(context: OrgContext): Promise<OrgInvitationView[]> {
  const snapshot = await adminDb.collection(ORGANIZATIONS).doc(context.orgId).collection(INVITATIONS)
    .where("status", "==", "pending").limit(50).get();
  return snapshot.docs.map((doc) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      email: String(data.email ?? ""),
      role: normalizeRole(data.role),
      status: String(data.status ?? "pending"),
      invitedBy: String(data.invitedBy ?? ""),
      expiresAt: iso(data.expiresAt),
      valid: !(data.expiresAt instanceof Timestamp) || (data.expiresAt as Timestamp).toDate().getTime() > Date.now(),
    };
  });
}

/** Change le rôle d'un membre (l'owner ne peut pas être rétrogradé ici). */
export async function updateMemberRole(context: OrgContext, memberId: string, role: OrgRole): Promise<void> {
  assertCanManage(context);
  if (role === "owner") throw new Error("Le rôle owner se transfère via les réglages de l'organisation.");
  const member = await orgRefMembers(context.orgId).doc(memberId).get();
  if (!member.exists) throw new Error("Membre introuvable.");
  if ((member.data()?.role) === "owner") throw new Error("Le rôle de l'owner ne peut pas être modifié.");
  await orgRefMembers(context.orgId).doc(memberId).update({ role, updatedAt: FieldValue.serverTimestamp() });
  await adminDb.collection(MEMBERSHIP_INDEX).doc(`${memberId}_${context.orgId}`).update({ role });
}

/** Retire un membre (pas l'owner). Révocation propre de l'index. */
export async function removeMember(context: OrgContext, memberId: string): Promise<void> {
  assertCanManage(context);
  const member = await orgRefMembers(context.orgId).doc(memberId).get();
  if (!member.exists) throw new Error("Membre introuvable.");
  if ((member.data()?.role) === "owner") throw new Error("L'owner ne peut pas être retiré.");
  const batch = adminDb.batch();
  batch.delete(orgRefMembers(context.orgId).doc(memberId));
  batch.delete(adminDb.collection(MEMBERSHIP_INDEX).doc(`${memberId}_${context.orgId}`));
  await batch.commit();
}

/** Révocation d'une invitation en attente. */
export async function revokeInvitation(context: OrgContext, invitationId: string): Promise<void> {
  assertCanManage(context);
  const invitation = await adminDb.collection(ORGANIZATIONS).doc(context.orgId).collection(INVITATIONS).doc(invitationId).get();
  if (!invitation.exists) throw new Error("Invitation introuvable.");
  if ((invitation.data()?.status) !== "pending") throw new Error("Seules les invitations en attente peuvent être révoquées.");
  await invitation.ref.update({ status: "revoked", revokedAt: FieldValue.serverTimestamp() });
}
