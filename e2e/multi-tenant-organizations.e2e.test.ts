import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

/**
 * E2E MULTI-TENANT (émulateurs Firebase —aucun mock Firestore).
 *
 * Parcours complet d'organisation réelle :
 *   1. création d'organisation (owner + index user→org) ;
 *   2. invitation → acceptation (rôles, index, comptage) ;
 *   3. agent rattaché à l'org → visible par le membre, agent personnel du
 *      propriétaire INVISIBLE du membre ;
 *   4. isolation stricte entre deux organisations (anti-énumération) ;
 *   5. rattachement org refusé pour un non-membre (assertOrgAttach) ;
 *   6. gestion des rôles (promotion admin → droit d'invitation, retrait) ;
 *   7. garde-fous d'invitations (doublon, email déjà membre, révocation,
 *      quota du plan free).
 *
 * Tout passe par les fonctions réelles de lib/tenants + lib/agents avec la
 * vraie persistance de l'émulateur Firestore.
 */

// Task 109 — le plan de données utilisateur (agents, conversations, mémoire)
// vit dans R2. L'environnement E2E (émulateurs Firebase) n'a PAS de bucket R2 :
// le CLIENT R2 (lib/storage/r2) est simulé EN MÉMOIRE — même approche que
// e2e/firebase-auth-wallet.e2e.test.ts (Task 108). Les parcours multi-tenant
// restent testés contre les vrais émulateurs Firestore.
const r2Objects = new Map<string, Buffer>();
vi.mock("@/lib/storage/r2", () => ({
  putObject: vi.fn(async ({ key, body }: { key: string; body: Uint8Array | Buffer }) => {
    r2Objects.set(key, Buffer.from(body));
  }),
  downloadFromR2: vi.fn(async (key: string): Promise<Buffer> => {
    const hit = r2Objects.get(key);
    if (!hit) {
      const absence = new Error(`The specified key does not exist. (${key})`);
      absence.name = "NoSuchKey";
      throw absence;
    }
    return hit;
  }),
  deleteObject: vi.fn(async (key: string) => {
    r2Objects.delete(key);
  }),
  deleteFromR2: vi.fn(async (key: string) => {
    r2Objects.delete(key);
  }),
  listObjectsUnderPrefix: vi.fn(async (prefix: string) =>
    [...r2Objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({
      key,
      sizeBytes: r2Objects.get(key)?.byteLength ?? 0,
      updatedAt: new Date().toISOString(),
    })),
  ),
}));

const PROJECT_ID = "demo-gen3ia";
const AUTH_EMULATOR = "127.0.0.1:9099";
const FIRESTORE_EMULATOR = "127.0.0.1:8080";
const RUN = Date.now();

process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR;
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR;
process.env.GCLOUD_PROJECT = PROJECT_ID;

interface EmuUser { idToken?: string; localId: string; email: string }

async function createEmuUser(email: string): Promise<EmuUser> {
  const res = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=e2e`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Gen3iaE2E!2026", returnSecureToken: true }),
  });
  if (res.ok) {
    const body = (await res.json()) as { localId: string };
    return { localId: body.localId, email };
  }
  const signIn = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=e2e`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Gen3iaE2E!2026", returnSecureToken: true }),
  });
  expect(signIn.ok).toBe(true);
  const body = (await signIn.json()) as { localId: string };
  return { localId: body.localId, email };
}

