import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, describe, it } from "vitest";

/**
 * Tests unitaires des RÈGLES Firestore (Task 39, Rec 2.4).
 *
 * Matrice de couverture des collections sensibles :
 *  - users : accès propriétaire seul, suppression client interdite ;
 *  - agents : isolation stricte par ownerId ;
 *  - teams + members : lecture réservée aux membres, mutations hiérarchiques ;
 *  - userWallets / walletLedger : le client ne peut JAMAIS écrire son
 *    portefeuille (toute mutation passe par l'Admin SDK) ;
 *  - collections serveur-seul (chatConversations, chatMessages,
 *    liveAgentSessions) : verrouillées lecture ET écriture ;
 *  - organizations (multi-tenant) : lecture membre, update/delete client interdits.
 *
 * Pré-requis : émulateur Firestore sur 127.0.0.1:8080 (npm run test:e2e).
 */

const PROJECT_ID = "demo-gen3ia";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.GCLOUD_PROJECT = PROJECT_ID;

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(join(process.cwd(), "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

/** Fixture : un agent appartenant à alice, une équipe avec alice admin et bob membre. */
async function seedFixtures(): Promise<{ alice: string; bob: string; teamId: string; agentId: string }> {
  const alice = "alice-uid";
  const bob = "bob-uid";
  const teamId = "team-1";
  const agentId = "agent-1";

  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.doc(`users/${alice}`).set({ uid: alice, email: "alice@gen3ia.test" });
    await db.doc(`users/${bob}`).set({ uid: bob, email: "bob@gen3ia.test" });
    await db.doc(`agents/${agentId}`).set({ ownerId: alice, name: "Agent Alice" });
    await db.doc(`userWallets/${alice}`).set({ balanceMinor: 300000, currency: "XAF" });
    await db.doc(`userWallets/${bob}`).set({ balanceMinor: 300000, currency: "XAF" });
    await db.doc(`teams/${teamId}`).set({ name: "Équipe", ownerId: alice, memberCount: 2 });
    await db.doc(`teams/${teamId}/members/${alice}`).set({ role: "admin", userId: alice });
    await db.doc(`teams/${teamId}/members/${bob}`).set({ role: "viewer", userId: bob });
    await db.doc(`organizations/org-1`).set({ ownerId: alice, name: "Org A" });
    await db.doc(`organizations/org-1/members/${alice}`).set({ role: "owner" });
    await db.doc(`organizations/org-1/members/${bob}`).set({ role: "member" });
    await db.doc(`organizations/org-2`).set({ ownerId: alice, name: "Org B" });
    await db.doc(`organizations/org-2/members/${alice}`).set({ role: "owner" });
    await db.doc(`agents/agent-org-1`).set({ ownerId: alice, orgId: "org-1", name: "Agent Org" });
    await db.doc(`knowledgeDocuments/kdoc-org-1`).set({ userId: alice, orgId: "org-1", name: "Doc org" });
  });
  return { alice, bob, teamId, agentId };
}

