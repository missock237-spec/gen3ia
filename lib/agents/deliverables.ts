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
 *  - zips et fichiers de workspace créés par les étapes outils ;
 *  - VIDÉOS produites par video.create (job + projet studio — Task 114-a :
 *    « interface universelle », les résultats médias apparaissent dans le
 *    manifeste et donc dans le message final de conversation) ;
 *  - AUDIOS de voix-off produits par voice.speak (clé R2 permanente — un
 *    audio « inline » sans clé n'est PAS listé : jamais de faux livrable).
 *
 * Utilisé par : /api/agent/chat (réponse + file), mission-tick (file + run
 * conversationnel + notification de livraison), /api/agents/runs/[runId].
 */

export interface MissionDeliverable {
  stepId: string;
  name: string;
  kind: "artifact" | "file" | "zip" | "video" | "audio";
  artifactId?: string;
  filename?: string;
  format?: string;
  sizeBytes?: number;
  /** Chemin R2 ou workspace du livrable (accès via artifact.download / file.read). */
  storageKey?: string;
}

const MAX_DELIVERABLES = 20;

/** Priorité de tri : les RÉSULTATS médias (vidéos/audios) d'abord — le cap 20 ne doit jamais les évincer au profit d'étapes intermédiaires. */
const KIND_ORDER: Record<MissionDeliverable["kind"], number> = {
  video: 0,
  audio: 1,
  artifact: 2,
  file: 3,
  zip: 4,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Extension audio déduite du mimeType de sortie (repli mp3). */
function audioExtensionFrom(mimeType: unknown): string {
  const mime = typeof mimeType === "string" ? mimeType.toLowerCase() : "";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("flac")) return "flac";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return "mp3";
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

    // VIDÉO produite (video.create → job + projet studio) : le résultat
    // MEDIA réel entre dans le manifeste (Task 114-a) — ouvrable dans
    // l'atelier vidéo via le projectId.
    if (step.toolName === "video.create" && typeof output.jobId === "string") {
      const key = `video:${output.jobId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deliverables.push({
        stepId: step.id,
        name: (step.description || step.name || "Vidéo produite").slice(0, 300),
        kind: "video",
        artifactId: output.jobId,
        ...(typeof output.projectId === "string" && output.projectId ? { storageKey: output.projectId } : {}),
        ...(filename ? { filename } : { filename: `video-${output.jobId}` }),
      });
      continue;
    }

    // AUDIO de voix-off (voice.speak → clé R2 permanente). Un audio inline
    // (storage:"inline", sans clé) n'est PAS listé : sans référence
    // permanente, le mentionner serait un faux livrable irrécupérable.
    if (step.toolName === "voice.speak" && output.storage === "r2" && typeof output.url === "string") {
      const key = `audio:${output.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deliverables.push({
        stepId: step.id,
        name: (step.description || step.name || "Voix-off").slice(0, 300),
        kind: "audio",
        artifactId: step.id,
        storageKey: output.url,
        ...(filename ? { filename } : { filename: `audio-${step.id}.${audioExtensionFrom(output.mimeType)}` }),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      });
      continue;
    }

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

  // Vidéos/audios en priorité (tri stable à l'intérieur de chaque groupe),
  // PUIS cap 20 — un manifeste riche n'évince jamais le résultat média final.
  const sorted = [...deliverables].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  );
  return sorted.slice(0, MAX_DELIVERABLES);
}

/** Libellé FR du type de livrable dans la section finale (préfixes texte, style cohérent). */
const KIND_LABELS: Record<MissionDeliverable["kind"], string> = {
  video: "[Vidéo - à ouvrir dans le studio]",
  audio: "[Audio - voix-off]",
  artifact: "[Document]",
  file: "[Fichier]",
  zip: "[Archive]",
};

/** Section « Livrables » honnête pour le texte final (vide si aucun). */
export function deliverablesSection(deliverables: MissionDeliverable[]): string {
  if (deliverables.length === 0) return "";
  const lines = deliverables.map((item) => {
    const detail = [item.filename, item.format?.toUpperCase(), item.sizeBytes !== undefined ? `${Math.max(1, Math.round(item.sizeBytes / 1024))} Ko` : undefined]
      .filter(Boolean)
      .join(" · ");
    // Chemin/accès : vidéo → atelier studio (projectId) ; audio → clé R2
    // permanente ; autres livrables → clé de stockage brute si connue.
    let access: string | undefined;
    if (item.kind === "video" && item.storageKey) access = `studio : /studio/video/${item.storageKey}`;
    else if (item.kind === "audio" && item.storageKey) access = `audio : ${item.storageKey}`;
    else if (item.storageKey) access = item.storageKey;
    const suffix = [detail, access].filter(Boolean).join(" — ");
    return `- ${KIND_LABELS[item.kind]} ${item.name}${suffix ? ` ${suffix}` : ""}`;
  });
  return `\n\nLivrables remis (${deliverables.length}) :\n${lines.join("\n")}`;
}
