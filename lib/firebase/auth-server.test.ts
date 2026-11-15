import { generateKeyPairSync, createSign } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "gen3ia-b5a92";

import { verifyFirebaseToken } from "./auth-server";

const CLIENT_PROJECT = "gen3ia-b5a92";
const WEB_API_KEY =
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY?.trim() || "";

interface CreatedAccount {
  idToken: string;
  localId: string;
  email: string;
}

const createdAccounts: string[] = [];

async function createRealTestAccount(): Promise<CreatedAccount> {
  const email = `auth-server-test-${Date.now()}-${Math.floor(
    Math.random() * 1e6
  )}@gen3ia-diag.test`;

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${WEB_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "TestValide!2026",
        returnSecureToken: true,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `accounts:signUp failed: HTTP ${response.status} ${await response.text()}`
    );
  }

  const data = (await response.json()) as {
    idToken: string;
    localId: string;
  };

  createdAccounts.push(data.idToken);

  return { idToken: data.idToken, localId: data.localId, email };
}

afterAll(async () => {
  for (const idToken of createdAccounts) {
    try {
      await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${WEB_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        }
      );
    } catch {
      // best effort
    }
  }
});

/** Construit un JWT RS256 auto-signé (échouera à la vérification de signature
 * contre les certificats Google, mais permet de tester les checks de claims). */
function selfSignedJwt(payload: Record<string, unknown>): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  const header = { alg: "RS256", typ: "JWT", kid: "local-test-key" };

  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const signingInput = `${encode(header)}.${encode(payload)}`;

  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(pem);

  return `${signingInput}.${signature.toString("base64url")}`;
}

describe("verifyFirebaseToken (vérification JWT sans Admin SDK)", () => {
  it("rejette les entrées invalides", async () => {
    await expect(verifyFirebaseToken(null)).rejects.toThrow(
      "Missing authorization header."
    );
    await expect(verifyFirebaseToken("Token abc")).rejects.toThrow(
      "Invalid authorization scheme."
    );
    await expect(verifyFirebaseToken("Bearer ")).rejects.toThrow(
      "Missing Firebase ID token."
    );
    await expect(
      verifyFirebaseToken("Bearer pas.un.jwt")
    ).rejects.toThrow("Invalid or revoked Firebase ID token.");
  });

  it("rejette une audience / un émetteur qui ne correspondent pas", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = selfSignedJwt({
      iss: `https://securetoken.google.com/autre-projet`,
      aud: "autre-projet",
      sub: "uid-123",
      exp: now + 3600,
      iat: now,
      auth_time: now,
    });

    await expect(verifyFirebaseToken(`Bearer ${token}`)).rejects.toThrow(
      "Invalid or revoked Firebase ID token."
    );
  });

  it("rejette un token expiré", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = selfSignedJwt({
      iss: `https://securetoken.google.com/${CLIENT_PROJECT}`,
      aud: CLIENT_PROJECT,
      sub: "uid-123",
      exp: now - 3600,
      iat: now - 7200,
      auth_time: now - 7200,
    });

    await expect(verifyFirebaseToken(`Bearer ${token}`)).rejects.toThrow(
      "Invalid or revoked Firebase ID token."
    );
  });

  it("rejette un token aux claims corrects mais signé par une clé inconnue", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = selfSignedJwt({
      iss: `https://securetoken.google.com/${CLIENT_PROJECT}`,
      aud: CLIENT_PROJECT,
      sub: "uid-123",
      exp: now + 3600,
      iat: now,
      auth_time: now,
    });

    await expect(verifyFirebaseToken(`Bearer ${token}`)).rejects.toThrow(
      "Invalid or revoked Firebase ID token."
    );
  });

  it.runIf(WEB_API_KEY)(
    "valide un VRAI token émis par Identity Toolkit (compte jetable)",
    { timeout: 30000 },
    async () => {
    const account = await createRealTestAccount();
    const decoded = await verifyFirebaseToken(
      `Bearer ${account.idToken}`
    );

    expect(decoded.uid).toBe(account.localId);
    expect(decoded.sub).toBe(account.localId);
    expect(decoded.aud).toBe(CLIENT_PROJECT);
    expect(decoded.iss).toBe(
      `https://securetoken.google.com/${CLIENT_PROJECT}`
    );
    expect(decoded.firebase?.sign_in_provider).toBe("password");
    }
  );
});
