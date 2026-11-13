import { existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { extrairePaquet } from "@/lib/genapi/paquet";

/**
 * Pipeline maître de provisionnement — tests d'intégration avec le VRAI
 * système de fichiers : les fonctions OpenSSL sont SIMULÉES (pas de binaire
 * requis en CI) mais ÉCRIVENT de vrais fichiers dans le tmpdir réel du
 * pipeline, de sorte que la destruction de la clé privée est prouvée par
 * le disque (existsSync === false) et non par un simple mock.
 *
 * Firestore est factice (état hoisted, mêmes conventions que
 * render-queue-resume.test.ts) via les mocks de @/lib/firebase/admin et de
 * la couche résiliente.
 */

// ---------------------------------------------------------------------------
// État hoisted — Firestore factice + chemin de clé écrit par le mock OpenSSL
// ---------------------------------------------------------------------------

const etat = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
  ops: [] as Array<{ kind: string; path: string; payload?: unknown }>,
  /** Chemins de clés privées RÉELLEMENT écrits par le mock openssl (prouve l'effacement). */
  cheminsCle: [] as string[],
}));

const EMPREINTE = vi.hoisted(() => "ab".repeat(32));

vi.mock("@/lib/genapi/openssl", async () => {
  const fs = await import("node:fs");
  return {
    caDisponible: vi.fn(async () => true),
    genererClePriveeClient: vi.fn(async (cheminCle: string) => {
      fs.writeFileSync(cheminCle, "-----BEGIN CLE PRIVEE SIMULEE-----\nMATERIEL-SECRET-DE-TEST\n-----END CLE PRIVEE SIMULEE-----\n");
      etat.cheminsCle.push(cheminCle);
    }),
    signerCertificatClient: vi.fn(async (params: { cheminCsr: string; cheminCrt: string }) => {
      fs.writeFileSync(params.cheminCsr, "-----CSR SIMULEE DE TEST-----\n");
      fs.writeFileSync(params.cheminCrt, "-----CERTIFICAT SIMULE DE TEST-----\n");
    }),
    extraireEmpreinte: vi.fn(async () => EMPREINTE),
    construireSujetClient: (uid: string) => `/CN=gen3-client-${uid}/O=Gen3ia SaaS/OU=genAPI`,
    normaliserEmpreinte: (brute: string) => brute.replace(/[^0-9a-f]/gi, "").toLowerCase(),
  };
});

vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: (nom: string) => ({
      doc: (id: string) => {
        const chemin = `${nom}/${id}`;
        return {
          __path: chemin,
        };
      },
      add: async (payload: Record<string, unknown>) => {
        etat.ops.push({ kind: "add", path: nom, payload });
        etat.docs.set(`${nom}/${etat.docs.size}-journal`, { ...payload });
        return { __path: `${nom}/journal` };
      },
    }),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: async (ref: { __path: string }) => {
          const donnees = etat.docs.get(ref.__path);
          return donnees ? { exists: true, data: () => donnees } : { exists: false, data: () => undefined };
        },
        update: (ref: { __path: string }, patch: Record<string, unknown>) => {
          etat.ops.push({ kind: "tx-update", path: ref.__path, payload: patch });
          const existant = etat.docs.get(ref.__path) ?? {};
          etat.docs.set(ref.__path, { ...existant, ...patch });
        },
      }),
  },
}));

vi.mock("@/lib/db/firestore-resilient", () => ({
  writeCheckpointSet: async (collection: string, id: string, payload: Record<string, unknown>) => {
    const chemin = `${collection}/${id}`;
    etat.ops.push({ kind: "writeCheckpointSet", path: chemin, payload });
    const existant = etat.docs.get(chemin) ?? {};
    etat.docs.set(chemin, { ...existant, ...payload });
  },
  resilientQuery: vi.fn(async () => []),
  resilientGet: vi.fn(async () => null),
}));

import { provisionnerClient, consommerJetonPaquet, journaliser } from "@/lib/genapi/provisionnement";

/** Réinitialise l'état Firestore factice avant chaque test. */
beforeEach(() => {
  etat.docs.clear();
  etat.ops.length = 0;
  etat.cheminsCle.length = 0;
});

/** Répertoires genapi-prov-* encore présents dans le tmpdir système. */
function tmpdirsGenapiRestants(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("genapi-prov-")).map((n) => path.join(tmpdir(), n));
}

