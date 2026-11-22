import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EXIGENCE PRODUCTION (bug « il ignore le fichier et répond selon sa volonté ») :
 * quand un message porte des pièces jointes, le prompt du tour chat DOIT
 * contenir (1) le contenu RÉEL des fichiers (filesContext) quand il a pu être
 * chargé, et (2) une consigne impérative d'analyse + résolution de la demande
 * associée au fichier — même quand le contenu n'a pas pu être chargé (réponse
 * honnête, jamais improvisée). Sans pièce jointe : aucune consigne ajoutée.
 */

vi.mock("@/lib/ai/router", () => ({
  generate: vi.fn(),
  generateStream: vi.fn(),
}));
vi.mock("@/lib/ai/truth-context", () => ({
  buildTruthContext: vi.fn(async () => ({ semantic: [], instructions: "" })),
}));
vi.mock("@/lib/ai/self-review", () => ({
  reviewVisibleAnswer: vi.fn(async (input: { answer: string }) => ({ ...input, text: input.answer, verdict: "conforme", skipped: false })),
}));
vi.mock("@/lib/observability/self-review-metrics", () => ({
  enregistrerSelfReview: vi.fn(),
}));
vi.mock("@/lib/chat/repository", () => ({
  appendMessage: vi.fn(async (input: { conversationId: string; role: string; content: string }) => ({
    id: "msg-1",
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    date: new Date().toISOString(),
  })),
}));
vi.mock("@/lib/memory/episodic", () => ({
  shouldSummarize: vi.fn(() => false),
  summarizeChatConversation: vi.fn(),
}));
vi.mock("@/lib/files/image-source", () => ({
  attachmentImageCandidates: vi.fn(() => []),
}));
vi.mock("@/lib/ai/vision-input", () => ({
  imagesForModel: vi.fn(() => []),
}));
// Chaîne complète : la conversion du fichier est RÉELLE — seuls R2 (téléverse-
// ment) et Firestore (record d'import) sont simulés, comme dans import.test.ts.
const docStore = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@/lib/storage/r2", () => ({
  downloadFromR2: vi.fn(),
  isR2Configured: vi.fn(() => true),
  uploadToR2: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => {
          const data = docStore.get(id);
          return data ? { exists: true, id, data: () => data } : { exists: false, id, data: () => undefined };
        },
      }),
    }),
  },
}));

import { generate } from "@/lib/ai/router";
import { downloadFromR2 } from "@/lib/storage/r2";
import { loadImportedFilesContext } from "@/lib/files/import";
import { runChatTurn, type TurnContext } from "./engine-chat";

const mockedGenerate = vi.mocked(generate);
const mockedDownload = vi.mocked(downloadFromR2);

const PIECE_CSV = {
  filename: "ventes.csv",
  path: "users/user-1/permanent/ventes.csv",
  contentType: "text/csv",
  sizeBytes: 30,
  fileId: "file-123",
  fileKind: "csv",
  charCount: 42,
  rowCount: 3,
};

function baseCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    userId: "user-1",
    conversationId: "conv-1",
    message: "Analyse ce fichier et dis-moi les ventes du mois",
    conversation: { id: "conv-1", userId: "user-1", title: "Test", createdAt: "2026-01-01", updatedAt: "2026-01-01", messageCount: 0 },
    project: null,
    userMessage: { id: "u-1", role: "user", content: "Analyse ce fichier", date: "2026-01-01" },
    priorHistory: [],
    intent: { mode: "chat", understanding: "test" },
    ...overrides,
  } as unknown as TurnContext;
}

function promptSystemDuTour(): string {
  const appel = mockedGenerate.mock.calls.at(-1)?.[0];
  const systeme = (appel?.messages ?? []).find((m) => m.role === "system");
  return systeme?.content ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGenerate.mockResolvedValue({ text: "Réponse de test.", provider: "mock", model: "mock-model" } as never);
});

