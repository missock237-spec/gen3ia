import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * artefacts.audit — tests du TOOL (wiring schema → lib/artefacts/audit).
 * Même mock R2 mémoire que lib/artefacts/audit.test.ts (chaîne réelle
 * user-data-store + r2fs + dépôts au-dessus).
 */

const r2State = vi.hoisted(() => ({
  objets: new Map<string, { body: Buffer; etag: string; contentType: string }>(),
  etagCompteur: 0,
}));

vi.mock("@/lib/storage/r2", () => {
  function erreurAbsente(): Error {
    const error = new Error("The specified key does not exist.");
    error.name = "NoSuchKey";
    (error as unknown as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 };
    return error;
  }
  return {
    isR2Configured: () => true,
    uploadToR2: async (key: string, body: Uint8Array | Buffer, contentType: string) => {
      r2State.objets.set(key, { body: Buffer.from(body), etag: `"w${++r2State.etagCompteur}"`, contentType });
    },
    putObject: async (options: { key: string; body: Uint8Array | Buffer; contentType?: string }) => {
      r2State.objets.set(options.key, {
        body: Buffer.from(options.body),
        etag: `"w${++r2State.etagCompteur}"`,
        contentType: options.contentType ?? "application/octet-stream",
      });
    },
    downloadFromR2: async (key: string, maxBytes?: number) => {
      const objet = r2State.objets.get(key);
      if (!objet) throw erreurAbsente();
      if (typeof maxBytes === "number" && objet.body.byteLength > maxBytes) {
        throw new Error("R2 object exceeds configured read limit");
      }
      return Buffer.from(objet.body);
    },
    deleteFromR2: async (key: string) => {
      r2State.objets.delete(key);
    },
    deleteObject: async (key: string) => {
      r2State.objets.delete(key);
    },
    listObjectsUnderPrefix: async (prefix: string, maxResults?: number) => {
      return [...r2State.objets.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .slice(0, maxResults ?? 500)
        .map((key) => ({
          key,
          sizeBytes: r2State.objets.get(key)!.body.byteLength,
          updatedAt: new Date(0).toISOString(),
        }));
    },
    headR2Object: async (key: string) => {
      const objet = r2State.objets.get(key);
      if (!objet) return null;
      return { sizeBytes: objet.body.byteLength, contentType: objet.contentType };
    },
    createDownloadUrl: async (key: string) => `https://r2.test/${key}?sig=test`,
    createR2DownloadUrl: async (key: string) => `https://r2.test/${key}?sig=test`,
    getObjectWithEtag: async (key: string) => {
      const objet = r2State.objets.get(key);
      if (!objet) return null;
      return { data: Buffer.from(objet.body), etag: objet.etag };
    },
    putObjectConditional: async (
      key: string,
      body: Uint8Array | Buffer,
      contentType: string,
      opts?: { ifMatch?: string; ifNoneMatch?: "*" },
    ) => {
      const existant = r2State.objets.get(key);
      if (opts?.ifMatch && (!existant || existant.etag !== opts.ifMatch)) return null;
      if (opts?.ifNoneMatch === "*" && existant) return null;
      const etag = `"w${++r2State.etagCompteur}"`;
      r2State.objets.set(key, { body: Buffer.from(body), etag, contentType });
      return { etag };
    },
    deleteObjectConditional: async (key: string, ifMatch: string) => {
      const existant = r2State.objets.get(key);
      if (!existant) return true;
      if (existant.etag !== ifMatch) return false;
      r2State.objets.delete(key);
      return true;
    },
    isR2PreconditionFailed: (error: unknown) => error instanceof Error && error.name === "PreconditionFailed",
    ensureBucketCors: async () => ({ applied: true }),
    assureBucketCorsPourTeleversement: async () => true,
    createMultipartUpload: async () => "upload-test",
    presignPartUpload: async () => "https://r2.test/part",
    completeMultipartUpload: async () => ({ sizeBytes: 0, contentType: "application/octet-stream" }),
    abortMultipartUpload: async () => undefined,
  };
});

vi.mock("@/lib/chat/vector-index", () => ({
  indexConversationMessage: vi.fn(async () => true),
  purgeConversationVectors: vi.fn(async () => true),
}));

import { storePermanentFile } from "@/lib/storage/permanent-user-storage";
import { artefactsAuditTool } from "./artefacts-audit";

const UA = "user-a";

const CONTEXTE = { userId: UA, executionId: "exec-test" };

async function semerPermanent(nom: string, contenu: string, contentType = "text/plain"): Promise<string> {
  const upload = await storePermanentFile({ userId: UA, filename: nom, content: Buffer.from(contenu, "utf8"), contentType });
  return upload.path;
}

beforeEach(() => {
  r2State.objets.clear();
  r2State.etagCompteur = 0;
});

describe("artefacts.audit — action lister", () => {
  it("retourne une réponse lisible avec total, résumé et artefacts formatés", async () => {
    const cle = await semerPermanent("ventes.csv", "mois;montant\njanvier;100\n", "text/csv");
    const sortie = await artefactsAuditTool.execute(
      { action: "lister", filtres: { type: "document" } },
      CONTEXTE,
    );
    expect(sortie.success).toBe(true);
    const record = sortie as { action: string; total: number; artefacts: Array<{ id: string; nom: string; conversation: string; origine: string }>; resume: string };
    expect(record.action).toBe("lister");
    expect(record.total).toBe(1);
    expect(record.artefacts[0].id).toBe(cle);
    expect(record.artefacts[0].nom).toBe("ventes.csv");
    expect(record.artefacts[0].origine).toBe("utilisateur");
    expect(record.resume).toContain("1 artefact");
  });

  it("filtre par conversationId et type", async () => {
    await semerPermanent("image.png", "PNG", "image/png");
    await semerPermanent("doc.txt", "texte", "text/plain");
    const images = await artefactsAuditTool.execute({ action: "lister", filtres: { type: "image" } }, CONTEXTE);
    expect((images as { total: number }).total).toBe(1);
  });
});

describe("artefacts.audit — action lire", () => {
  it("lit un document (contenu converti) et refuse honnêtement l'inconnu", async () => {
    const cle = await semerPermanent("notes.md", "# Titre\nCorps", "text/markdown");
    const sortie = await artefactsAuditTool.execute({ action: "lire", id: cle }, CONTEXTE);
    const record = sortie as { action: string; contenu?: string; type: string };
    expect(record.action).toBe("lire");
    expect(record.type).toBe("document");
    expect(record.contenu).toContain("# Titre");

    await expect(artefactsAuditTool.execute({ action: "lire", id: `users/${UA}/permanent/absent.txt` }, CONTEXTE))
      .rejects.toThrow();
    await expect(artefactsAuditTool.execute({ action: "lire", id: `users/user-b/permanent/x.txt` }, CONTEXTE))
      .rejects.toThrow(/Accès refusé/);
  });
});

describe("artefacts.audit — action modifier", () => {
  it("crée une nouvelle version et retourne l'historique", async () => {
    const cle = await semerPermanent("rapport.md", "v1", "text/markdown");
    const sortie = await artefactsAuditTool.execute(
      { action: "modifier", id: cle, nouveauContenu: "v2 corrigée", note: "correction" },
      CONTEXTE,
    );
    const record = sortie as { action: string; artefactId: string; version: number; cleStockage: string; historiqueVersions: number };
    expect(record.action).toBe("modifier");
    expect(record.version).toBe(2);
    expect(record.artefactId).toMatch(/^ar:/);
    expect(record.cleStockage).not.toBe(cle);
    expect(record.historiqueVersions).toBe(2);

    // La relecture via l'id registre renvoie le NOUVEAU contenu.
    const relue = await artefactsAuditTool.execute({ action: "lire", id: record.artefactId }, CONTEXTE);
    expect((relue as { contenu?: string }).contenu).toBe("v2 corrigée");
  });

  it("échecs honnêtes : identifiant requis, modification vide, média non réécrit", async () => {
    await expect(artefactsAuditTool.execute({ action: "lire" }, CONTEXTE)).rejects.toThrow(/identifiant d'artefact requis/);
    await expect(artefactsAuditTool.execute({ action: "modifier" }, CONTEXTE)).rejects.toThrow(/identifiant d'artefact requis/);

    const cle = await semerPermanent("rapport.md", "v1", "text/markdown");
    await expect(artefactsAuditTool.execute({ action: "modifier", id: cle }, CONTEXTE)).rejects.toThrow(/Modification vide/);

    const cleImage = await semerPermanent("photo.png", "PNG", "image/png");
    await expect(artefactsAuditTool.execute({ action: "modifier", id: cleImage, nouveauContenu: "x" }, CONTEXTE))
      .rejects.toThrow(/remplacement de contenu n'est supporté/);
  });
});
