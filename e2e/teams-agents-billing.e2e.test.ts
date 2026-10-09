import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { creerMockR2Memoire } from "./helpers/r2-memoire";

/**
 * E2E Firebase ÉMULATEURS — parcours critiques multi-tenant (Task 39, Rec 2.2).
 *
 * Cible : émulateurs locaux UNIQUEMENT (jamais la production) —
 *   auth 127.0.0.1:9099 · firestore 127.0.0.1:8080 (firebase.json).
 * Couvre trois parcours critiques au-delà de l'auth :
 *   1. ORGANISATION : création d'équipe → invitation → acceptation →
 *      changement de rôle → retrait de membre.
 *   2. AGENTS : création → isolation par propriétaire → mise à jour →
 *      suppression.
 *   3. FACTURATION : portefeuille d'accueil idempotent → réservation →
 *      règlement → remise en circulation (ledger cohérent).
 *
 * Exécution : npm run test:e2e (émulateurs:exec + vitest -c vitest.e2e.config.mts).
 */

// Task 109 — le plan de données utilisateur (agents, conversations, mémoire)
// vit dans R2. L'environnement E2E (émulateurs Firebase) n'a PAS de bucket R2 :
// le CLIENT R2 (lib/storage/r2) est simulé EN MÉMOIRE — même approche que
// e2e/firebase-auth-wallet.e2e.test.ts (Task 108). Les parcours métier restent
// testés contre les vrais émulateurs Firestore.

const mockR2 = creerMockR2Memoire();
vi.mock("@/lib/storage/r2", () => mockR2);

const PROJECT_ID = "demo-gen3ia";
const AUTH_EMULATOR = "127.0.0.1:9099";
const TEST_PASSWORD = "Gen3iaE2E!2026";

process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR;
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = PROJECT_ID;

const stamp = Date.now();
const OWNER_EMAIL = `e2e-org-owner-${stamp}@gen3ia.test`;
const MEMBER_EMAIL = `e2e-org-member-${stamp}@gen3ia.test`;

interface EmuUser {
  idToken: string;
  localId: string;
  email: string;
}

