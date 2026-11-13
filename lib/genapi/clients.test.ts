import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Registre des clients genAPI — allowlist d'empreintes + statut.
 * Firestore factice (état hoisted, conventions render-queue-resume.test.ts)
 * ; OpenSSL simulé (caDisponible), normaliserEmpreinte reste RÉELLE.
 */

const EMPREINTE_ACTIVE = vi.hoisted(() => "12".repeat(32));
const EMPREINTE_REVOQUEE = vi.hoisted(() => "34".repeat(32));

const etat = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  ops: [] as Array<{ kind: string; path: string; payload?: unknown }>,
  /** Résultat paramétrable de la requête d'allowlist (par empreinte). */
  resultatsRequete: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/genapi/openssl", async (importOriginal) => {
  const reel = await importOriginal<typeof import("@/lib/genapi/openssl")>();
  return {
    ...reel,
    caDisponible: vi.fn(async () => true),
  };
});

vi.mock("@/lib/db/firestore-resilient", async () => {
  return {
    writeCheckpointSet: async (collection: string, id: string, payload: Record<string, unknown>) => {
      const chemin = `${collection}/${id}`;
      etat.ops.push({ kind: "writeCheckpointSet", path: chemin, payload });
      etat.docs.set(chemin, { ...(etat.docs.get(chemin) ?? {}), ...payload });
    },
    resilientGet: async (_collection: string, id: string) => etat.docs.get(`genapiStats/${id}`) ?? null,
    resilientQuery: vi.fn(async (_collection: string, filtres: Array<{ field: string; value: unknown }>) => {
      etat.ops.push({ kind: "where", path: `filtre ${JSON.stringify(filtres)}` });
      return etat.resultatsRequete;
    }),
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (nom: string) => ({
      add: async (payload: Record<string, unknown>) => {
        etat.ops.push({ kind: "add", path: nom, payload });
        return {};
      },
      doc: (id: string) => ({ __path: `${nom}/${id}` }),
    }),
  },
}));

import {
  empreinteAutorisee,
  listerClients,
  reinitialiserCacheEmpreintes,
  revoquerClient,
  statutGenAPI,
} from "@/lib/genapi/clients";
import { resilientQuery } from "@/lib/db/firestore-resilient";

/** Compteur d'appels à la requête d'allowlist (le cache doit les plafonner). */
function appelsRequete(): number {
  return vi.mocked(resilientQuery).mock.calls.length;
}

beforeEach(() => {
  etat.docs.clear();
  etat.ops.length = 0;
  etat.resultatsRequete = [];
  reinitialiserCacheEmpreintes();
});

describe("empreinteAutorisee — allowlist Firestore + cache mémoire 60 s", () => {
  it("empreinte active allowlistée → true", async () => {
    etat.resultatsRequete = [{ empreinte: EMPREINTE_ACTIVE, statut: "actif" }];
    await expect(empreinteAutorisee(EMPREINTE_ACTIVE)).resolves.toBe(true);
  });

  it("empreinte révoquée (statut revoque) → false", async () => {
    etat.resultatsRequete = [{ empreinte: EMPREINTE_REVOQUEE, statut: "revoque" }];
    await expect(empreinteAutorisee(EMPREINTE_REVOQUEE)).resolves.toBe(false);
  });

  it("empreinte inconnue → false (allowlist vide)", async () => {
    etat.resultatsRequete = [];
    await expect(empreinteAutorisee("ef".repeat(32))).resolves.toBe(false);
  });

  it("empreinte malformée → false SANS requête Firestore", async () => {
    await expect(empreinteAutorisee("pas-une-empreinte")).resolves.toBe(false);
    expect(appelsRequete()).toBe(0);
  });

  it("cache : 2 appels consécutifs → UNE SEULE requête Firestore", async () => {
    etat.resultatsRequete = [{ empreinte: EMPREINTE_ACTIVE, statut: "actif" }];
    await expect(empreinteAutorisee(EMPREINTE_ACTIVE)).resolves.toBe(true);
    await expect(empreinteAutorisee(EMPREINTE_ACTIVE)).resolves.toBe(true);
    expect(appelsRequete()).toBe(1);
  });

  it("cache par empreinte : une autre empreinte déclenche sa propre requête", async () => {
    etat.resultatsRequete = [{ empreinte: EMPREINTE_ACTIVE, statut: "actif" }];
    await empreinteAutorisee(EMPREINTE_ACTIVE);
    etat.resultatsRequete = [{ empreinte: EMPREINTE_REVOQUEE, statut: "revoque" }];
    await empreinteAutorisee(EMPREINTE_REVOQUEE);
    expect(appelsRequete()).toBe(2);
  });

  it("normalisation tolérante : empreinte avec deux-points/majuscules → même verdict que le format stocké", async () => {
    etat.resultatsRequete = [{ empreinte: EMPREINTE_ACTIVE, statut: "actif" }];
    const brute = `sha256 Fingerprint=${"12:".repeat(31)}12`;
    await expect(empreinteAutorisee(brute)).resolves.toBe(true);
    // La requête Firestore porte la forme NORMALISÉE (celle stockée).
    const arguments_ = vi.mocked(resilientQuery).mock.calls[0] as unknown as [
      string,
      Array<{ field: string; value: string }>,
    ];
    expect(arguments_[1][0].value).toBe(EMPREINTE_ACTIVE);
    expect(arguments_[1][0].field).toBe("empreinte");
  });
});

