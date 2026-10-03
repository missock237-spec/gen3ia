import { randomUUID } from "crypto";

import yauzl from "yauzl";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { adminDb } from "@/lib/firebase/admin";
import { assertResourceWrite } from "@/lib/tenants/resource-access";
import { indexKnowledgeDocument } from "./indexer";
import { markupToText } from "@/lib/content/html-text";
import { perceiveIfSupported } from "./perception";
import { evaluateKnowledgeTriggers } from "./triggers";
import { pdfToText } from "@/lib/files/pdf-text";

/**
 * Ingestion Knowledge / RAG Gen3ia.
 *
 * Pipeline réel : source (fichier téléversé ou URL) → extraction texte →
 * enregistrement `knowledgeDocuments` → chunking + embeddings + index
 * Firestore/Qdrant via `indexKnowledgeDocument`. La recherche s'appuie sur
 * l'index existant (lib/knowledge/search.ts, tool knowledge.search).
 */

export const KNOWLEDGE_MAX_TEXT_BYTES = 2_000_000;
// Politique unifiée des pièces jointes : 50 Mo par fichier (canal R2 — le
// corps serverless ne limite plus l'ingestion depuis le stockage permanent).
export const KNOWLEDGE_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const KNOWLEDGE_MAX_URL_BYTES = 2_000_000;

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yml", "yaml", "html", "htm"]);

export interface KnowledgeDocumentRecord {
  id: string;
  projectId: string;
  /** Rattachement organisationnel optionnel (recommandation C). */
  orgId?: string;
  name: string;
  mimeType: string;
  source: "upload" | "url";
  storagePath?: string;
  charCount: number;
  chunkCount: number;
  status: "indexed" | "empty";
  createdAt: string;
}

/**
 * HTML → texte : machine à états dédiée (lib/content/html-text.ts) — les
 * chaînes de regex historiques laissaient traverser des balises imbriquées
 * (`<scr<script>ipt>`) et décodaient les entités par passes successives
 * (alertes CodeQL bad-tag-filter / double-escaping /
 * incomplete-multi-character-sanitization). Le parseur incrémental ne peut
 * pas être évasé : il suit les guillemets d'attributs, ignore les éléments
 * à contenu brut jusqu'à leur fermeture réelle et décode chaque entité
 * exactement une fois.
 */
