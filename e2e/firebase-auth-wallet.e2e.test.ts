import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { creerMockR2Memoire } from "./helpers/r2-memoire";

const PROJECT_ID = "demo-gen3ia";
const AUTH_EMULATOR = "127.0.0.1:9099";
const FIRESTORE_EMULATOR = "127.0.0.1:8080";
const TEST_EMAIL = `e2e-${Date.now()}@gen3ia.test`;
const TEST_PASSWORD = "Gen3iaE2E!2026";

process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.FIREBASE_AUTH_EMULATOR_HOST = AUTH_EMULATOR;
process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_EMULATOR;
process.env.GCLOUD_PROJECT = PROJECT_ID;

/**
 * Task 108 — la base d'identités vit dans R2. L'environnement E2E (émulateurs
 * Firebase) n'a PAS de bucket R2 : le CLIENT R2 (lib/storage/r2) est simulé
 * EN MÉMOIRE — la logique d'identité (schéma, service, session) s'exécute
 * RÉELLEMENT par-dessus. Clé simulée = objet Map « key → Buffer ».
 */

const mockR2 = creerMockR2Memoire();
vi.mock("@/lib/storage/r2", () => mockR2);

async function createAndSignIn(): Promise<{ idToken: string; localId: string }> {
  const createResponse = await fetch(
    `http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=e2e`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true }),
    },
  );

  if (createResponse.ok) {
    return (await createResponse.json()) as { idToken: string; localId: string };
  }

  const signInResponse = await fetch(
    `http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=e2e`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, returnSecureToken: true }),
    },
  );
  expect(signInResponse.ok).toBe(true);
  return (await signInResponse.json()) as { idToken: string; localId: string };
}

describe("Firebase E2E: inscription -> session -> portefeuille", () => {
  let verifyFirebaseToken: typeof import("@/lib/firebase/auth-server").verifyFirebaseToken;
  let getWallet: typeof import("@/lib/billing/wallet").getWallet;
  let adminDb: typeof import("@/lib/firebase/admin").adminDb;
  let sessionPost: typeof import("@/app/api/auth/session/route").POST;

  beforeAll(async () => {
    ({ verifyFirebaseToken } = await import("@/lib/firebase/auth-server"));
    ({ getWallet } = await import("@/lib/billing/wallet"));
    ({ adminDb } = await import("@/lib/firebase/admin"));
    ({ POST: sessionPost } = await import("@/app/api/auth/session/route"));
  });

  afterAll(async () => {
    const userSnap = await adminDb.collection("users").where("email", "==", TEST_EMAIL).limit(1).get();
    await Promise.all(userSnap.docs.map((doc) => doc.ref.delete()));
  });

  it("inscrit un utilisateur Firebase et obtient un ID token", async () => {
    const { idToken, localId } = await createAndSignIn();
    expect(localId).toMatch(/^.+$/);
    expect(idToken.split(".")).toHaveLength(3);
  });

  it("établit la session via /api/auth/session et enregistre l'identité dans la base R2", async () => {
    const { idToken, localId } = await createAndSignIn();
    const token = await verifyFirebaseToken(`Bearer ${idToken}`);
    expect(token.uid).toBe(localId);

    const response = await sessionPost(
      new Request("http://localhost/api/auth/session", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}` },
      }) as never,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authenticated: boolean;
      degraded?: boolean;
      user: { uid: string; email: string | null; theme?: string };
      wallet: { currency: string; balanceMinor: number; availableMinor: number };
    };

    expect(body.authenticated).toBe(true);
    expect(body.user.uid).toBe(localId);
    expect(body.user.email).toBe(TEST_EMAIL);
    expect(body.wallet.currency).toBe("XAF");
    // Task 108 : le provisionnement identité (R2) a RÉUSSI — pas de mode
    // dégradé, et le thème par défaut de la nouvelle identité est posé.
    expect(body.degraded).toBeFalsy();
    expect(body.user.theme).toBe("dark");

    // La base d'identités = R2 (client simulé en mémoire) : le document
    // identities/{uid}.json existe et porte l'identité provisionnée.
    const { getIdentity } = await import("@/lib/identity/r2-identity-store");
    const identity = await getIdentity(localId);
    expect(identity).not.toBeNull();
    expect(identity?.uid).toBe(localId);
    expect(identity?.email).toBe(TEST_EMAIL);
    expect(identity?.theme).toBe("dark");
    // Le fournisseur d'identifiants du jeton est tracé (émulateur : « password »).
    expect((identity?.providers ?? []).length).toBeGreaterThan(0);
    // Le document R2 est bien matérialisé sous la clé canonique.
    expect(mockR2.cles().some((key) => key === `identities/${localId}.json`)).toBe(true);
  });

  it("initialise le portefeuille une seule fois avec le solde d'accueil", async () => {
    const { idToken, localId } = await createAndSignIn();
    const token = await verifyFirebaseToken(`Bearer ${idToken}`);
    expect(token.uid).toBe(localId);

    const first = await getWallet(localId);
    const second = await getWallet(localId);

    expect(first.currency).toBe("XAF");
    expect(first.balanceMinor).toBe(300000);
    expect(first.reservedMinor).toBe(0);
    expect(first.availableMinor).toBe(300000);
    expect(first.welcomeGranted).toBe(true);
    expect(second.balanceMinor).toBe(first.balanceMinor);

    const wallet = await adminDb.collection("userWallets").doc(localId).get();
    const ledger = await adminDb.collection("walletLedger").doc(`welcome_${localId}`).get();
    expect(wallet.exists).toBe(true);
    expect(ledger.exists).toBe(true);
    expect(ledger.get("type")).toBe("welcome_grant");

    const ledgers = await adminDb.collection("walletLedger").where("userId", "==", localId).get();
    expect(ledgers.size).toBe(1);
  });
});