describe("revoquerClient — révocation effective immédiate", () => {
  it("écrit statut revoque + revoqueA, journalise, vide le cache", async () => {
    etat.resultatsRequete = [{ empreinte: EMPREINTE_ACTIVE, statut: "actif" }];
    await empreinteAutorisee(EMPREINTE_ACTIVE); // cache chaud
    const avant = appelsRequete();

    await expect(revoquerClient("u-genapi-revoque")).resolves.toBe(true);

    const ecriture = etat.ops.find((op) => op.kind === "writeCheckpointSet" && op.path === "genapiClients/u-genapi-revoque");
    expect(ecriture).toBeDefined();
    expect((ecriture!.payload as { statut: string }).statut).toBe("revoque");
    expect((ecriture!.payload as { revoqueA: string }).revoqueA).toBeTruthy();
    const evenements = etat.ops.filter((op) => op.kind === "add").map((op) => (op.payload as { evenement: string }).evenement);
    expect(evenements).toContain("client_revoque");

    // Cache vidé : l'appel suivant re-requête Firestore (le verdict d'avant
    // est invalidé même si le doc Firestore n'a pas encore été relu).
    etat.resultatsRequete = [{ empreinte: EMPREINTE_ACTIVE, statut: "revoque" }];
    await expect(empreinteAutorisee(EMPREINTE_ACTIVE)).resolves.toBe(false);
    expect(appelsRequete()).toBeGreaterThan(avant);
  });

  it("uid invalide → false + journal client_revoque_ko, aucune écriture", async () => {
    await expect(revoquerClient("mauvais/uid")).resolves.toBe(false);
    expect(etat.ops.filter((op) => op.kind === "writeCheckpointSet")).toHaveLength(0);
    const evenements = etat.ops.filter((op) => op.kind === "add").map((op) => (op.payload as { evenement: string }).evenement);
    expect(evenements).toContain("client_revoque_ko");
  });
});

describe("listerClients — projection défensive", () => {
  it("mapping complet (actif) et gestion des champs manquants", async () => {
    vi.mocked(resilientQuery).mockResolvedValueOnce([
      {
        uid: "u-1",
        email: "un@saas.fr",
        empreinte: EMPREINTE_ACTIVE,
        statut: "actif",
        creeA: "2025-01-05T10:00:00.000Z",
      },
      {
        uid: "u-2",
        email: "deux@saas.fr",
        empreinte: EMPREINTE_REVOQUEE,
        statut: "revoque",
        creeA: "2025-01-04T10:00:00.000Z",
        revoqueA: "2025-01-06T09:00:00.000Z",
      },
      {},
    ] as never);
    vi.mocked(resilientQuery).mockClear();

    const clients = await listerClients();
    expect(clients).toHaveLength(3);
    expect(clients[0]).toEqual({
      uid: "u-1",
      email: "un@saas.fr",
      empreinte: EMPREINTE_ACTIVE,
      statut: "actif",
      creeA: "2025-01-05T10:00:00.000Z",
    });
    expect(clients[1]!.statut).toBe("revoque");
    expect(clients[1]!.revoqueA).toBe("2025-01-06T09:00:00.000Z");
    expect(clients[2]!.statut).toBe("actif"); // défaut défensif
    expect(clients[2]!.empreinte).toBe("");
    // Requête : tri décroissant sur creeA, plafond 200.
    const arguments_ = vi.mocked(resilientQuery).mock.calls[0] as unknown as [
      string,
      unknown[],
      Record<string, unknown>,
    ];
    expect(arguments_[0]).toBe("genapiClients");
    expect(arguments_[2].orderField).toBe("creeA");
    expect(arguments_[2].descending).toBe(true);
    expect(arguments_[2].limit).toBe(200);
  });
});

describe("statutGenAPI — état admin (CA + compteurs du jour)", () => {
  it("agrège CA disponible, compteurs genapiStats et décompte clients", async () => {
    const dateIso = new Date().toISOString().slice(0, 10);
    // Le moteur r2fs a RÉSOLU les sentinelles FieldValue.increment à
    // l'écriture : la lecture retourne des nombres simples.
    etat.docs.set(`genapiStats/${dateIso}`, {
      date: dateIso,
      executions: 7,
      echecs: 2,
      creditsDebitesMinor: 105,
    });
    etat.resultatsRequete = [
      { uid: "u-1", statut: "actif" },
      { uid: "u-2", statut: "revoque" },
      { uid: "u-3", statut: "actif" },
    ];

    const statut = await statutGenAPI();
    expect(statut.caDisponible).toBe(true);
    expect(statut.executions).toBe(7);
    expect(statut.echecs).toBe(2);
    expect(statut.creditsDebitesMinor).toBe(105);
    expect(statut.clientsTotal).toBe(3);
    expect(statut.clientsActifs).toBe(2);
    expect(statut.date).toBe(dateIso);
  });

  it("doc genapiStats absent du jour → compteurs à 0 (première exécution)", async () => {
    etat.resultatsRequete = [];
    const statut = await statutGenAPI();
    expect(statut.executions).toBe(0);
    expect(statut.echecs).toBe(0);
    expect(statut.creditsDebitesMinor).toBe(0);
    expect(statut.clientsTotal).toBe(0);
  });
});
