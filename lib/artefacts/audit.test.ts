import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * AUDIT D'ARTEFACTS (Task 5-a) — tests d'intégration sur la CHAÎNE RÉELLE :
 *
 *  - client R2 simulé EN MÉMOIRE (même pattern que lib/r2fs/r2fs.test.ts :
 *    ETag + préconditions If-Match / If-None-Match, NoSuchKey sur clé absente,
 *    listage par préfixe trié) — le moteur r2fs (base), le magasin utilisateur
 *    (user-data-store), le dépôt chat, le dépôt conversationArtifacts et le
 *    stockage permanent s'exécutent donc RÉELLEMENT au-dessus de ce mock ;
 *  - miroir vectoriel chat simulé (jamais de réseau).
 *
 * Verrous testés : listing multi-conversations + origine, barrière de
 * propriété stricte (B ne voit RIEN de A), modification → NOUVELLE version +
 * historique conservé (aucun écrasement), renommage, note seule, erreurs
 * honnêtes (introuvable / accès refusé / modification non supportée).
 */

const r2State = vi.hoisted(() => ({
  objets: new Map<string, { body: Buffer; etag: string; contentType: string }>(),
  etagCompteur: 0,
}));

vi.mock("@/lib/storage/r2", () => {
  function erreurAbsente(): Error {
    // Forme réelle du SDK S3 v3 : name = "NoSuchKey" (+ $metadata 404).
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
      // Contrat du client réel : précondition échouée → null (PAS d'exception).
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

import { indexConversationMessage } from "@/lib/chat/vector-index";
import {
  appendMessage,
  createConversation,
} from "@/lib/chat/repository";
import { createArtifact, listArtifacts } from "@/lib/domain/artifacts/repository";
import { persistImportedFile } from "@/lib/files/import";
import { storePermanentFile } from "@/lib/storage/permanent-user-storage";
import {
  listerArtefacts,
  lireArtefact,
  modifierArtefact,
} from "./audit";
import { listerVersions } from "./versions";

const UA = "user-a";
const UB = "user-b";

/** Sème un fichier dans le stockage PERMANENT réel (via storePermanentFile). */
async function semerPermanent(nom: string, contenu: string, contentType = "text/plain"): Promise<string> {
  const upload = await storePermanentFile({ userId: UA, filename: nom, content: Buffer.from(contenu, "utf8"), contentType });
  return upload.path;
}

/** Convertit une clé en URL média durable (handle canonique des messages). */
function urlDurable(cle: string): string {
  return `/api/media/durable?path=${encodeURIComponent(cle)}`;
}

beforeEach(() => {
  r2State.objets.clear();
  r2State.etagCompteur = 0;
  vi.mocked(indexConversationMessage).mockClear();
});

/* ------------------------------------------------------------------ */
/* Listing multi-conversations                                         */
/* ------------------------------------------------------------------ */

describe("listerArtefacts — multi-conversations, origine, rattachement", () => {
  it("agrège imports utilisateur, médias gen3 et projet vidéo avec leur conversation", async () => {
    const cleCsv = await semerPermanent("ventes.csv", "mois;montant\njanvier;100\n", "text/csv");
    const cleImage = await semerPermanent("affiche.png", "PNG", "image/png");
    const cleImage2 = `users/${UA}/permanent/ai-images/${Date.now()}-gen.png`;
    r2State.objets.set(cleImage2, { body: Buffer.from("PNG2"), etag: '"w0"', contentType: "image/png" });
    const cleAudio = `users/${UA}/permanent/ai-audio/${Date.now()}-voix.mp3`;
    r2State.objets.set(cleAudio, { body: Buffer.from("MP3"), etag: '"w0"', contentType: "audio/mpeg" });

    const conv1 = await createConversation(UA, "Rapport trimestriel");
    await appendMessage({
      conversationId: conv1.id,
      userId: UA,
      role: "user",
      content: "Voici les ventes du trimestre",
      attachments: [{ filename: "ventes.csv", contentType: "text/csv", path: cleCsv }],
    });
    await appendMessage({
      conversationId: conv1.id,
      userId: UA,
      role: "assistant",
      content: "Voici l'affiche et la voix off générées",
      imageUrl: urlDurable(cleImage),
      audioUrl: urlDurable(cleAudio),
    });

    const conv2 = await createConversation(UA, "Production vidéo");
    await appendMessage({
      conversationId: conv2.id,
      userId: UA,
      role: "assistant",
      content: "La vidéo est en production",
      videoProjectId: "proj-video-1",
    });

    const listing = await listerArtefacts(UA);
    expect(listing.erreurs).toEqual([]);
    expect(listing.tronque).toBe(false);
    expect(listing.total).toBe(listing.artefacts.length);

    const parId = new Map(listing.artefacts.map((a) => [a.id, a]));

    // Import utilisateur : rattaché à SA conversation, origine utilisateur.
    const csv = parId.get(cleCsv);
    expect(csv).toBeDefined();
    expect(csv!.origine).toBe("utilisateur");
    expect(csv!.type).toBe("document");
    expect(csv!.conversationId).toBe(conv1.id);
    expect(csv!.conversationTitre).toBe("Rapport trimestriel");
    expect(csv!.version).toBe(1);

    // Images et audio générés par gen3 (même celles sans message : ai-images/).
    const image = parId.get(cleImage)!;
    expect(image.origine).toBe("gen3");
    expect(image.type).toBe("image");
    expect(image.conversationTitre).toBe("Rapport trimestriel");
    expect(parId.get(cleImage2)!.origine).toBe("gen3");
    const audio = parId.get(cleAudio)!;
    expect(audio.type).toBe("audio");
    expect(audio.origine).toBe("gen3");

    // Projet vidéo produit depuis la conversation (id vp:).
    const video = parId.get("vp:proj-video-1")!;
    expect(video).toBeDefined();
    expect(video.type).toBe("video");
    expect(video.origine).toBe("gen3");
    expect(video.conversationId).toBe(conv2.id);
    expect(video.cleStockage).toBe(`users/${UA}/video/proj-video-1/`);
  });

  it("filtres type/origine/conversation/recherche + pagination honnête", async () => {
    const cleCsv = await semerPermanent("ventes.csv", "a;b\n1;2\n", "text/csv");
    const cleImage = await semerPermanent("logo.png", "PNG", "image/png");
    const conv = await createConversation(UA, "Design");
    await appendMessage({
      conversationId: conv.id,
      userId: UA,
      role: "user",
      content: "Le logo",
      attachments: [{ filename: "logo.png", contentType: "image/png", path: cleImage }],
    });

    const images = await listerArtefacts(UA, { type: "image" });
    expect(images.artefacts.map((a) => a.id)).toEqual([cleImage]);

    const imports = await listerArtefacts(UA, { origine: "utilisateur" });
    expect(imports.artefacts.map((a) => a.id)).toContain(cleCsv);

    const dansConv = await listerArtefacts(UA, { conversationId: conv.id });
    expect(dansConv.artefacts.map((a) => a.id)).toEqual([cleImage]);

    const recherche = await listerArtefacts(UA, { recherche: "VENTES" });
    expect(recherche.artefacts.map((a) => a.id)).toEqual([cleCsv]);

    const pagine = await listerArtefacts(UA, { limite: 1, offset: 1 });
    expect(pagine.total).toBe(2);
    expect(pagine.artefacts).toHaveLength(1);
  });

  it("collecte les erreurs PAR SOURCE sans masquer les autres (honnêteté)", async () => {
    await semerPermanent("f.txt", "contenu", "text/plain");
    // Un pointeur du registre ILLISIBLE (JSON corrompu) fait échouer la source
    // « registre » — les autres sources continuent : le fichier permanent
    // reste listé et l'incident est signalé dans `erreurs`.
    r2State.objets.set(`users/${UA}/artefacts/corrompu.json`, {
      body: Buffer.from("{{{ pas du json"),
      etag: '"w0"',
      contentType: "application/json",
    });
    const listing = await listerArtefacts(UA);
    expect(listing.erreurs.some((e) => e.source === "registre" && e.message.length > 0)).toBe(true);
    expect(listing.artefacts.some((a) => a.nom === "f.txt")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Barrière de propriété                                               */
/* ------------------------------------------------------------------ */

describe("barrière de propriété — l'utilisateur B ne voit RIEN de A", () => {
  it("listing vide pour B alors que A a des artefacts", async () => {
    const cleCsv = await semerPermanent("secret-a.csv", "confidentiel", "text/csv");
    const conv = await createConversation(UA, "Privé A");
    await appendMessage({
      conversationId: conv.id,
      userId: UA,
      role: "user",
      content: "fichier privé",
      attachments: [{ filename: "secret-a.csv", contentType: "text/csv", path: cleCsv }],
    });
    await createArtifact({ userId: UA, type: "code", title: "Code de A", content: "const a = 1;" });

    const listingB = await listerArtefacts(UB);
    expect(listingB.artefacts).toEqual([]);
    expect(listingB.total).toBe(0);
    expect(listingB.tronque).toBe(false);
  });

  it("lecture et modification d'une clé de A par B refusées (barrière stricte)", async () => {
    const cle = await semerPermanent("prive.txt", "secret", "text/plain");
    await expect(lireArtefact(UB, cle)).rejects.toThrow(/Accès refusé/);
    await expect(modifierArtefact(UB, cle, { nouveauContenu: "pirate" })).rejects.toThrow(/Accès refusé/);
    // Clé d'un AUTRE utilisateur jamais listable par B, même en filtre direct.
    const listingB = await listerArtefacts(UB, { recherche: "prive" });
    expect(listingB.artefacts).toEqual([]);
  });

  it("l'artefact du registre de A est introuvable pour B", async () => {
    const cle = await semerPermanent("rapport.md", "v1", "text/markdown");
    const res = await modifierArtefact(UA, cle, { nouveauContenu: "v2" });
    await expect(lireArtefact(UB, res.id)).rejects.toThrow(/introuvable/);
  });
});

/* ------------------------------------------------------------------ */
/* Lire                                                                */
/* ------------------------------------------------------------------ */

describe("lireArtefact — contenu converti ou URL signée selon le type", () => {
  it("document : texte converti réel (CSV)", async () => {
    const cleCsv = await semerPermanent("ventes.csv", "mois;montant\njanvier;100\n", "text/csv");
    const lecture = await lireArtefact(UA, cleCsv);
    expect(lecture.type).toBe("document");
    expect(lecture.conversion).toBe("full");
    expect(lecture.contenu).toContain("janvier");
    expect(lecture.tailleOctets).toBeGreaterThan(0);
    expect(lecture.origine).toBe("utilisateur");
  });

  it("média : URL signée courte durée, jamais de contenu binaire", async () => {
    const cleImage = await semerPermanent("photo.png", "PNGDATA", "image/png");
    const lecture = await lireArtefact(UA, cleImage);
    expect(lecture.type).toBe("image");
    expect(lecture.urlTelechargement).toMatch(/^https:\/\/r2\.test\//);
    expect(lecture.contenu).toBeUndefined();
    expect(lecture.conversion).toBe("metadata-only");
  });

  it("clé hors du stockage du propriétaire : refus explicite", async () => {
    await expect(lireArtefact(UA, `users/${UB}/permanent/f.txt`)).rejects.toThrow(/Accès refusé/);
  });

  it("clé permanente absente : échec honnête", async () => {
    await expect(lireArtefact(UA, `users/${UA}/permanent/absente.txt`)).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Modifier — nouvelle version + historique                            */
/* ------------------------------------------------------------------ */

describe("modifierArtefact — trace de versions sans écrasement", () => {
  it("remplacement de contenu : nouvelle clé, v1 conservée, pointeur v2", async () => {
    const cleOriginale = await semerPermanent("rapport.md", "contenu v1", "text/markdown");
    const res = await modifierArtefact(UA, cleOriginale, { nouveauContenu: "contenu v2 corrigé", note: "correction typo" });

    expect(res.id).toMatch(/^ar:/);
    expect(res.version).toBe(2);
    expect(res.raison).toBe("contenu");
    expect(res.ancienneCle).toBe(cleOriginale);
    expect(res.cleStockage).not.toBe(cleOriginale);
    expect(res.historique).toBe(2);

    // L'objet d'origine n'est JAMAIS écrasé : v1 et v2 coexistent en R2.
    expect(r2State.objets.get(cleOriginale)!.body.toString("utf8")).toBe("contenu v1");
    expect(r2State.objets.get(res.cleStockage!)!.body.toString("utf8")).toBe("contenu v2 corrigé");

    // Historique listable : v2 (contenu, note) puis v1 (origine).
    const artId = res.id.slice("ar:".length);
    const versions = await listerVersions(UA, artId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0].raison).toBe("contenu");
    expect(versions[0].note).toBe("correction typo");
    expect(versions[1].raison).toBe("origine");
    expect(versions[1].cleStockage).toBe(cleOriginale);

    // Listing : l'entrée registre (version 2) remplace la clé brute — pas de doublon.
    const listing = await listerArtefacts(UA);
    const ids = listing.artefacts.map((a) => a.id);
    expect(ids).toContain(res.id);
    expect(ids).not.toContain(cleOriginale);
    const entree = listing.artefacts.find((a) => a.id === res.id)!;
    expect(entree.version).toBe(2);
    expect(entree.nom).toBe("rapport.md");

    // Lecture via l'identifiant registre : contenu COURANT.
    const lecture = await lireArtefact(UA, res.id);
    expect(lecture.contenu).toBe("contenu v2 corrigé");
    expect(lecture.version).toBe(2);
  });

  it("renommage : nouvelle version, clé de stockage inchangée", async () => {
    const cle = await semerPermanent("brouillon.txt", "texte", "text/plain");
    const premier = await modifierArtefact(UA, cle, { nouveauContenu: "texte v2" });
    const second = await modifierArtefact(UA, premier.id, { nouveauNom: "final.txt", note: "titre final" });

    expect(second.version).toBe(3);
    expect(second.raison).toBe("renommer");
    expect(second.nom).toBe("final.txt");
    expect(second.cleStockage).toBe(premier.cleStockage);
    expect(second.historique).toBe(3);
  });

  it("note seule : métadonnée du pointeur, SANS nouvelle version", async () => {
    const cle = await semerPermanent("notes.txt", "contenu", "text/plain");
    const modifie = await modifierArtefact(UA, cle, { nouveauContenu: "contenu v2" });
    const note = await modifierArtefact(UA, modifie.id, { note: "vérifié par gen3" });
    expect(note.version).toBe(2);
    expect(note.note).toBe("vérifié par gen3");
    expect(note.historique).toBe(2);
  });

  it("erreurs honnêtes : médias non réécrits, modification vide, identifiants inconnus", async () => {
    const cleImage = await semerPermanent("photo.png", "PNG", "image/png");
    await expect(modifierArtefact(UA, cleImage, { nouveauContenu: "texte" }))
      .rejects.toThrow(/remplacement de contenu n'est supporté/);
    await expect(modifierArtefact(UA, cleImage, {})).rejects.toThrow(/Modification vide/);
    await expect(lireArtefact(UA, "ar:ZZZZINCONNU")).rejects.toThrow(/introuvable/);
    await expect(lireArtefact(UA, "ca:inconnu-123")).rejects.toThrow(/introuvable/);
    await expect(modifierArtefact(UA, "if:abc", { nouveauContenu: "x" }))
      .rejects.toThrow(/Modification non supportée/);
    await expect(modifierArtefact(UA, `users/${UB}/permanent/x.txt`, { nouveauContenu: "x" }))
      .rejects.toThrow(/Accès refusé/);
  });
});

/* ------------------------------------------------------------------ */
/* Artefacts de conversation (`ca:`) et imports (`if:`)                */
/* ------------------------------------------------------------------ */

describe("intégration dépôts existants — conversationArtifacts et importedFiles", () => {
  it("artefact de conversation listé, lu et versionné via addArtifactVersion", async () => {
    const conv = await createConversation(UA, "Automatisation");
    const cree = await createArtifact({
      userId: UA,
      type: "code",
      title: "Script de calcul",
      content: "const total = 1;",
      conversationId: conv.id,
    });

    const listing = await listerArtefacts(UA, { type: "code" });
    const entree = listing.artefacts.find((a) => a.id === `ca:${cree.id}`);
    expect(entree).toBeDefined();
    expect(entree!.origine).toBe("gen3");
    expect(entree!.conversationId).toBe(conv.id);
    expect(entree!.version).toBe(1);

    const modifie = await modifierArtefact(UA, `ca:${cree.id}`, { nouveauContenu: "const total = 2;", note: "fix" });
    expect(modifie.version).toBe(2);
    expect(modifie.historique).toBe(2);

    const lecture = await lireArtefact(UA, `ca:${cree.id}`);
    expect(lecture.contenu).toBe("const total = 2;");
    expect(lecture.version).toBe(2);

    // L'historique du dépôt existant reste conservé.
    const apres = await listArtifacts(UA, { limit: 10 });
    const artefact = apres.find((a) => a.id === cree.id)!;
    expect(artefact.versions).toHaveLength(2);
  });

  it("fichier importé sans binaire permanent : listé et lisible via son texte converti", async () => {
    const enregistre = await persistImportedFile({
      userId: UA,
      permanentDescriptor: { path: `users/${UA}/permanent/manuel.pdf`, filename: "manuel.pdf", contentType: "application/pdf", sizeBytes: 1234 },
      conversion: { kind: "pdf", text: "Contenu du manuel converti", conversion: "full" },
    });

    const listing = await listerArtefacts(UA);
    const entree = listing.artefacts.find((a) => a.id === `if:${enregistre.id}`);
    expect(entree).toBeDefined();
    expect(entree!.nom).toBe("manuel.pdf");
    expect(entree!.origine).toBe("utilisateur");
    expect(entree!.cleStockage).toBeNull();

    const lecture = await lireArtefact(UA, `if:${enregistre.id}`);
    expect(lecture.contenu).toBe("Contenu du manuel converti");
    expect(lecture.conversion).toBe("full");

    // Barrière : B ne lit pas l'import de A (indiscernable d'un absent).
    await expect(lireArtefact(UB, `if:${enregistre.id}`)).rejects.toThrow(/introuvable/);
  });
});