describe("provisionnerClient — pipeline nominal", () => {
  it("provisionnement complet : empreinte stockée, jeton émis, clé privée RÉELLEMENT détruite", async () => {
    const resultat = await provisionnerClient({ uid: "u-genapi-1", email: "client@saas.fr" });

    expect(resultat.ok).toBe(true);
    expect(resultat.empreinte).toBe(EMPREINTE);
    expect(resultat.jetonTelechargement).toMatch(/^[A-Za-z0-9_-]{40,50}$/);
    expect(resultat.expireA).toBeTruthy();

    // Firestore genapiClients/{uid} : empreinte SEULE, statut actif — et
    // AUCUN matériel de clé privée dans le document.
    const docClient = etat.docs.get("genapiClients/u-genapi-1");
    expect(docClient).toBeDefined();
    expect(docClient?.empreinte).toBe(EMPREINTE);
    expect(docClient?.statut).toBe("actif");
    expect(docClient?.email).toBe("client@saas.fr");
    const jsonClient = JSON.stringify(docClient);
    expect(jsonClient).not.toContain("MATERIEL-SECRET-DE-TEST");
    expect(jsonClient).not.toContain("BEGIN CLE");

    // genapiPackages/{hashJeton} : paquet base64 TTL 15 min, non consommé.
    const docsPaquets = [...etat.docs.entries()].filter(([chemin]) => chemin.startsWith("genapiPackages/"));
    expect(docsPaquets).toHaveLength(1);
    const [, docPaquet] = docsPaquets[0]!;
    expect(docPaquet.consommeA).toBeNull();
    expect(docPaquet.expireA).toBeTruthy();
    expect(typeof docPaquet.paquetBase64).toBe("string");
    expect((docPaquet.paquetBase64 as string).length).toBeGreaterThan(0);

    // ZÉRO FUITE prouvé par le disque : la clé écrite par le mock openssl
    // (fichier RÉEL) n'existe plus, et aucun tmpdir genapi-prov-* ne reste.
    expect(etat.cheminsCle).toHaveLength(1);
    expect(existsSync(etat.cheminsCle[0]!)).toBe(false);
    expect(tmpdirsGenapiRestants()).toEqual([]);

    // Journal d'audit : destruction + provisionnement OK.
    const evenements = etat.ops.filter((op) => op.kind === "add").map((op) => (op.payload as { evenement: string }).evenement);
    expect(evenements).toContain("cle_privee_detruite");
    expect(evenements).toContain("provisionnement_ok");
  });

  it("le paquet livré contient les 4 fichiers attendus (proto, clé, certificat, LISEZMOI)", async () => {
    const resultat = await provisionnerClient({ uid: "u-genapi-2", email: "paquet@saas.fr" });
    expect(resultat.ok).toBe(true);

    const docsPaquets = [...etat.docs.entries()].filter(([chemin]) => chemin.startsWith("genapiPackages/"));
    const docPaquet = docsPaquets[0]![1];
    const extraits = extrairePaquet(Buffer.from(docPaquet.paquetBase64 as string, "base64"));
    const noms = extraits.map((f) => f.nom).sort();
    expect(noms).toEqual(["LISEZMOI.md", "client.crt", "client.key", "gen3.proto"]);

    // Le LISEZMOI embarqué mentionne la connexion mTLS et la facturation.
    const lisezmoi = extraits.find((f) => f.nom === "LISEZMOI.md")!.contenu.toString("utf8");
    expect(lisezmoi).toContain("x-gen3-empreinte");
    expect(lisezmoi).toContain("crédits Chariow");
    expect(lisezmoi).toContain("NE PARTAGEZ JAMAIS CE FICHIER");

    // Le contrat gen3.proto livré est le VRAI fichier du dépôt.
    const proto = extraits.find((f) => f.nom === "gen3.proto")!.contenu.toString("utf8");
    expect(proto).toContain("package gen3.v1;");
    expect(proto).toContain("rpc ExecuterInference");
  });
});

describe("provisionnerClient — refus propres (aucune ressource gaspillée)", () => {
  it("CA racine absente → erreur explicite, AUCUNE clé générée, aucun doc Firestore", async () => {
    const openssl = await import("@/lib/genapi/openssl");
    vi.mocked(openssl.caDisponible).mockResolvedValueOnce(false);

    const resultat = await provisionnerClient({ uid: "u-genapi-3", email: "sans-ca@saas.fr" });

    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("CA racine gen3 indisponible");
    expect(resultat.jetonTelechargement).toBeUndefined();
    expect(vi.mocked(openssl.genererClePriveeClient).mock.calls).toHaveLength(0);
    expect([...etat.docs.keys()].filter((k) => k.startsWith("genapiClients/"))).toEqual([]);
  });

  it("uid invalide (avec « / ») → erreur propre AVANT tout accès au terminal", async () => {
    const openssl = await import("@/lib/genapi/openssl");

    const resultat = await provisionnerClient({ uid: "../evasion", email: "pirate@saas.fr" });

    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("uid client invalide");
    expect(vi.mocked(openssl.genererClePriveeClient).mock.calls).toHaveLength(0);
    expect([...etat.docs.keys()].filter((k) => k.startsWith("genapiClients/") || k.startsWith("genapiPackages/"))).toEqual([]);
  });

  it("email invalide (sans @) → erreur propre", async () => {
    const resultat = await provisionnerClient({ uid: "u-genapi-4", email: "email-invalide" });
    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("email client invalide");
  });

  it("incident en cours de pipeline → journal provisionnement_ko, ok:false, jamais d'exception", async () => {
    const openssl = await import("@/lib/genapi/openssl");
    vi.mocked(openssl.extraireEmpreinte).mockRejectedValueOnce(new Error("openssl : fichier introuvable"));

    const resultat = await provisionnerClient({ uid: "u-genapi-5", email: "incident@saas.fr" });

    expect(resultat.ok).toBe(false);
    expect(resultat.erreur).toContain("openssl");
    expect(resultat.erreur.length).toBeLessThanOrEqual(301);
    const evenements = etat.ops.filter((op) => op.kind === "add").map((op) => (op.payload as { evenement: string }).evenement);
    expect(evenements).toContain("provisionnement_ko");
    // Le tmpdir est nettoyé même en cas d'incident (finally du pipeline).
    expect(tmpdirsGenapiRestants()).toEqual([]);
  });
});