describe("Règles Firestore : isolation multi-tenant", () => {
  it("users — le propriétaire lit, l'autre utilisateur est refusé, delete interdit", async () => {
    await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();
    const bobDb = testEnv.authenticatedContext("bob-uid").firestore();

    await assertSucceeds(aliceDb.doc("users/alice-uid").get());
    await assertFails(bobDb.doc("users/alice-uid").get());
    await assertFails(aliceDb.doc("users/alice-uid").delete());
  });

  it("agents — seul le propriétaire lit et écrit", async () => {
    const { agentId } = await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();
    const bobDb = testEnv.authenticatedContext("bob-uid").firestore();

    await assertSucceeds(aliceDb.doc(`agents/${agentId}`).get());
    await assertFails(bobDb.doc(`agents/${agentId}`).get());
    await assertFails(bobDb.doc(`agents/${agentId}`).update({ name: "détourné" }));
    await assertSucceeds(aliceDb.doc(`agents/${agentId}`).update({ name: "Renommé" }));
  });

  it("agents — un utilisateur anonyme ne peut rien lire", async () => {
    const { agentId } = await seedFixtures();
    const anonDb = testEnv.unauthenticatedContext().firestore();
    await assertFails(anonDb.doc(`agents/${agentId}`).get());
  });

  it("teams — lecture réservée aux membres, update aux admins, delete au propriétaire", async () => {
    const { teamId } = await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();
    const bobDb = testEnv.authenticatedContext("bob-uid").firestore();
    const outsiderDb = testEnv.authenticatedContext("outsider-uid").firestore();

    await assertSucceeds(aliceDb.doc(`teams/${teamId}`).get());
    await assertSucceeds(bobDb.doc(`teams/${teamId}`).get());
    await assertFails(outsiderDb.doc(`teams/${teamId}`).get());

    // bob (viewer) ne peut pas modifier l'équipe ni inviter.
    await assertFails(bobDb.doc(`teams/${teamId}`).update({ name: "Piraté" }));
    await assertFails(
      bobDb.collection(`teams/${teamId}/members`).add({ role: "owner", userId: "bob-uid" }),
    );
  });

  it("userWallets — lecture propriétaire seule, ÉCRITURE CLIENT IMPOSSIBLE", async () => {
    const { alice } = await seedFixtures();
    const aliceDb = testEnv.authenticatedContext(alice).firestore();

    await assertSucceeds(aliceDb.doc(`userWallets/${alice}`).get());
    // Le client ne peut ni créditer son solde ni créer un portefeuille.
    await assertFails(aliceDb.doc(`userWallets/${alice}`).update({ balanceMinor: 999_999_999 }));
    await assertFails(aliceDb.doc("userWallets/attacker-uid").set({ balanceMinor: 1 }));
  });

  it("walletLedger — lecture admin seule, écriture interdite au client", async () => {
    await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();
    await assertFails(aliceDb.doc("walletLedger/entry-1").get());
    await assertFails(
      aliceDb.doc("walletLedger/entry-1").set({ amountMinor: 1, type: "reservation" }),
    );
  });

  it("collections serveur-seul — chatConversations/chatMessages/liveAgentSessions verrouillées", async () => {
    await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();

    await assertFails(aliceDb.doc("chatConversations/conv-1").get());
    await assertFails(aliceDb.doc("chatConversations/conv-1").set({ title: "x" }));
    await assertFails(aliceDb.doc("chatMessages/msg-1").set({ text: "x" }));
    await assertFails(aliceDb.doc("liveAgentSessions/sess-1").get());
  });

  it("organizations — lecture membre, update/delete client interdits (Admin SDK seul)", async () => {
    await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();
    const outsiderDb = testEnv.authenticatedContext("outsider-uid").firestore();

    await assertSucceeds(aliceDb.doc("organizations/org-1").get());
    await assertFails(outsiderDb.doc("organizations/org-1").get());
    await assertFails(aliceDb.doc("organizations/org-1").update({ name: "Renommée" }));
    await assertFails(aliceDb.doc("organizations/org-1").delete());
    // Le client ne peut pas écrire les sous-collections membres/invitations.
    await assertFails(
      aliceDb.doc("organizations/org-1/members/outsider-uid").set({ role: "owner" }),
    );
  });

  it("agents org (rec C) — membre lit, ne gère pas ; owner/org écrit ; étranger rien", async () => {
    const { bob } = await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();
    const bobDb = testEnv.authenticatedContext("bob-uid").firestore();
    const outsiderDb = testEnv.authenticatedContext("outsider-uid").firestore();

    // bob (member org-1) LIT l'agent d'org mais ne peut ni le modifier ni le supprimer.
    await assertSucceeds(bobDb.doc("agents/agent-org-1").get());
    await assertFails(bobDb.doc("agents/agent-org-1").update({ name: "Détourné" }));
    await assertFails(bobDb.doc("agents/agent-org-1").delete());

    // alice (owner org) écrit.
    await assertSucceeds(aliceDb.doc("agents/agent-org-1").update({ name: "Renommé par owner" }));

    // L'étranger (hors org) ne voit même pas l'agent.
    await assertFails(outsiderDb.doc("agents/agent-org-1").get());

    // ownerId immuable : même l'owner de l'org ne peut pas réattribuer l'agent.
    await assertFails(bobDb.doc("agents/agent-org-1").update({ ownerId: bob }));
  });

  it("agents org (rec C) — création avec orgId : membre ok, non-membre refusé", async () => {
    const { bob } = await seedFixtures();
    const bobDb = testEnv.authenticatedContext("bob-uid").firestore();
    const outsiderDb = testEnv.authenticatedContext("outsider-uid").firestore();

    // bob est membre d'org-1 → il peut y publier un agent.
    await assertSucceeds(
      bobDb.collection("agents").add({ ownerId: bob, orgId: "org-1", name: "Agent de Bob" }),
    );
    // bob n'est PAS membre d'org-2 → refus.
    await assertFails(
      bobDb.collection("agents").add({ ownerId: bob, orgId: "org-2", name: "Agent interdit" }),
    );
    // L'étranger ne peut pas publier dans org-1 non plus.
    await assertFails(
      outsiderDb.collection("agents").add({ ownerId: "outsider-uid", orgId: "org-1", name: "Piraté" }),
    );
  });

  it("knowledgeDocuments org (rec C) — membre lit, étranger refusé, ownerId immuable", async () => {
    const { bob } = await seedFixtures();
    const bobDb = testEnv.authenticatedContext("bob-uid").firestore();
    const outsiderDb = testEnv.authenticatedContext("outsider-uid").firestore();

    await assertSucceeds(bobDb.doc("knowledgeDocuments/kdoc-org-1").get());
    await assertFails(outsiderDb.doc("knowledgeDocuments/kdoc-org-1").get());
    // Le créateur reste le créateur : bob ne peut pas se réattribuer le doc.
    await assertFails(bobDb.doc("knowledgeDocuments/kdoc-org-1").update({ userId: bob }));
  });

  it("workflows org (rec C) — lecture membre, écriture client fermée (Admin SDK seul)", async () => {
    const { alice } = await seedFixtures();
    const bobDb = testEnv.authenticatedContext("bob-uid").firestore();

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("workflows/wf-org-1").set({ userId: alice, orgId: "org-1", name: "WF" });
    });
    await assertSucceeds(bobDb.doc("workflows/wf-org-1").get());
    await assertFails(bobDb.doc("workflows/wf-org-1").delete());
  });

  it("collections inconnues — refus par défaut (deny-all)", async () => {
    await seedFixtures();
    const aliceDb = testEnv.authenticatedContext("alice-uid").firestore();
    await assertFails(aliceDb.doc("unknownCollection/doc-1").get());
    await assertFails(aliceDb.doc("unknownCollection/doc-1").set({ a: 1 }));
  });
});