async function createEmuUser(email: string): Promise<EmuUser> {
  const res = await fetch(
    `http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=e2e`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: TEST_PASSWORD, returnSecureToken: true }),
    },
  );
  if (!res.ok) throw new Error(` signUp ${email}: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { idToken: string; localId: string };
  return { idToken: body.idToken, localId: body.localId, email };
}

async function clearUser(email: string): Promise<void> {
  const { adminDb } = await import("@/lib/firebase/admin");
  const snap = await adminDb.collection("users").where("email", "==", email).limit(1).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
  const walletSnap = await adminDb.collection("userWallets").where("userId", "==", email).limit(1).get();
  await Promise.all(walletSnap.docs.map((d) => d.ref.delete()));
}

describe("Firebase E2E: équipes multi-tenant → agents → facturation", () => {
  let adminDb: typeof import("@/lib/firebase/admin").adminDb;
  let createTeamForUser: typeof import("@/lib/teams/repository").createTeamForUser;
  let createTeamInvitation: typeof import("@/lib/teams/repository").createTeamInvitation;
  let acceptTeamInvitation: typeof import("@/lib/teams/repository").acceptTeamInvitation;
  let updateMemberRole: typeof import("@/lib/teams/repository").updateMemberRole;
  let removeMember: typeof import("@/lib/teams/repository").removeMember;
  let getTeamWithMembers: typeof import("@/lib/teams/repository").getTeamWithMembers;
  let createAgentRecord: typeof import("@/lib/agents/repository").createAgentRecord;
  let getAgentForOwner: typeof import("@/lib/agents/repository").getAgentForOwner;
  let updateAgentForOwner: typeof import("@/lib/agents/repository").updateAgentForOwner;
  let deleteAgentForOwner: typeof import("@/lib/agents/repository").deleteAgentForOwner;
  let getWallet: typeof import("@/lib/billing/wallet").getWallet;
  let reserveFunds: typeof import("@/lib/billing/wallet").reserveFunds;
  let settleReservation: typeof import("@/lib/billing/wallet").settleReservation;
  let releaseReservation: typeof import("@/lib/billing/wallet").releaseReservation;

  let owner: EmuUser;
  let member: EmuUser;
  let teamId = "";
  let agentId = "";

  beforeAll(async () => {
    owner = await createEmuUser(OWNER_EMAIL);
    member = await createEmuUser(MEMBER_EMAIL);
    ({
      createTeamForUser,
      createTeamInvitation,
      acceptTeamInvitation,
      updateMemberRole,
      removeMember,
      getTeamWithMembers,
    } = await import("@/lib/teams/repository"));
    ({ createAgentRecord, getAgentForOwner, updateAgentForOwner, deleteAgentForOwner } =
      await import("@/lib/agents/repository"));
    ({ getWallet, reserveFunds, settleReservation, releaseReservation } = await import(
      "@/lib/billing/wallet"
    ));
    ({ adminDb } = await import("@/lib/firebase/admin"));
  });

  afterAll(async () => {
    // Nettoyage : agents, équipes créées pendant le run.
    if (agentId) {
      try {
        await adminDb.collection("agents").doc(agentId).delete();
      } catch {
        /* best effort */
      }
    }
    if (teamId) {
      try {
        const members = await adminDb.collection("teams").doc(teamId).collection("members").get();
        await Promise.all(members.docs.map((d) => d.ref.delete()));
        await adminDb.collection("teams").doc(teamId).delete();
      } catch {
        /* best effort */
      }
    }
    await clearUser(OWNER_EMAIL).catch(() => undefined);
    await clearUser(MEMBER_EMAIL).catch(() => undefined);
  });

  // ── 1. ORGANISATION ────────────────────────────────────────────────
  it("crée une équipe dont le créateur devient propriétaire", async () => {
    const team = await createTeamForUser(
      { uid: owner.localId, email: owner.email, name: "Owner E2E" },
      { name: "Équipe E2E Task 39", description: "Parcours critique organisation" },
    );
    teamId = team.id;
    expect(teamId).toBeTruthy();

    const view = await getTeamWithMembers(teamId, owner.localId);
    expect(view.team.name).toBe("Équipe E2E Task 39");
    expect(view.members).toHaveLength(1);
    expect(view.members[0].role).toBe("owner");
    expect(view.myRole).toBe("owner");
  });

  it("invite un membre, accepte l'invitation et le voit membre de l'équipe", async () => {
    const { token } = await createTeamInvitation(owner.localId, {
      teamId,
      email: MEMBER_EMAIL,
      role: "editor",
    });
    expect(token).toBeTruthy();

    const { teamId: joinedTeam } = await acceptTeamInvitation(
      { uid: member.localId, email: member.email, name: "Member E2E" },
      token,
    );
    expect(joinedTeam).toBe(teamId);

    const view = await getTeamWithMembers(teamId, member.localId);
    expect(view.members.map((m) => m.email)).toContain(MEMBER_EMAIL);
    const memberView = view.members.find((m) => m.email === MEMBER_EMAIL);
    expect(memberView?.role).toBe("editor");
  });

  it("refuse qu'un non-admin invite et refuse un rôle invalide", async () => {
    await expect(
      createTeamInvitation(member.localId, { teamId, email: "x@y.test", role: "viewer" }),
    ).rejects.toThrow(/proprietaires et admins/i);
    await expect(
      createTeamInvitation(owner.localId, { teamId, email: "x@y.test", role: "superboss" as never }),
    ).rejects.toThrow(/role invalide/i);
  });

  it("change le rôle puis retire le membre (owner uniquement)", async () => {
    await updateMemberRole(owner.localId, teamId, member.localId, "viewer");
    let view = await getTeamWithMembers(teamId, owner.localId);
    expect(view.members.find((m) => m.email === MEMBER_EMAIL)?.role).toBe("viewer");

    await removeMember(owner.localId, teamId, member.localId);
    view = await getTeamWithMembers(teamId, owner.localId);
    expect(view.members.map((m) => m.email)).not.toContain(MEMBER_EMAIL);
  });

  // ── 2. AGENTS (isolation par propriétaire) ─────────────────────────
  it("crée un agent et le rend visible du SEUL propriétaire", async () => {
    const agent = await createAgentRecord(owner.localId, {
      name: "Agent E2E 39",
      type: "universal",
      description: "Agent du parcours e2e Task 39",
      skills: ["web.search"],
    });
    agentId = agent.id;
    expect(agent.ownerId).toBe(owner.localId);

    const own = await getAgentForOwner(owner.localId, agentId);
    expect(own?.name).toBe("Agent E2E 39");
    // Isolation : l'autre utilisateur ne voit PAS l'agent.
    const other = await getAgentForOwner(member.localId, agentId);
    expect(other).toBeNull();
  });

  it("met à jour puis supprime l'agent (propriétaire)", async () => {
    const updated = await updateAgentForOwner(owner.localId, agentId, {
      description: "Description mise à jour e2e",
    });
    expect(updated?.description).toBe("Description mise à jour e2e");

    const deleted = await deleteAgentForOwner(owner.localId, agentId);
    expect(deleted).toBe(true);
    const gone = await getAgentForOwner(owner.localId, agentId);
    expect(gone).toBeNull();
    agentId = "";
  });

  // ── 3. FACTURATION (portefeuille) ──────────────────────────────────
  it("provisionne un portefeuille d'accueil idempotent en XAF", async () => {
    const first = await getWallet(owner.localId);
    const second = await getWallet(owner.localId);
    expect(first.currency).toBe("XAF");
    expect(first.balanceMinor).toBe(300000);
    expect(first.welcomeGranted).toBe(true);
    expect(second.balanceMinor).toBe(first.balanceMinor);
  });

  it("réserve, règle et libère les fonds avec un ledger cohérent", async () => {
    const ref = `e2e39_${stamp}`;
    const before = await getWallet(owner.localId);

    const reserved = await reserveFunds({
      userId: owner.localId,
      amountMinor: 50000,
      reference: ref,
      metadata: { scenario: "task-39" },
    });
    expect(reserved.reservedMinor).toBe(before.reservedMinor + 50000);
    expect(reserved.availableMinor).toBe(before.availableMinor - 50000);

    const settled = await settleReservation({
      userId: owner.localId,
      reference: ref,
      reservedMinor: 50000,
      actualChargeMinor: 30000,
      metadata: { scenario: "task-39" },
    });
    expect(settled.balanceMinor).toBe(before.balanceMinor - 30000);
    expect(settled.reservedMinor).toBe(before.reservedMinor);

    const ref2 = `e2e39_release_${stamp}`;
    await reserveFunds({ userId: owner.localId, amountMinor: 10000, reference: ref2 });
    const released = await releaseReservation({
      userId: owner.localId,
      reference: ref2,
      reservedMinor: 10000,
    });
    expect(released.reservedMinor).toBe(settled.reservedMinor);
    expect(released.balanceMinor).toBe(settled.balanceMinor);

    // Idempotence de réservation : même référence → pas de double réservation.
    const again = await reserveFunds({
      userId: owner.localId,
      amountMinor: 50000,
      reference: ref,
    });
    expect(again.reservedMinor).toBe(released.reservedMinor);
  });

  it("refuse une réservation supérieure au disponible", async () => {
    await expect(
      reserveFunds({
        userId: owner.localId,
        amountMinor: 10_000_000_000,
        reference: `e2e39_toobig_${stamp}`,
      }),
    ).rejects.toThrow(/wallet|balance/i);
  });
});
