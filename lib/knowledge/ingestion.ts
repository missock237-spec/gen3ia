import { randomUUID } from "crypto";

import yauzl from "yauzl";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { adminDb } from "@/lib/firebase/admin";
import { indexKnowledgeDocument } from "./indexer";

/**
 * Ingestion Knowledge / RAG Gen3ia.
 *
 * Pipeline réel : source (fichier téléversé ou URL) → extraction texte →
 * enregistrement `knowledgeDocuments` → chunking + embeddings + index
 * Firestore/Qdrant via `indexKnowledgeDocument`. La recherche s'appuie sur
 * l'index existant (lib/knowledge/search.ts, tool knowledge.search).
 */

export const KNOWLEDGE_MAX_TEXT_BYTES = 2_000_000;
export const KNOWLEDGE_MAX_FILE_BYTES = 20_000_000;
export const KNOWLEDGE_MAX_URL_BYTES = 2_000_000;

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yml", "yaml", "html", "htm"]);

export interface KnowledgeDocumentRecord {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  source: "upload" | "url";
  storagePath?: string;
  charCount: number;
  chunkCount: number;
  status: "indexed" | "empty";
  createdAt: string;
}

/** Supprime les balises, décode les entités de base et compacte les blancs. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Extrait le texte lisible d'un DOCX (zip Word) : word/document.xml → texte. */
export async function docxToText(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(error ?? new Error("DOCX illisible (archive zip invalide)."));
        return;
      }
      let settled = false;
      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        try { zipFile.close(); } catch { /* déjà fermé */ }
        resolve(value);
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        try { zipFile.close(); } catch { /* déjà fermé */ }
        reject(err);
      };

      zipFile.on("error", (err: Error) => fail(new Error("DOCX illisible : archive corrompue.")));
      zipFile.on("end", () => fail(new Error("DOCX sans contenu texte (word/document.xml absent).")));
      zipFile.on("entry", (entry: yauzl.Entry) => {
        if (entry.fileName !== "word/document.xml") {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(new Error("DOCX illisible : document.xml inaccessible."));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => {
            if (chunks.reduce((total, part) => total + part.length, 0) > KNOWLEDGE_MAX_TEXT_BYTES) {
              fail(new Error("DOCX trop volumineux (texte > 2 Mo)."));
              stream.destroy();
              return;
            }
            chunks.push(chunk);
          });
          stream.on("end", () => {
            const xml = Buffer.concat(chunks).toString("utf8");
            const text = xml
              .replace(/<\/w:p>/g, "\n")
              .replace(/<w:tab[^>]*\/>/g, "\t")
              .replace(/<[^>]+>/g, "")
              .replace(/&amp;/g, "&")
              .replace(/&lt;/g, "<")
              .replace(/&gt;/g, ">")
              .replace(/&quot;/g, '"')
              .replace(/&#39;|&apos;/g, "'")
              .replace(/[ \t]+/g, " ")
              .replace(/\n\s*\n\s*\n+/g, "\n\n")
              .trim();
            finish(text);
          });
          stream.on("error", () => fail(new Error("DOCX illisible : erreur de lecture.")));
        });
      });
      zipFile.readEntry();
    });
  });
}