describe("runChatTurn — les fichiers joints sont ANALYSÉS, jamais ignorés", () => {
  it("le prompt système contient le contenu réel du fichier ET la consigne impérative de résolution", async () => {
    const result = await runChatTurn(baseCtx({
      attachments: [PIECE_CSV],
      filesContext: "Contenu RÉEL des fichiers importés (stockés en base de données) :\nFichier importé « ventes.csv » (csv) :\nproduit,prix\nCafé,1500",
    }));
    expect(result.assistantMessage.content).toBe("Réponse de test.");
    const prompt = promptSystemDuTour();
    // Le contenu réel est injecté (le modèle ne peut pas l'inventer).
    expect(prompt).toContain("ventes.csv");
    expect(prompt).toContain("produit,prix");
    expect(prompt).toContain("appuie-toi EXCLUSIVEMENT sur eux");
    // La consigne impérative lie le fichier à la demande de l'utilisateur.
    expect(prompt).toContain("CONSIGNE IMPÉRATIVE — FICHIERS JOINTS À CE MESSAGE");
    expect(prompt).toContain("« ventes.csv »");
    expect(prompt).toContain("résoudre la demande de l'utilisateur");
    expect(prompt).toContain("sans jamais inventer de données");
  });

  it("contenu non chargé : la consigne reste présente — réponse honnête, jamais improvisée", async () => {
    await runChatTurn(baseCtx({ attachments: [{ ...PIECE_CSV, fileId: undefined, fileKind: undefined, charCount: undefined, rowCount: undefined }], filesContext: "" }));
    const prompt = promptSystemDuTour();
    expect(prompt).toContain("CONSIGNE IMPÉRATIVE — FICHIERS JOINTS À CE MESSAGE");
    expect(prompt).toContain("« ventes.csv »");
    expect(prompt).toContain("chargement impossible");
    expect(prompt).toContain("jamais improviser sur son contenu supposé");
    // Sans contenu chargé, aucune donnée de fichier n'est inventée au prompt.
    expect(prompt).not.toContain("produit,prix");
  });

  it("sans pièce jointe : aucune consigne fichiers dans le prompt", async () => {
    await runChatTurn(baseCtx({ filesContext: "" }));
    const prompt = promptSystemDuTour();
    expect(prompt).not.toContain("CONSIGNE IMPÉRATIVE — FICHIERS JOINTS");
    expect(prompt).not.toContain("Pièces jointes de l'utilisateur");
  });

  it("plusieurs fichiers joints : tous les noms sont annoncés à la consigne", async () => {
    await runChatTurn(baseCtx({
      attachments: [PIECE_CSV, { filename: "budget.xlsx", path: "users/user-1/permanent/budget.xlsx", contentType: "application/vnd.ms-excel" }],
      filesContext: "Contenu RÉEL des fichiers importés :\nFichier importé « budget.xlsx » (xlsx) :\nLigne budget",
    }));
    const prompt = promptSystemDuTour();
    expect(prompt).toContain("« ventes.csv »");
    expect(prompt).toContain("« budget.xlsx »");
    expect(prompt).toContain("l'utilisateur a joint 2 fichier(s)");
  });

  it("CHAÎNE COMPLÈTE — fichier réel : upload → conversion → contenu injecté → consigne liée à la requête", async () => {
    // Un utilisateur envoie ventes-2026.csv avec la demande « analyse les ventes » :
    // le contenu RÉEL du fichier (conversion vraie, pas un mock) doit atteindre
    // le prompt, et la consigne doit lier l'analyse du fichier à la demande.
    mockedDownload.mockResolvedValue(
      Buffer.from("produit,ventes_mois\nCafé,1500\nThé,1000\nChocolat,800", "utf8") as never,
    );
    const filesContext = await loadImportedFilesContext("user-1", [
      { path: "users/user-1/permanent/ventes-2026.csv", filename: "ventes-2026.csv", contentType: "text/csv" },
    ]);
    expect(filesContext).toContain("Café,1500"); // contenu réel converti
    expect(filesContext).toContain("3 lignes");

    await runChatTurn(baseCtx({
      message: "Analyse le fichier joint et dis-moi quel produit se vend le mieux",
      attachments: [{ filename: "ventes-2026.csv", path: "users/user-1/permanent/ventes-2026.csv", contentType: "text/csv" }],
      filesContext,
    }));
    const prompt = promptSystemDuTour();
    // Le modèle reçoit le fichier ET la demande : sa réponse peut y répondre.
    expect(prompt).toContain("Café,1500");
    expect(prompt).toContain("« ventes-2026.csv »");
    expect(prompt).toContain("CONSIGNE IMPÉRATIVE — FICHIERS JOINTS À CE MESSAGE");
    expect(prompt).toContain("résoudre la demande de l'utilisateur");
  });
});
