import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 151 — comptes d'authentification natifs R2.
 *
 * Scrypt (hash/vérification à temps constant), unicité d'e-mail par
 * transaction (index create-if-absent), authentification par identifiants
 * (messages identiques anti-énumération), jetons de réinitialisation à
 * usage unique (TTL 30 min).
 */

const r2State = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
}));

function snapshotOf(path: string) {
  const doc = r2State.docs.get(path);
  return {
    id: path.split("/").pop() ?? "",
    exists: doc !== undefined,
    data: () => (doc === undefined ? undefined : { ...doc }),
    get: (field: string) => (doc === undefined ? undefined : doc[field]),
  };
}

function refOf(path: string) {
  return {
    __path: path,
    id: path.split("/").pop() ?? "",
    get: async () => snapshotOf(path),
    set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const current = opts?.merge ? r2State.docs.get(path) ?? {} : {};
      r2State.docs.set(path, { ...current, ...data });
    },
    update: async (patch: Record<string, unknown>) => {
      r2State.docs.set(path, { ...(r2State.docs.get(path) ?? {}), ...patch });
    },
    delete: async () => {
      r2State.docs.delete(path);
    },
  };
}

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (name: string) => ({ doc: (id: string) => refOf(`${name}/${id}`) }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const pending: Array<{ ref: ReturnType<typeof refOf>; op: string; data?: Record<string, unknown> }> = [];
      const tx = {
        get: async (ref: ReturnType<typeof refOf>) => snapshotOf(ref.__path),
        set: (ref: ReturnType<typeof refOf>, data: Record<string, unknown>) => {
          pending.push({ ref, op: "set", data });
        },
        update: (ref: ReturnType<typeof refOf>, data: Record<string, unknown>) => {
          pending.push({ ref, op: "update", data });
        },
        delete: (ref: ReturnType<typeof refOf>) => {
          pending.push({ ref, op: "delete" });
        },
      };
      const result = await fn(tx);
      for (const operation of pending) {
        if (operation.op === "set" && operation.data) await operation.ref.set(operation.data);
        else if (operation.op === "update" && operation.data) await operation.ref.update(operation.data);
        else if (operation.op === "delete") await operation.ref.delete();
      }
      return result;
    },
  },
}));

vi.mock("@/lib/r2fs", () => ({
  FieldValue: {
    serverTimestamp: () => ({ __sentinel: "serverTimestamp" }),
    increment: (n: number) => ({ __sentinel: "increment", n }),
  },
  Timestamp: {
    fromMillis: (ms: number) => ({ __ms: ms, toMillis: () => ms }),
  },
}));

import {
  authenticateR2Account,
  consumePasswordResetToken,
  createPasswordResetToken,
  createR2Account,
  emailAccountExists,
  hashPassword,
  updateR2AccountPassword,
  verifyPassword,
} from "./r2-accounts";

const EMAIL = "Marie.Example@Exemple.fr";
const EMAIL_NORMALIZED = "marie.example@exemple.fr";
const PASSWORD = "motdepasse-solide-2026";

function compteDocPath(uid: string) {
  return `authAccounts/${uid}`;
}

beforeEach(() => {
  r2State.docs.clear();
  vi.restoreAllMocks();
});

describe("scrypt — hachage de mot de passe", () => {
  it("hash puis vérification : aller-retour", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    await expect(verifyPassword(PASSWORD, hash)).resolves.toBe(true);
    await expect(verifyPassword("mauvais-mot-de-passe", hash)).resolves.toBe(false);
  });

  it("deux hachages du même mot de passe diffèrent (sel aléatoire)", async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).not.toEqual(b);
  });

  it("format stocké malformé → vérification refusée sans lever", async () => {
    await expect(verifyPassword(PASSWORD, "pas-un-hash")).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, "")).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, "scrypt$16384$8$1$$$")).resolves.toBe(false);
  });
});

