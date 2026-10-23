import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

/**
 * TESTS D'ISOLATION MULTI-TENANT DES RÈGLES FIRESTORE (Task I — Pilier 3
 * Zero Trust) — @firebase/rules-unit-testing v5 (API initializeTestEnvir
 * onment / assertSucceeds / assertFails).
 *
 * CE QUE ÇA VERROUILLE (firestore.rules, deny-by-default) :
 *   1. non authentifié → refus partout ;
 *   2. isolation stricte entre organisations (org A ne lit PAS org B) ;
 *   3. propriétaire/membre → accès conforme à la matrice resource-access ;
 *   4. aucune auto-promotion (role/plan/credits réservés au serveur) ;
 *   5. portefeuille : lecture titulaire seule, écriture serveur seule ;
 *   6. bypass admin documenté (custom claim `admin`).
 *
 * LANCEMENT (émulateur Firestore requis — le test S'AUTO-DÉSACTIVE sinon,
 * pour que `npm test` reste vert sans infrastructure) :
 *   npx firebase-tools emulators:exec --only firestore "vitest run tests/firestore/rules.test.ts"
 *
 * DÉPLOIEMENT DES RÈGLES EN PRODUCTION : MANUEL, par le client —
 *   firebase deploy --only firestore:rules
 * (documenté dans docs/securite/zero-trust.md ; jamais automatisé dans la
 * CI actuelle : les règles ne prennent effet que si Firestore est réactivé
 * comme base — aujourd'hui les données vivent dans R2 via r2fs).
 */

const PROJECT_ID = "demo-gen3ia-rules";
const CHEMIN_REGLES = fileURLToPath(new URL("../../firestore.rules", import.meta.url));

/** L'émulateur Firestore doit être détecté (exec firebase) pour tourner. */
const EMULATEUR_DISPONIBLE = Boolean(
  process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_EMULATOR_HUB,
);

function hoteEmulateur(): { host: string; port: number } {
  const brut = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
  const [host, port] = brut.split(":");
  return { host: host || "127.0.0.1", port: Number(port) || 8080 };
}

