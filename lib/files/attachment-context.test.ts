import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2: vi.fn(),
  isR2Configured: vi.fn(() => true),
  uploadToR2: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({ adminDb: {} }));

import { downloadFromR2 } from "@/lib/storage/r2";
import { loadAgentAttachmentsContext } from "./attachment-context";

const mockedDownload = vi.mocked(downloadFromR2);

const USER = "user-1";
const PREFIX = `users/${USER}/permanent/`;

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * CONTEXTE RÉEL DES PIÈCES JOINTES DU CHAT D'AGENT (exigence production) :
 * le contenu est extrait et injecté — l'agent ne reçoit plus seulement des
 * noms de fichiers. Cloisonnement strict : seule la clé permanente du
 * propriétaire est lisible.
 */
describe("loadAgentAttachmentsContext", () => {
  it("note vide sans pièce jointe", async () => {
    const result = await loadAgentAttachmentsContext(USER, []);
    expect(result.note).toBe("");
    expect(result.files).toEqual([]);
  });

  it("refuse un chemin R2 hors du stockage permanent du propriétaire (cloisonnement)", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("secret") as never);
    const result = await loadAgentAttachmentsContext(USER, [{ path: "users/autre-utilisateur/permanent/f.txt", name: "f.txt" }]);
    expect(mockedDownload).not.toHaveBeenCalled();
    expect(result.files[0]?.error).toBeTruthy();
    expect(result.note).toContain("f.txt");
  });

  it("extrait le contenu réel d'un fichier texte du stockage permanent", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("Contenu réel du rapport annuel.") as never);
    const result = await loadAgentAttachmentsContext(USER, [{ path: `${PREFIX}rapport.txt`, name: "rapport.txt", contentType: "text/plain" }]);
    expect(result.files[0]).toMatchObject({ kind: "text", conversion: "full", charCount: 31 });
    expect(result.note).toContain("1 fichiers joints");
    expect(result.note).toContain("rapport.txt");
    expect(result.note).toContain("Contenu réel du rapport annuel.");
    // L'agent garde un accès à la demande au fichier complet.
    expect(result.note).not.toContain("non lue");
  });

  it("mentionne file.read pour une pièce jointe non lue (fail-soft)", async () => {
    mockedDownload.mockRejectedValue(new Error("R2 indisponible") as never);
    const result = await loadAgentAttachmentsContext(USER, [{ path: `${PREFIX}doc.pdf`, name: "doc.pdf" }]);
    expect(result.files[0]?.error).toBeTruthy();
    expect(result.note).toContain("doc.pdf");
    expect(result.note).toContain("file.read");
  });

  it("plafonne le budget total du bloc de contexte (10 fichiers × 50 Mo → 60k caractères)", async () => {
    const big = "x".repeat(20_000);
    mockedDownload.mockImplementation(() => Promise.resolve(Buffer.from(big, "utf8")) as never);
    const attachments = Array.from({ length: 10 }, (_unused, index) => ({
      path: `${PREFIX}fichier-${index}.txt`,
      name: `fichier-${index}.txt`,
      contentType: "text/plain",
    }));
    const result = await loadAgentAttachmentsContext(USER, attachments);
    const contentSection = result.note.split("CONTENU RÉEL")[1] ?? "";
    // Budget total respecté (60 000 + en-têtes) — jamais de prompt illimité.
    expect(contentSection.length).toBeLessThan(70_000);
    expect(result.files).toHaveLength(10);
  });

  it("plafonne le nombre de pièces jointes traitées à la politique (10)", async () => {
    mockedDownload.mockResolvedValue(Buffer.from("x") as never);
    const attachments = Array.from({ length: 14 }, (_unused, index) => ({
      path: `${PREFIX}f-${index}.txt`,
      name: `f-${index}.txt`,
      contentType: "text/plain",
    }));
    const result = await loadAgentAttachmentsContext(USER, attachments);
    expect(result.files).toHaveLength(10);
    expect(mockedDownload).toHaveBeenCalledTimes(10);
  });
});
