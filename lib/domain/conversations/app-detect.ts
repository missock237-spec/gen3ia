import type { ConversationArtifact } from "./types";

/**
 * Détection d'« application exécutable » parmi les artefacts de code.
 * Une app créée par l'agent (page HTML/CSS/JS autonome) peut être
 * prévisualisée en direct dans la conversation via un iframe sandboxé.
 */

export function isRunnableHtmlApp(artifact: Pick<ConversationArtifact, "type" | "language" | "filename" | "content"> | undefined | null): boolean {
  if (!artifact || artifact.type !== "code") return false;
  const language = (artifact.language ?? "").toLowerCase();
  const filename = (artifact.filename ?? "").toLowerCase();
  const content = (artifact.content ?? "").trimStart().slice(0, 400).toLowerCase();
  if (language === "html" || filename.endsWith(".html") || filename.endsWith(".htm")) return Boolean(artifact.content);
  // Un document autonome commençant par <!DOCTYPE html / <html est une app
  // rendable même si le langage n'a pas été annoté par l'agent.
  return Boolean(artifact.content) && (content.startsWith("<!doctype html") || content.startsWith("<html"));
}

/** Artefacts « app » les plus récents d'abord. */
export function runnableAppsFrom(artifacts: ConversationArtifact[]): ConversationArtifact[] {
  return artifacts.filter((a) => isRunnableHtmlApp(a));
}