// S'auto-désactive hors émulateur (npm test sans infrastructure) : le bloc
// est sauté SANS échec, et s'exécute réellement dans `firebase emulators:exec`.
(EMULATEUR_DISPONIBLE ? describe : describe.skip)("règles Firestore — isolation multi-tenant", () => {
  let env: RulesTestEnvironment;

  const aliceFs = () => env.authenticatedContext("alice").firestore(); // owner orgA
  const bobFs = () => env.authenticatedContext("bob").firestore(); // member orgA
  const carolFs = () => env.authenticatedContext("carol").firestore(); // owner orgB
  const daveFs = () => env.authenticatedContext("dave").firestore(); // sans org
  const adminFs = () =>
    env.authenticatedContext("admin", { admin: true }).firestore(); // bypass documenté
  const anonymeFs = () => env.unauthenticatedContext().firestore();

  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: await readFile(CHEMIN_REGLES, "utf8"),
        ...hoteEmulateur(),
      },
    });

    // Données SEMÉES HORS règles (rôle serveur : le SDK Admin contourne
    // les règles) — structure FIDÈLE au modèle réel (lib/tenants) :
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc("users/alice").set({ uid: "alice", role: "user", plan: "free", credits: 0, displayName: "Alice" });
      await db.doc("users/bob").set({ uid: "bob", role: "user", plan: "free", credits: 0, displayName: "Bob" });
      await db.doc("users/carol").set({ uid: "carol", role: "user", plan: "free", credits: 0, displayName: "Carol" });
      await db.doc("organizations/orgA").set({ name: "Org A", plan: "free", ownerId: "alice", settings: {} });
      await db.doc("organizations/orgA/members/alice").set({ email: "alice@gen3ia.test", role: "owner" });
      await db.doc("organizations/orgA/members/bob").set({ email: "bob@gen3ia.test", role: "member" });
      await db.doc("organizations/orgB").set({ name: "Org B", plan: "pro", ownerId: "carol", settings: {} });
      await db.doc("organizations/orgB/members/carol").set({ email: "carol@gen3ia.test", role: "owner" });
      await db.doc("orgMemberships/alice_orgA").set({ userId: "alice", orgId: "orgA", role: "owner" });
      await db.doc("orgMemberships/bob_orgA").set({ userId: "bob", orgId: "orgA", role: "member" });
      await db.doc("orgMemberships/carol_orgB").set({ userId: "carol", orgId: "orgB", role: "owner" });
      await db.doc("agents/agentA").set({ ownerId: "alice", orgId: "orgA", name: "Agent de l'org A" });
      await db.doc("agents/agentB").set({ ownerId: "carol", orgId: "orgB", name: "Agent de l'org B" });
      await db.doc("agents/agentPerso").set({ ownerId: "alice", name: "Agent personnel d'Alice" });
      await db.doc("userWallets/alice").set({ balance: 12500, currency: "XAF" });
    });
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("non authentifié → refus partout (deny-by-default)", async () => {
    await assertFails(anonymeFs().doc("users/alice").get());
    await assertFails(anonymeFs().doc("organizations/orgA").get());
    await assertFails(anonymeFs().doc("agents/agentA").get());
    await assertFails(anonymeFs().doc("userWallets/alice").get());
    await assertFails(anonymeFs().doc("agents/intrus").set({ ownerId: "x" }));
  });

  it("isolation stricte : un membre de l'org A ne lit PAS les données de l'org B", async () => {
    await assertSucceeds(aliceFs().doc("agents/agentA").get());
    await assertFails(aliceFs().doc("agents/agentB").get());
    await assertFails(aliceFs().doc("organizations/orgB").get());
    await assertFails(carolFs().doc("agents/agentA").get());
    await assertFails(carolFs().doc("organizations/orgA").get());
  });

  it("membre (rôle member) : lecture des ressources d'org, PAS de gestion", async () => {
    await assertSucceeds(bobFs().doc("agents/agentA").get());
    await assertSucceeds(bobFs().doc("organizations/orgA").get());
    await assertSucceeds(bobFs().collection("organizations/orgA/members").get());
    await assertFails(bobFs().doc("agents/agentA").update({ name: "Renommé par un member" }));
    await assertFails(bobFs().doc("organizations/orgA/members/alice").update({ role: "member" }));
  });

  it("propriétaire : accès complet à SES ressources et à SON organisation", async () => {
    await assertSucceeds(aliceFs().doc("agents/agentPerso").get());
    await assertSucceeds(aliceFs().doc("agents/agentA").update({ name: "Renommé par l'owner" }));
    await assertSucceeds(aliceFs().doc("organizations/orgA").update({ name: "Org A renommée" }));
  });

  it("ressource personnelle : le propriétaire seul y accède (hors org)", async () => {
    await assertSucceeds(aliceFs().doc("agents/agentPerso").get());
    await assertFails(bobFs().doc("agents/agentPerso").get());
    await assertFails(carolFs().doc("agents/agentPerso").get());
    await assertFails(daveFs().doc("agents/agentPerso").get());
  });

  it("profils utilisateurs : chacun ne lit/écrit que le sien, sans auto-promotion", async () => {
    await assertSucceeds(aliceFs().doc("users/alice").get());
    await assertFails(aliceFs().doc("users/bob").get());

    // Champs de présentation auto-modifiables.
    await assertSucceeds(aliceFs().doc("users/alice").update({ displayName: "Alice Martin" }));
    // Élévation INTERDITE : role/plan/credits sont réservés au serveur.
    await assertFails(aliceFs().doc("users/alice").update({ role: "admin" }));
    await assertFails(aliceFs().doc("users/alice").update({ plan: "enterprise" }));
    await assertFails(aliceFs().doc("users/alice").update({ credits: 1000000 }));
    // Suppression : serveur uniquement (RGPD via /api/settings/*).
    await assertFails(aliceFs().doc("users/alice").delete());
  });

  it("création de ressource : owner documenté = appelant ; rattachement org refusé hors membre", async () => {
    await assertSucceeds(daveFs().doc("agents/agentDave").set({ ownerId: "dave", name: "Agent perso" }));
    // Dave n'est membre d'AUCUNE org : rattachement à orgA/orgB refusé
    // (même règle que assertOrgTransfer côté serveur).
    await assertFails(daveFs().doc("agents/agentFraude").set({ ownerId: "dave", orgId: "orgA" }));
    // Usurpation de propriétaire refusée.
    await assertFails(daveFs().doc("agents/agentUsurpe").set({ ownerId: "alice" }));
    // Bob (membre orgA) peut rattacher SON agent à orgA.
    await assertSucceeds(bobFs().doc("agents/agentBob").set({ ownerId: "bob", orgId: "orgA" }));
    // ... mais PAS à orgB.
    await assertFails(bobFs().doc("agents/agentBobOrgB").set({ ownerId: "bob", orgId: "orgB" }));
  });

  it("portefeuille : lecture titulaire seule, écriture SERVEUR uniquement", async () => {
    await assertSucceeds(aliceFs().doc("userWallets/alice").get());
    await assertFails(aliceFs().doc("userWallets/alice").update({ balance: 999999999 }));
    await assertFails(bobFs().doc("userWallets/alice").get());
    await assertFails(anonymeFs().doc("userWallets/alice").get());
  });

  it("index d'appartenance orgMemberships : lecture de SES adhesions, écriture serveur", async () => {
    await assertSucceeds(aliceFs().doc("orgMemberships/alice_orgA").get());
    await assertFails(aliceFs().doc("orgMemberships/bob_orgA").get());
    await assertFails(aliceFs().doc("orgMemberships/alice_orgA").update({ role: "admin" }));
  });

  it("bypass admin documenté : le claim `admin` lit tout (défense serveur assumée)", async () => {
    await assertSucceeds(adminFs().doc("agents/agentA").get());
    await assertSucceeds(adminFs().doc("agents/agentB").get());
    await assertSucceeds(adminFs().doc("users/alice").get());
  });

  it("collections système non décrites → refus par défaut (tout le reste)", async () => {
    // Files/registres internes (missionQueue, executions, usage, locks…)
    // : aucun accès client direct — le serveur (Admin SDK/r2fs) contourne
    // les règles, le client n'y a JAMAIS accès.
    await assertFails(aliceFs().doc("missionQueue/tick1").get());
    await assertFails(aliceFs().doc("missionQueue/tick1").set({ jobId: "x" }));
    await assertFails(aliceFs().doc("toolAuditLogs/evt1").get());
    await assertFails(aliceFs().doc("locks/ressource").set({ owner: "alice" }));
  });
});