describe("consommerJetonPaquet — usage unique atomique", () => {
  it("1ʳᵉ consommation → paquet Buffer ; 2ᵉ → refus « déjà utilisé » + paquetBase64 écrasé", async () => {
    const resultat = await provisionnerClient({ uid: "u-genapi-6", email: "jeton@saas.fr" });
    expect(resultat.ok).toBe(true);
    const jeton = resultat.jetonTelechargement!;

    const premiere = await consommerJetonPaquet(jeton);
    expect(premiere.ok).toBe(true);
    expect(premiere.uid).toBe("u-genapi-6");
    expect(premiere.paquet).toBeInstanceOf(Buffer);
    expect(premiere.paquet!.length).toBeGreaterThan(0);
    expect(extrairePaquet(premiere.paquet!).map((f) => f.nom)).toContain("client.key");

    // Après consommation : le doc d'audit reste mais paquetBase64 = "".
    const hashJeton = (await import("node:crypto")).createHash("sha256").update(jeton).digest("hex");
    const docPaquet = etat.docs.get(`genapiPackages/${hashJeton}`);
    expect(docPaquet?.consommeA).toBeTruthy();
    expect(docPaquet?.paquetBase64).toBe("");

    const seconde = await consommerJetonPaquet(jeton);
    expect(seconde.ok).toBe(false);
    expect(seconde.erreur).toContain("déjà utilisé");
    expect(seconde.paquet).toBeUndefined();
  });

  it("jeton inconnu → refus « introuvable »", async () => {
    const refus = await consommerJetonPaquet("jeton-completement-inconnu");
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toContain("introuvable");
  });

  it("paquet expiré → refus « expiré »", async () => {
    const resultat = await provisionnerClient({ uid: "u-genapi-7", email: "expire@saas.fr" });
    expect(resultat.ok).toBe(true);
    const hashJeton = (await import("node:crypto"))
      .createHash("sha256")
      .update(resultat.jetonTelechargement!)
      .digest("hex");
    // Simule un paquet dont le TTL (15 min) est dépassé.
    etat.docs.set(`genapiPackages/${hashJeton}`, {
      ...(etat.docs.get(`genapiPackages/${hashJeton}`) ?? {}),
      expireA: new Date(Date.now() - 60_000).toISOString(),
    });

    const refus = await consommerJetonPaquet(resultat.jetonTelechargement!);
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toContain("expiré");
  });

  it("jeton vide → refus immédiat", async () => {
    const refus = await consommerJetonPaquet("");
    expect(refus.ok).toBe(false);
    expect(refus.erreur).toContain("manquant");
  });
});

describe("journaliser — écriture best-effort", () => {
  it("ajoute une entrée horodatée (evenement, detail, a ISO)", async () => {
    await journaliser("evenement_test", "détail du test genAPI");
    const ajouts = etat.ops.filter((op) => op.kind === "add");
    expect(ajouts).toHaveLength(1);
    const payload = ajouts[0]!.payload as { evenement: string; detail: string; a: string };
    expect(payload.evenement).toBe("evenement_test");
    expect(payload.detail).toBe("détail du test genAPI");
    expect(new Date(payload.a).toISOString()).toBe(payload.a);
  });

  it("une panne du support de journal n'est JAMAIS propagée (catch silencieux)", async () => {
    const administration = await import("@/lib/firebase/admin");
    vi.spyOn(administration.adminDb, "collection").mockImplementationOnce(() => {
      throw new Error("Firestore sous quota.");
    });
    await expect(journaliser("panne", "le journal est un confort, pas un chemin critique")).resolves.toBeUndefined();
  });
});

// Vérification de sécurité finale : aucun répertoire de provisionnement
// résiduel après TOUTE la suite (garde transversale zéro fuite).
describe("garde transversale — zéro fuite", () => {
  it("aucun tmpdir genapi-prov-* ne survit à la suite", () => {
    const restants = tmpdirsGenapiRestants();
    for (const restant of restants) rmSync(restant, { recursive: true, force: true });
    expect(restants).toEqual([]);
  });
});