describe("E2E multi-tenant : organisations → partage → isolation", () => {
  let adminDb: typeof import("@/lib/firebase/admin").adminDb;
  let tenants: typeof import("@/lib/tenants/organizations");
  let agentsRepo: typeof import("@/lib/agents/repository");

  let owner: EmuUser;
  let member: EmuUser;
  let outsider: EmuUser;
  let extraOne: EmuUser;
  let extraTwo: EmuUser;
  let orgA: import("@/lib/tenants/organizations").OrganizationView;
  let orgB: import("@/lib/tenants/organizations").OrganizationView;
  const orgIds: string[] = [];

  beforeAll(async () => {
    ({ adminDb } = await import("@/lib/firebase/admin"));
    tenants = await import("@/lib/tenants/organizations");
    agentsRepo = await import("@/lib/agents/repository");

    owner = await createEmuUser(`e2e-owner-${RUN}@gen3ia.test`);
    member = await createEmuUser(`e2e-member-${RUN}@gen3ia.test`);
    outsider = await createEmuUser(`e2e-outsider-${RUN}@gen3ia.test`);
    extraOne = await createEmuUser(`e2e-extra1-${RUN}@gen3ia.test`);
    extraTwo = await createEmuUser(`e2e-extra2-${RUN}@gen3ia.test`);
  });

  afterAll(async () => {
    // Nettoyage best-effort : orgs (doc + sous-collections) + index membership.
    for (const orgId of orgIds) {
      const members = await adminDb.collection("organizations").doc(orgId).collection("members").get();
      await Promise.all(members.docs.map((d) => d.ref.delete()));
      const invitations = await adminDb.collection("organizations").doc(orgId).collection("invitations").get();
      await Promise.all(invitations.docs.map((d) => d.ref.delete()));
      await adminDb.collection("organizations").doc(orgId).delete().catch(() => undefined);
    }
    const index = await adminDb.collection("orgMemberships")
      .where("orgId", "in", orgIds.length ? orgIds : ["__none__"]).get().catch(() => null);
    await Promise.all(index?.docs.map((d) => d.ref.delete()) ?? []);
  });

  it("1. création d'organisation : owner membre, index user→org alimenté", async () => {
    orgA = await tenants.createOrganization(owner.localId, `Org A ${RUN}`, owner.email);
    orgIds.push(orgA.id);
    expect(orgA.myRole).toBe("owner");
    expect(orgA.plan).toBe("free");
    expect(orgA.memberCount).toBe(1);

    const indexSnap = await adminDb.collection("orgMemberships").doc(`${owner.localId}_${orgA.id}`).get();
    expect(indexSnap.exists).toBe(true);
    expect(indexSnap.get("orgId")).toBe(orgA.id);

    // Un utilisateur du plan free est plafonné à 1 organisation.
    await expect(tenants.createOrganization(owner.localId, `Org X ${RUN}`, owner.email))
      .rejects.toThrow("autorise 1 organisation");
  });

  it("2. invitation → acceptation : le membre rejoint l'org (role member, index écrit)", async () => {
    const context = await tenants.requireOrgContext(owner.localId, orgA.id);
    const invitation = await tenants.inviteMember(context, member.email, "member");
    expect(invitation.status).toBe("pending");
    expect(invitation.valid).toBe(true);

    const joined = await tenants.acceptInvitation(member.localId, member.email, orgA.id, invitation.id);
    expect(joined.myRole).toBe("member");
    expect(joined.memberCount).toBe(2);

    // Double acceptation refusée (invitation déjà traitée).
    await expect(tenants.acceptInvitation(member.localId, member.email, orgA.id, invitation.id))
      .rejects.toThrow("déjà été traitée");

    const memberIndex = await adminDb.collection("orgMemberships").doc(`${member.localId}_${orgA.id}`).get();
    expect(memberIndex.exists).toBe(true);

    const memberOrgs = await tenants.listUserOrganizations(member.localId);
    expect(memberOrgs.map((o) => o.id)).toContain(orgA.id);
    expect(memberOrgs.find((o) => o.id === orgA.id)?.myRole).toBe("member");
  });

  it("3. agent rattaché à l'org partagé au membre ; agent personnel invisible", async () => {
    const orgAgent = await agentsRepo.createAgentRecord(owner.localId, {
      name: "Agent Org A",
      description: "Partagé avec l'organisation",
      skills: ["recherche"],
    } as never, { orgId: orgA.id });
    expect(orgAgent.orgId).toBe(orgA.id);
    expect(orgAgent.ownerId).toBe(owner.localId);

    const personalAgent = await agentsRepo.createAgentRecord(owner.localId, {
      name: "Agent Personnel",
      description: "Strictement privé",
      skills: [],
    } as never);

    const memberList = await agentsRepo.listAgentsForUser(member.localId);
    const memberIds = memberList.map((a) => a.id);
    expect(memberIds).toContain(orgAgent.id);
    expect(memberIds).not.toContain(personalAgent.id);

    // Le membre LIT l'agent d'org (matrice : member = lecture seule)…
    const readAsMember = await agentsRepo.getAgentForUser(member.localId, orgAgent.id);
    expect(readAsMember?.id).toBe(orgAgent.id);
    // …mais ne peut pas l'ÉCRIRE (dénégation = null, indiscernable d'une
    // ressource absente — anti-énumération).
    const deniedWrite = await agentsRepo.updateAgentForUser(member.localId, orgAgent.id, { description: "hack" } as never);
    expect(deniedWrite).toBeNull();
    // Task 109 : les agents vivent dans R2 — la non-écriture se vérifie via
    // le dépôt (lecture propriétaire), plus via Firestore.
    const unchanged = await agentsRepo.getAgentForOwner(owner.localId, orgAgent.id);
    expect(unchanged?.description).toBe("Partagé avec l'organisation");

    // L'owner voit les deux.
    const ownerList = await agentsRepo.listAgentsForUser(owner.localId);
    const ownerIds = ownerList.map((a) => a.id);
    expect(ownerIds).toContain(orgAgent.id);
    expect(ownerIds).toContain(personalAgent.id);

    // Nettoyage de l'agent personnel de test (suppression via le dépôt R2).
    await agentsRepo.deleteAgentForOwner(owner.localId, personalAgent.id);
    await agentsRepo.deleteAgentForOwner(owner.localId, orgAgent.id);
  });

  it("4. isolation stricte entre deux organisations (anti-énumération)", async () => {
    orgB = await tenants.createOrganization(outsider.localId, `Org B ${RUN}`, outsider.email);
    orgIds.push(orgB.id);

    const bAgent = await agentsRepo.createAgentRecord(outsider.localId, {
      name: "Agent Org B",
      description: "Réservé à l'org B",
      skills: [],
    } as never, { orgId: orgB.id });

    // Le membre de l'org A ne voit NI l'agent de l'org B, ni l'org B elle-même
    // (dénégation = null : anti-énumération).
    expect(await agentsRepo.getAgentForUser(member.localId, bAgent.id)).toBeNull();
    const memberOrgs = await tenants.listUserOrganizations(member.localId);
    expect(memberOrgs.map((o) => o.id)).not.toContain(orgB.id);

    // requireOrgContext refuse un non-membre.
    await expect(tenants.requireOrgContext(member.localId, orgB.id)).rejects.toThrow("introuvable ou accès refusé");

    await agentsRepo.deleteAgentForOwner(outsider.localId, bAgent.id);
  });

  it("5. rattachement org refusé pour un non-membre (assertOrgAttach avant écriture)", async () => {
    await expect(agentsRepo.createAgentRecord(outsider.localId, {
      name: "Agent Intrus",
      description: "Tentative de rattachement",
      skills: [],
    } as never, { orgId: orgA.id })).rejects.toThrow("introuvable ou accès refusé");

    // Task 109 : aucune écriture fantôme dans R2 — le listing du non-membre
    // reste vide (l'attachement a été refusé AVANT toute écriture).
    expect(await agentsRepo.listAgentsByOwner(outsider.localId)).toHaveLength(0);
  });

  it("6. rôles : promotion admin → droit d'invitation ; retrait révoque l'accès", async () => {
    const ownerContext = await tenants.requireOrgContext(owner.localId, orgA.id);

    // Un simple membre ne peut pas gérer les membres.
    const memberContext = await tenants.requireOrgContext(member.localId, orgA.id);
    await expect(tenants.inviteMember(memberContext, extraOne.email, "member")).rejects.toThrow("owners et admins");

    await tenants.updateMemberRole(ownerContext, member.localId, "admin");
    const promotedContext = await tenants.requireOrgContext(member.localId, orgA.id);
    expect(promotedContext.role).toBe("admin");

    // L'admin promu peut inviter à son tour.
    const invite = await tenants.inviteMember(promotedContext, extraOne.email, "member");
    await tenants.acceptInvitation(extraOne.localId, extraOne.email, orgA.id, invite.id);

    // Retrait du membre par l'owner : doc + index supprimés, accès perdu.
    await tenants.removeMember(ownerContext, extraOne.localId);
    const removedIndex = await adminDb.collection("orgMemberships").doc(`${extraOne.localId}_${orgA.id}`).get();
    expect(removedIndex.exists).toBe(false);
    await expect(tenants.requireOrgContext(extraOne.localId, orgA.id)).rejects.toThrow("introuvable ou accès refusé");

    // L'owner ne peut pas être rétrogradé ni retiré.
    await expect(tenants.updateMemberRole(ownerContext, owner.localId, "member")).rejects.toThrow();
    await expect(tenants.removeMember(ownerContext, owner.localId)).rejects.toThrow();
  });

  it("7. garde-fous d'invitations : doublon, déjà membre, révocation, quota plan free", async () => {
    const ownerContext = await tenants.requireOrgContext(owner.localId, orgA.id);

    // Membre déjà présent (member est admin depuis le test 6).
    await expect(tenants.inviteMember(ownerContext, member.email, "member")).rejects.toThrow("fait déjà partie");

    // Révocation d'une invitation en attente.
    const pending = await tenants.inviteMember(ownerContext, extraTwo.email, "member");
    await tenants.revokeInvitation(ownerContext, pending.id);
    await expect(tenants.acceptInvitation(extraTwo.localId, extraTwo.email, orgA.id, pending.id))
      .rejects.toThrow();

    // Ré-invitation d'extraTwo puis acceptation → l'org atteint le quota
    // (owner + member/admin + extraTwo = 3 membres, plafond plan free).
    const last = await tenants.inviteMember(ownerContext, extraTwo.email, "member");
    await tenants.acceptInvitation(extraTwo.localId, extraTwo.email, orgA.id, last.id);

    // Quota : plan free = 3 membres max → l'invitation SUIVANTE est bloquée à
    // la création (le quota est vérifié AVANT l'écriture de l'invitation).
    const blocked = await createEmuUser(`e2e-overquota-${RUN}@gen3ia.test`);
    await expect(tenants.inviteMember(ownerContext, blocked.email, "member"))
      .rejects.toThrow("membres maximum");
    const pendingAfterQuota = await adminDb
      .collection("organizations").doc(orgA.id).collection("invitations")
      .where("email", "==", blocked.email).get();
    expect(pendingAfterQuota.empty).toBe(true); // aucune invitation fantôme
  });
});