export function htmlToText(html: string): string {
  return markupToText(html);
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

      zipFile.on("error", () => fail(new Error("DOCX illisible : archive corrompue.")));
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
            // Même machine à états que le HTML : `</w:p>` émet la fin de
            // paragraphe, `<w:tab/>` une tabulation — le balisage résiduel
            // et les entités partiellement décodées sont désormais impossibles.
            const text = markupToText(xml, {
              blockElements: [],
              tabElements: ["w:tab"],
              collapseWhitespace: false,
            }).replace(/[ \t]+/g, " ")
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
export async function extractTextFromUpload(file: File): Promise<{ text: string; mimeType: string; perception?: string }> {
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

  // COUCHE PERCEPTION (concept #9) : images (OCR par modèle vision) et
  // audios (ASR ElevenLabs) deviennent du TEXTE indexable — le réel entre
  // dans la base de connaissances. Erreur honnête si fournisseur absent.
  if (file.type.startsWith("image/") || file.type.startsWith("audio/") || ["png", "jpg", "jpeg", "webp", "gif", "mp3", "wav", "m4a", "ogg", "flac", "webm"].includes(extension)) {
    const mimeType = file.type || (extension === "png" || extension === "gif" || extension === "webp" ? `image/${extension}` : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "mp3" ? "audio/mpeg" : extension === "wav" ? "audio/wav" : extension === "m4a" ? "audio/mp4" : extension === "ogg" ? "audio/ogg" : extension === "flac" ? "audio/flac" : `image/${extension}`);
    const perception = await perceiveIfSupported({ buffer, mimeType, filename: file.name });
    if (perception) {
      if (!perception.text.trim()) throw new Error(`Aucun texte extractible de cette source (${perception.providerLabel}).`);
      return { text: perception.text, mimeType, perception: perception.providerLabel };
    }
  }

  const text = buffer.toString("utf8");
  if (extension === "html" || extension === "htm" || file.type === "text/html") {
    return { text: htmlToText(text), mimeType: "text/html" };
  }
  if (extension === "pdf" || file.type === "application/pdf") {
    // PDF natif ACCEPTÉ (exigence production) : extraction réelle partagée
    // avec l'import de conversation (lib/files/pdf-text.ts). Un PDF scanné
    // (aucun texte natif) bascule vers la perception OCR quand disponible.
    const { text } = pdfToText(buffer);
    if (text.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length >= 30) {
      return { text, mimeType: "application/pdf" };
    }
    const perception = await perceiveIfSupported({ buffer, mimeType: "application/pdf", filename: file.name });
    if (perception && perception.text.trim()) {
      return { text: perception.text, mimeType: "application/pdf", perception: perception.providerLabel };
    }
    throw new Error("PDF sans texte natif extractible (probablement scanné) et perception indisponible. Convertissez-le en DOCX, TXT ou Markdown.");
  }
  if (!TEXT_EXTENSIONS.has(extension) && !file.type.startsWith("text/") && file.type !== "application/json") {
    throw new Error(`Format « ${extension || file.type || "inconnu"} » non pris en charge. Formats acceptés : TXT, MD, CSV, JSON, HTML, DOCX, PDF, images (OCR), audio (ASR).`);
  }
  return { text, mimeType: file.type || `text/${extension || "plain"}` };
}

/**
 * Ingestion Knowledge depuis le stockage PERMANENT (canal R2 — exigence
 * production : fichiers jusqu'à 50 Mo sans limite de corps serverless).
 * Le cloisonnement (préfixe permanent du propriétaire) est vérifié avant
 * tout téléchargement, puis la même extraction que le canal direct.
 */
export async function extractTextFromPermanentFile(input: {
  userId: string;
  path: string;
  filename: string;
  contentType?: string;
}): Promise<{ text: string; mimeType: string; perception?: string }> {
  const { downloadFromR2 } = await import("@/lib/storage/r2");
  if (!input.path.startsWith(`users/${input.userId}/permanent/`)) {
    throw new Error("Chemin de stockage invalide pour ce compte.");
  }
  const buffer = await downloadFromR2(input.path, KNOWLEDGE_MAX_FILE_BYTES);
  if (!buffer || buffer.length === 0) throw new Error("Fichier introuvable dans le stockage.");
  const contentType = (input.contentType || "application/octet-stream").split(";")[0].trim();
  const extension = input.filename.toLowerCase().includes(".") ? input.filename.toLowerCase().split(".").pop()! : "";

  if (extension === "docx" || contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return { text: await docxToText(buffer), mimeType: contentType };
  }
  if (contentType.startsWith("image/") || contentType.startsWith("audio/") || ["png", "jpg", "jpeg", "webp", "gif", "mp3", "wav", "m4a", "ogg", "flac", "webm"].includes(extension)) {
    const perception = await perceiveIfSupported({ buffer, mimeType: contentType, filename: input.filename });
    if (perception) {
      if (!perception.text.trim()) throw new Error(`Aucun texte extractible de cette source (${perception.providerLabel}).`);
      return { text: perception.text, mimeType: contentType, perception: perception.providerLabel };
    }
  }
  if (extension === "pdf" || contentType === "application/pdf") {
    const { text } = pdfToText(buffer);
    if (text.replace(/[^A-Za-zÀ-ÿ0-9]/g, "").length >= 30) return { text, mimeType: "application/pdf" };
    const perception = await perceiveIfSupported({ buffer, mimeType: "application/pdf", filename: input.filename });
    if (perception && perception.text.trim()) return { text: perception.text, mimeType: "application/pdf", perception: perception.providerLabel };
    throw new Error("PDF sans texte natif extractible et perception indisponible.");
  }
  const text = buffer.toString("utf8");
  if (extension === "html" || extension === "htm" || contentType === "text/html") {
    return { text: htmlToText(text), mimeType: "text/html" };
  }
  if (!TEXT_EXTENSIONS.has(extension) && !contentType.startsWith("text/") && contentType !== "application/json") {
    throw new Error(`Format « ${extension || contentType || "inconnu"} » non pris en charge (canal stockage permanent).`);
  }
  return { text, mimeType: contentType.startsWith("text/") || contentType !== "application/octet-stream" ? contentType : `text/${extension || "plain"}` };
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

  // Perception des URLs directes vers des images (OCR) — concept #9.
  if (contentType.startsWith("image/")) {
    const perception = await perceiveIfSupported({ buffer, mimeType: contentType, filename: response.url.split("/").pop() ?? "image" });
    if (perception && perception.text.trim()) {
      return { text: perception.text, mimeType: contentType, finalUrl: response.url || url.toString() };
    }
  }

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
  /** Org cible — la validation d'appartenance est faite par la ROUTE via
   * la politique centralisée ; ce dépôt fait confiance au préalable établi. */
  orgId?: string;
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
    ...(input.orgId ? { orgId: input.orgId } : {}),
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
      orgId: input.orgId,
    });
    await ref.update({ chunkCount, status: chunkCount > 0 ? "indexed" : "empty", updatedAt: new Date().toISOString() });
    // DÉCLENCHEURS (concept #9) : le document fraîchement indexé peut lancer
    // des missions d'agents (fail-soft, journalisé — jamais d'échec
    // d'ingestion à cause d'un déclencheur).
    void evaluateKnowledgeTriggers({
      userId: input.userId,
      ...(input.orgId ? { orgId: input.orgId } : {}),
      document: {
        id,
        name: input.name,
        mimeType: input.mimeType,
        excerpt: text.slice(0, 600),
      },
    }).catch((triggerError) => {
      console.error("[knowledge] déclencheurs non évalués (fail-soft):", triggerError instanceof Error ? triggerError.message : triggerError);
    });
    return {
      id, projectId: input.projectId, ...(input.orgId ? { orgId: input.orgId } : {}), name: input.name.slice(0, 300), mimeType: input.mimeType.slice(0, 160),
      source: input.source, ...(input.storagePath ? { storagePath: input.storagePath } : {}),
      charCount: text.length, chunkCount, status: chunkCount > 0 ? "indexed" : "empty", createdAt: now,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Indexation impossible";
    await ref.update({ status: "empty", lastError: message.slice(0, 300), updatedAt: new Date().toISOString() }).catch(() => undefined);
    throw new Error(`Document enregistré mais indexation impossible : ${message}`);
  }
}

/**
 * Supprime un document et tous ses fragments (Firestore + Qdrant
 * best-effort). Sémantique org-aware (recommandation C) : accès en
 * écriture = propriétaire OU owner/admin de l'organisation du document ;
 * la politique centralisée tranche, la dénégation reste indiscernable
 * d'un document absent (false → 404 côté route).
 */
export async function deleteKnowledgeDocument(userId: string, documentId: string): Promise<boolean> {
  const ref = adminDb.collection("knowledgeDocuments").doc(documentId);
  const doc = await ref.get();
  if (!doc.exists) return false;
  const data = (doc.data() ?? {}) as { userId?: string; orgId?: string };
  try {
    await assertResourceWrite(userId, { ownerId: String(data.userId ?? ""), orgId: typeof data.orgId === "string" ? data.orgId : null });
  } catch {
    return false;
  }

  const chunks = await adminDb.collection("knowledgeChunks")
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