describe("création de compte", () => {
  it("crée le compte + l'index e-mail dans R2", async () => {
    const account = await createR2Account({
      email: EMAIL,
      password: PASSWORD,
      displayName: "Marie Example",
      username: "Marie.Ex",
    });

    expect(account.uid).toMatch(/^r2_[a-f0-9]{24}$/);
    expect(account.email).toBe(EMAIL_NORMALIZED);
    expect(account.username).toBe("marie.ex");

    const doc = r2State.docs.get(compteDocPath(account.uid));
    expect(doc?.email).toBe(EMAIL_NORMALIZED);
    expect(doc?.passwordHash).toMatch(/^scrypt\$/);
    expect(doc?.provider).toBe("r2-password");
    // Le hash ne doit JAMAIS apparaître dans la vue publique.
    expect(JSON.stringify(doc)).not.toContain(PASSWORD);

    expect(r2State.docs.size).toBe(2); // compte + index
    await expect(emailAccountExists(EMAIL)).resolves.toBe(true);
  });

  it("e-mail déjà pris → EMAIL_TAKEN (409), aucun second compte", async () => {
    await createR2Account({ email: EMAIL, password: PASSWORD, username: "marie" });
    const avant = r2State.docs.size;

    await expect(
      createR2Account({ email: EMAIL, password: "autre-mot-de-passe-8", username: "marie2" }),
    ).rejects.toMatchObject({ code: "EMAIL_TAKEN", status: 409 });

    expect(r2State.docs.size).toBe(avant);
  });

  it("e-mail invalide → INVALID_EMAIL", async () => {
    await expect(
      createR2Account({ email: "pas-un-email", password: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_EMAIL" });
  });

  it("mot de passe trop court → WEAK_PASSWORD", async () => {
    await expect(
      createR2Account({ email: "court@exemple.fr", password: "court" }),
    ).rejects.toMatchObject({ code: "WEAK_PASSWORD" });
  });
});

describe("authentification par identifiants", () => {
  it("identifiants corrects → compte reconnu (uid identique)", async () => {
    const created = await createR2Account({
      email: EMAIL,
      password: PASSWORD,
      displayName: "Marie Example",
    });
    const authenticated = await authenticateR2Account({ email: EMAIL, password: PASSWORD });
    expect(authenticated.uid).toBe(created.uid);
    expect(authenticated.email).toBe(EMAIL_NORMALIZED);
  });

  it("mot de passe erroné → INVALID_CREDENTIALS (401) et compteur incrémenté", async () => {
    await createR2Account({ email: EMAIL, password: PASSWORD });
    await expect(
      authenticateR2Account({ email: EMAIL, password: "faux-mot-de-passe" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });

    const docs = [...r2State.docs.entries()].filter(([path]) => path.startsWith("authAccounts/"));
    expect(docs[0]?.[1]?.failedLoginAttempts).toEqual({ __sentinel: "increment", n: 1 });
  });

  it("compte inconnu → même erreur que mot de passe erroné (anti-énumération)", async () => {
    await expect(
      authenticateR2Account({ email: "inconnu@exemple.fr", password: "nimporte-quoi" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
  });
});

describe("réinitialisation de mot de passe", () => {
  it("cycle complet : jeton → nouveau mot de passe → connexion", async () => {
    const created = await createR2Account({ email: EMAIL, password: PASSWORD });

    const token = await createPasswordResetToken(EMAIL);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(r2State.docs.has(`authPasswordResets/${token}`)).toBe(true);

    const account = await consumePasswordResetToken(token!);
    expect(account?.uid).toBe(created.uid);
    // Usage unique : le document est consommé.
    expect(r2State.docs.has(`authPasswordResets/${token}`)).toBe(false);

    const NOUVEAU = "nouveau-mot-de-passe-2026";
    await updateR2AccountPassword(created.uid, NOUVEAU);
    await expect(authenticateR2Account({ email: EMAIL, password: NOUVEAU })).resolves.toBeTruthy();
    await expect(
      authenticateR2Account({ email: EMAIL, password: PASSWORD }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("jeton déjà consommé → INVALID_TOKEN", async () => {
    await createR2Account({ email: EMAIL, password: PASSWORD });
    const token = (await createPasswordResetToken(EMAIL))!;
    await consumePasswordResetToken(token);
    await expect(consumePasswordResetToken(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });

  it("jeton expiré → INVALID_TOKEN (document purgé)", async () => {
    await createR2Account({ email: EMAIL, password: PASSWORD });
    const token = (await createPasswordResetToken(EMAIL))!;
    // Expiration artificielle du document stocké.
    const path = `authPasswordResets/${token}`;
    r2State.docs.set(path, { ...r2State.docs.get(path), expiresAt: { toMillis: () => Date.now() - 1000 } });
    await expect(consumePasswordResetToken(token)).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect(r2State.docs.has(path)).toBe(false);
  });

  it("e-mail sans compte → aucun jeton créé", async () => {
    await expect(createPasswordResetToken("fantome@exemple.fr")).resolves.toBeNull();
    expect([...r2State.docs.keys()].filter((k) => k.startsWith("authPasswordResets/"))).toHaveLength(0);
  });

  it("jeton malformé → INVALID_TOKEN sans toucher R2", async () => {
    await expect(consumePasswordResetToken("pas-un-jeton")).rejects.toMatchObject({ code: "INVALID_TOKEN" });
  });
});
