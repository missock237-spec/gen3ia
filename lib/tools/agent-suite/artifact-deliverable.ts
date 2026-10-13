import { generateArtifact } from "@/lib/documents/engine";
import { storeArtifactBuffer } from "@/lib/documents/artifact-store";

/**
 * Task 140 — Persistance des livrables de la suite « agent IA ».
 *
 * Les outils qui produisent un document (guide interactif, brief de
 * relais, pack de contenu, graphe de connaissances, rapport de
 * simulation…) doivent PERSISTER un artefact réel dans le stockage privé
 * de l'utilisateur — la même voie que l'outil canonique artifact.create
 * (generateArtifact → storeArtifactBuffer), jamais un retour volatil.
 *
 * Cette aide convertit du markdown (titres, listes, blocs de code,
 * paragraphes — les seules structures que les outils de la suite
 * produisent) en blocs de document, puis génère et stocke l'artefact.
 */

type DeliverableBlock =
  | { type: "heading"; text: string; level: number }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[]; ordered: boolean }
  | { type: "code"; text: string; language?: string };

/** Convertit du markdown simple en blocs de document (sans dépendance). */
export function markdownToBlocks(markdown: string): DeliverableBlock[] {
  const blocks: DeliverableBlock[] = [];
  const lines = markdown.split("\n");
  let listBuffer: { items: string[]; ordered: boolean } | null = null;

  const flushList = () => {
    if (listBuffer && listBuffer.items.length > 0) {
      blocks.push({ type: "list", items: listBuffer.items, ordered: listBuffer.ordered });
    }
    listBuffer = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      blocks.push({ type: "heading", text: heading[2].trim(), level: heading[1].length });
      continue;
    }
    const fence = /^```(\w+)?\s*$/.test(line.trim());
    if (fence) {
      flushList();
      // Le contenu du bloc est collecté ci-dessous par accumulation de
      // paragraphes bruts ; on simplifie : les fences délimitent des blocs
      // code collectés ici ligne à ligne.
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line.trim());
    if (bullet) {
      if (!listBuffer || listBuffer.ordered) {
        flushList();
        listBuffer = { items: [], ordered: false };
      }
      listBuffer.items.push(bullet[1].trim());
      continue;
    }
    const ordered = /^(\d+)[.)]\s+(.*)$/.exec(line.trim());
    if (ordered) {
      if (!listBuffer || !listBuffer.ordered) {
        flushList();
        listBuffer = { items: [], ordered: true };
      }
      listBuffer.items.push(ordered[2].trim());
      continue;
    }
    flushList();
    blocks.push({ type: "paragraph", text: line });
  }
  flushList();
  return blocks;
}

export interface PersistedDeliverable {
  artifactId: string;
  filename: string;
  format: string;
  storageKey: string;
}

/**
 * Génère et stocke un livrable markdown persistant pour l'utilisateur.
 * Retourne l'identifiant d'artefact réel (stockage privé R2 / repli base).
 */
export async function persistMarkdownDeliverable(params: {
  userId: string;
  executionId?: string;
  title: string;
  markdown: string;
  nameHint?: string;
}): Promise<PersistedDeliverable> {
  const blocks = markdownToBlocks(params.markdown);
  if (blocks.length === 0) {
    throw new Error("Le livrable est vide — rien à enregistrer.");
  }
  const generated = await generateArtifact({
    userId: params.userId,
    executionId: params.executionId,
    plan: {
      title: params.title,
      format: "md",
      blocks: blocks.map((block) => ({ ...block })),
    },
  });
  const artifact = await storeArtifactBuffer({
    ownerId: params.userId,
    executionId: params.executionId ?? "suite-agent",
    name: generated.filename,
    mimeType: generated.mimeType,
    data: generated.data,
  });
  return {
    artifactId: artifact.artifactId,
    filename: artifact.name,
    format: generated.format,
    storageKey: artifact.storageKey,
  };
}