/** Extrait le texte d'un fichier téléversé selon son type réel. */
export async function extractTextFromUpload(file: File): Promise<{ text: string; mimeType: string }> {
  if (file.size > KNOWLEDGE_MAX_FILE_BYTES) {
    throw new Error(`Fichier trop volumineux (max ${Math.round(KNOWLEDGE_MAX_FILE_BYTES / 1_000_000)} Mo).`);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  const extension = name.includes(".") ? name.split(".").pop()! : "";

  if (extension === "docx" || file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const text = await docxToText(buffer);
    return { text, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
  }

  const text = buffer.toString("utf8");
  if (extension === "html" || extension === "htm" || file.type === "text/html") {
    return { text: htmlToText(text), mimeType: "text/html" };
  }
  if (extension === "pdf") {
    throw new Error("Format PDF non encore pris en charge par l'ingestion Knowledge. Convertissez le document en DOCX, TXT, Markdown ou HTML.");
  }
  if (!TEXT_EXTENSIONS.has(extension) && !file.type.startsWith("text/") && file.type !== "application/json") {
    throw new Error(`Format « ${extension || file.type || "inconnu"} » non pris en charge. Formats acceptés : TXT, MD, CSV, JSON, HTML, DOCX.`);
  }
  return { text, mimeType: file.type || `text/${extension || "plain"}` };
}

/** Télécharge et extrait le texte d'une page web (garde SSRF + taille). */
export async function extractTextFromUrl(rawUrl: string): Promise<{ text: string; mimeType: string; finalUrl: string }> {
  const url = await assertPublicHttpUrl(rawUrl);
  const response = await fetch(url.toString(), {
    headers: { "user-agent": "Gen3iaKnowledgeBot/1.0 (+https://gen3ia.online)" },
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`URL inaccessible (HTTP ${response.status}).`);
  const contentType = (response.headers.get("content-type") ?? "text/html").split(";")[0].trim();
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > KNOWLEDGE_MAX_URL_BYTES) throw new Error("Page trop volumineuse (max 2 Mo).");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > KNOWLEDGE_MAX_URL_BYTES) throw new Error("Page trop volumineuse (max 2 Mo).");
  const text = buffer.toString("utf8");

  if (contentType === "text/html" || contentType === "application/xhtml+xml") {
    return { text: htmlToText(text), mimeType: "text/html", finalUrl: response.url || url.toString() };
  }
  if (contentType.startsWith("text/") || contentType === "application/json" || contentType === "text/markdown") {
    return { text, mimeType: contentType, finalUrl: response.url || url.toString() };
  }
  throw new Error(`Type de contenu « ${contentType} » non pris en charge (pages web et textes seulement).`);
}

/**
 * Enregistre le document puis l'indexe (chunks + embeddings + Qdrant).
 * Le document est créé AVANT l'indexation : un échec d'indexation laisse
 * une trace consultable (status + erreur) au lieu d'un upload fantôme.
 */
export async function ingestKnowledgeDocument(input: {
  userId: string;
  projectId: string;
  name: string;
  mimeType: string;
  text: string;
  source: "upload" | "url";
  storagePath?: string;
}): Promise<KnowledgeDocumentRecord> {
  const text = input.text.trim();
  if (!text) throw new Error("Aucun texte extractible de cette source.");
  if (Buffer.byteLength(text, "utf8") > KNOWLEDGE_MAX_TEXT_BYTES) {
    throw new Error("Texte trop volumineux après extraction (max 2 Mo).");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const ref = adminDb.collection("knowledgeDocuments").doc(id);
  await ref.set({
    userId: input.userId,
    projectId: input.projectId,
    name: input.name.slice(0, 300),
    mimeType: input.mimeType.slice(0, 160),
    source: input.source,
    ...(input.storagePath ? { storagePath: input.storagePath } : {}),
    charCount: text.length,
    chunkCount: 0,
    status: "indexed",
    createdAt: now,
    updatedAt: now,
  });

  try {
    const chunkCount = await indexKnowledgeDocument({
      userId: input.userId,
      projectId: input.projectId,
      documentId: id,
      text,
    });
    await ref.update({ chunkCount, status: chunkCount > 0 ? "indexed" : "empty", updatedAt: new Date().toISOString() });
    return {
      id, projectId: input.projectId, name: input.name.slice(0, 300), mimeType: input.mimeType.slice(0, 160),
      source: input.source, ...(input.storagePath ? { storagePath: input.storagePath } : {}),
      charCount: text.length, chunkCount, status: chunkCount > 0 ? "indexed" : "empty", createdAt: now,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexation impossible";
    await ref.update({ status: "empty", lastError: message.slice(0, 300), updatedAt: new Date().toISOString() }).catch(() => undefined);
    throw new Error(`Document enregistré mais indexation impossible : ${message}`);
  }
}

/** Supprime un document et tous ses fragments (Firestore + Qdrant best-effort). */
export async function deleteKnowledgeDocument(userId: string, documentId: string): Promise<boolean> {
  const ref = adminDb.collection("knowledgeDocuments").doc(documentId);
  const doc = await ref.get();
  if (!doc.exists || (doc.data() as { userId?: string } | undefined)?.userId !== userId) return false;

  const chunks = await adminDb.collection("knowledgeChunks")
    .where("userId", "==", userId)
    .where("documentId", "==", documentId)
    .limit(2000)
    .get();
  const chunkIds: string[] = [];
  const batch = adminDb.batch();
  chunks.docs.forEach((chunk) => {
    batch.delete(chunk.ref);
    chunkIds.push(chunk.id);
  });
  await batch.commit();
  await ref.delete();

  // Miroir vectoriel : suppression best-effort (la recherche retombe sur
  // Firestore, donc un point Qdrant résiduel n'est jamais servi comme vérité).
  if (chunkIds.length > 0) {
    try {
      const { deleteVectorPoints, VECTOR_COLLECTION_KNOWLEDGE } = await import("@/lib/memory/vector-store");
      await deleteVectorPoints(VECTOR_COLLECTION_KNOWLEDGE, chunkIds);
    } catch {
      // Absorbé : l'index Firestore est la source de vérité.
    }
  }
  return true;
}
