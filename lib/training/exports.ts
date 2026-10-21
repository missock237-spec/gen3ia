import "server-only";

// ⚠️ IMPORT STATIQUE OBLIGATOIRE — l'interopérabilité webpack de l'import()
// dynamique d'un paquet EXTERNE (serverExternalPackages) est cassée : en
// production, `const { default: archiver } = await import("archiver")` lève
// « TypeError: d is not a constructor » (reproduit et vérifié sur Next 15.5).
// Le pattern statique (même que lib/documents/zip/create.ts) fonctionne.
import archiver from "archiver";

import { newUlid, userDir } from "@/lib/storage/user-data-store";
import { putObject, createDownloadUrl, downloadFromR2 } from "@/lib/storage/r2";

import { getProjectOverview } from "./repository";
import { exportArtifactSchema, type ExportArtifact } from "./types";

/* ------------------------------------------------------------------ */
/* Exports (spec §4 étape 7)                                            */
/*                                                                    */
/* Liens temporaires signés (durée configurable, défaut 30 min) :      */
/* seul le propriétaire peut préparer un export, et le lien signé      */
/* expiré ne donne plus accès au fichier (spec §11).                   */
/*                                                                    */
/* v1 honnête : exports de ce qui EXISTE réellement — archives de       */
/* datasets, fichiers modèle importés, configuration du plan. Les       */
/* poids issus d'un entraînement n'apparaissent qu'après une tâche     */
/* COMPLETED réelle (artefacts déclarés par le fournisseur).          */
/* ------------------------------------------------------------------ */

const EXPORT_TTL_MS = Number.parseInt(process.env.TRAINING_EXPORT_TTL_MINUTES ?? "30", 10) * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

async function buildZip(entries: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  const { Writable } = await import("node:stream");
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const archive = archiver("zip", { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    sink.on("finish", () => resolve());
    sink.on("error", reject);
    archive.on("error", reject);
  });
  archive.pipe(sink);
  for (const entry of entries) {
    archive.append(entry.content, { name: entry.name });
  }
  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}

/**
 * Prépare un export pour un projet.
 * kinds :
 *  - dataset-archive : ZIP de tous les datasets valides du projet ;
 *  - model-files     : ZIP des fichiers modèle téléversés (tels qu'importés) ;
 *  - plan-config     : configuration JSON du dernier plan (reproductibilité).
 */
export async function prepareExport(
  uid: string,
  projectId: string,
  kind: ExportArtifact["kind"],
): Promise<{ ok: true; artifact: ExportArtifact } | { ok: false; error: string }> {
  const overview = await getProjectOverview(uid, projectId);
  if (!overview) return { ok: false, error: "Projet introuvable." };

  let entries: Array<{ name: string; content: Buffer }> = [];
  let label = "";

  if (kind === "dataset-archive") {
    const valid = overview.datasets.filter((d) => d.status === "valid");
    if (valid.length === 0) return { ok: false, error: "Aucun dataset valide à exporter." };
    for (const dataset of valid) {
      try {
        const content = await downloadFromR2(dataset.storageKey, 512 * 1024 * 1024);
        entries.push({ name: `${dataset.split}-${dataset.name}`, content });
      } catch {
        return { ok: false, error: `Dataset ${dataset.name} illisible dans le stockage : export annulé.` };
      }
    }
    label = `datasets-${overview.project.name}`;
  } else if (kind === "model-files") {
    const uploaded = overview.models.filter((m) => m.source === "upload" && m.storageKey);
    if (uploaded.length === 0) return { ok: false, error: "Aucun fichier modèle téléversé à exporter." };
    for (const model of uploaded) {
      try {
        const content = await downloadFromR2(model.storageKey as string, 512 * 1024 * 1024);
        entries.push({ name: model.name, content });
      } catch {
        return { ok: false, error: `Fichier modèle ${model.name} illisible : export annulé.` };
      }
    }
    label = `modeles-${overview.project.name}`;
  } else if (kind === "trained-model") {
    // Modèles ENTRAÎNÉS : artefacts réellement produits par des tâches
    // complétées (ex. cerveau Gen3 du moteur gen3-native). Vide sans tâche
    // complétée — aucun modèle fictif n'est jamais exporté.
    const completes = overview.jobs.filter((j) => j.status === "completed" && j.artifacts.length > 0);
    if (completes.length === 0) {
      return { ok: false, error: "Aucun modèle entraîné : les artefacts apparaissent après une tâche complétée réellement." };
    }
    for (const job of completes) {
      for (const artefact of job.artifacts) {
        try {
          const content = await downloadFromR2(artefact.storageKey, 512 * 1024 * 1024);
          entries.push({ name: `${job.id}-${artefact.label || "modele"}.json`, content });
        } catch {
          return { ok: false, error: `Artefact ${artefact.label || artefact.storageKey} illisible : export annulé.` };
        }
      }
    }
    label = `modeles-entraines-${overview.project.name}`;
  } else {
    const plan = overview.plans.find((p) => p.status === "accepted") ?? overview.plans[0];
    if (!plan) return { ok: false, error: "Aucun plan à exporter." };
    entries = [
      {
        name: "plan.json",
        content: Buffer.from(
          JSON.stringify(
            {
              projet: overview.project.name,
              genereLe: plan.createdAt,
              source: plan.generatedBy,
              methode: plan.method,
              moteur: plan.engineId,
              modeleDeBase: plan.baseModel,
              parametres: plan.parameters,
              criteresEvaluation: plan.evaluationCriteria,
            },
            null,
            2,
          ),
          "utf8",
        ),
      },
    ];
    label = `plan-${overview.project.name}`;
  }

  const zip = await buildZip(entries);
  const exportId = newUlid();
  const storageKey = `${userDir(uid, "training-exports", projectId)}/${exportId}.zip`;
  await putObject({ key: storageKey, body: zip, contentType: "application/zip", contentLength: zip.byteLength });

  const artifact = exportArtifactSchema.parse({
    id: exportId,
    projectId,
    ownerId: uid,
    kind,
    label,
    storageKey,
    sizeBytes: zip.byteLength,
    expiresAt: new Date(Date.now() + (Number.isFinite(EXPORT_TTL_MS) ? EXPORT_TTL_MS : 30 * 60_000)).toISOString(),
    createdAt: nowIso(),
  });

  const { saveExport } = await import("./repository");
  await saveExport(uid, artifact);
  return { ok: true, artifact };
}

/** Génère l'URL signée temporaire d'un export non expiré. */
export async function exportDownloadUrl(uid: string, projectId: string, exportId: string): Promise<
  { ok: true; url: string } | { ok: false; error: string; status: number }
> {
  const { getExport } = await import("./repository");
  const artifact = await getExport(uid, projectId, exportId);
  if (!artifact) return { ok: false, error: "Export introuvable.", status: 404 };
  if (new Date(artifact.expiresAt).getTime() < Date.now()) {
    return { ok: false, error: "Ce lien d'export a expiré : préparez un nouvel export.", status: 410 };
  }
  try {
    const url = await createDownloadUrl(artifact.storageKey, 600);
    return { ok: true, url };
  } catch {
    return { ok: false, error: "Fichier d'export momentanément indisponible.", status: 503 };
  }
}
