import type { RuntimePlan } from "@/lib/agents/runtime/types";

/**
 * MANIFEST DE LIVRABLES (exigence production : « système de missions avancé »
 * — une mission doit livrer ses résultats à l'utilisateur de façon explicite).
 *
 * Avant ce module, les artefacts produits restaient enfouis dans
 * `state.outputs[stepId]` : ni la réponse finale, ni la file, ni l'API de
 * suivi ne disaient « voici les fichiers livrés ». Ici le manifest est
 * extrait des sorties RÉELLES des étapes (jamais inventé) :
 *  - artefacts persistés (artifact.create → artifactId, filename, format) ;
 *  - zips et fichiers de workspace créés par les étapes outils.
 *
 * Utilisé par : /api/agent/chat (réponse + file), mission-tick (file + run
 * conversationnel + notification de livraison), /api/agents/runs/[runId].
 */

export interface MissionDeliverable {
  stepId: string;
  name: string;
  kind: "artifact" | "file" | "zip";
  artifactId?: string;
  filename?: string;
  format?: string;
  sizeBytes?: number;
  /** Chemin R2 ou workspace du livrable (accès via artifact.download / file.read). */
  storageKey?: string;
}

const MAX_DELIVERABLES = 20;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extrait le manifest de livrables des sorties réelles (pur, testable). */
export function extractDeliverables(plan: RuntimePlan, outputs: Record<string, unknown> = {}): MissionDeliverable[] {
  const deliverables: MissionDeliverable[] = [];
  const seen = new Set<string>();

  for (const step of plan.steps) {
    if (step.status !== "completed") continue;
    const output = asRecord(outputs[step.id]);
    if (!output) continue;

    const artifactId = typeof output.artifactId === "string" ? output.artifactId : undefined;
    const filename = typeof output.filename === "string" ? output.filename : undefined;
    const storageKey = typeof output.storageKey === "string" ? output.storageKey : undefined;
    const sizeBytes = typeof output.sizeBytes === "number" ? output.sizeBytes : undefined;
    const format = typeof output.format === "string" ? output.format : undefined;

    // Artefact document persisté (PDF, DOCX, XLSX, PPTX, CSV, MD…).
    if (artifactId && (step.toolName === "artifact.create" || Boolean(storageKey))) {
      const key = `artifact:${artifactId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deliverables.push({
        stepId: step.id,
        name: (step.description || step.name || filename || "Livrable").slice(0, 300),
        kind: "artifact",
        artifactId,
        ...(filename ? { filename } : {}),
        ...(format ? { format } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(storageKey ? { storageKey } : {}),
      });
      continue;
    }

    // ZIP créé (zip.create) ou fichier de workspace (file.create).
    if (step.toolName === "zip.create" && (filename || storageKey)) {
      const key = `zip:${step.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deliverables.push({
        stepId: step.id,
        name: (filename || step.name || "Archive ZIP").slice(0, 300),
        kind: "zip",
        ...(filename ? { filename } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(storageKey ? { storageKey } : {}),
      });
      continue;
    }
    if (step.toolName === "file.create" && output.success === true && filename) {
      const key = `file:${step.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deliverables.push({
        stepId: step.id,
        name: filename.slice(0, 300),
        kind: "file",
        filename,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      });
    }
  }

  return deliverables.slice(0, MAX_DELIVERABLES);
}

/** Section « Livrables » honnête pour le texte final (vide si aucun). */
export function deliverablesSection(deliverables: MissionDeliverable[]): string {
  if (deliverables.length === 0) return "";
  const lines = deliverables.map((item) => {
    const detail = [item.filename, item.format?.toUpperCase(), item.sizeBytes !== undefined ? `${Math.max(1, Math.round(item.sizeBytes / 1024))} Ko` : undefined]
      .filter(Boolean)
      .join(" · ");
    return `- ${item.name}${detail ? ` (${detail})` : ""}`;
  });
  return `\n\nLivrables remis (${deliverables.length}) :\n${lines.join("\n")}`;
}
