"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { SectionHeader } from "@/components/shells/section-header";
import { LoadingState, EmptyState } from "@/components/shells/states";
import { authFetch } from "@/lib/firebase/auth-client";
import { ArtifactPanel } from "@/components/workspace/artifact-panel";
import { ARTIFACT_TYPE_LABELS, formatRelative } from "@/components/workspace/labels";
import type { ConversationArtifact } from "@/lib/domain/conversations/types";

/**
 * /workspace/files — Fichiers et livrables : d'un côté les artefacts
 * standardisés produits par les conversations (code, documents, tableaux,
 * images, rapports), de l'autre le stockage permanent (fichiers uploadés
 * et livrables signés).
 */

interface PermanentFile {
  path: string;
  filename: string;
  sizeBytes?: number;
  contentType?: string;
  uploadedAt?: string;
}

export default function WorkspaceFilesPage() {
  const [artifacts, setArtifacts] = useState<ConversationArtifact[]>([]);
  const [files, setFiles] = useState<PermanentFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [artifactsRes, filesRes] = await Promise.allSettled([
        authFetch("/api/workspace/artifacts?limit=100", { cache: "no-store" }),
        authFetch("/api/storage/permanent", { cache: "no-store" }),
      ]);
      if (artifactsRes.status === "fulfilled" && artifactsRes.value.ok) {
        const data = (await artifactsRes.value.json()) as { artifacts: ConversationArtifact[] };
        setArtifacts(data.artifacts);
      }
      if (filesRes.status === "fulfilled" && filesRes.value.ok) {
        const data = (await filesRes.value.json()) as { files: PermanentFile[] };
        setFiles(data.files);
      }
      if (artifactsRes.status === "rejected" && filesRes.status === "rejected") {
        setError("Chargement impossible pour le moment.");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const resolveFileUrl = useCallback(async (path: string) => {
    const response = await authFetch(`/api/storage/permanent?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error("Lien indisponible.");
    const data = (await response.json()) as { url: string };
    return data.url;
  }, []);

  const downloadFile = async (path: string) => {
    try {
      const url = await resolveFileUrl(path);
      window.open(url, "_blank", "noopener");
    } catch {
      setError("Lien de téléchargement indisponible.");
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL"
        title="Fichiers"
        highlight="& livrables"
        description="Tous vos livrables au même endroit : artefacts produits dans les conversations (documents, code, images, rapports, tableaux) et fichiers de votre stockage permanent."
      />

      {loading ? (
        <LoadingState label="Chargement des fichiers et livrables…" />
      ) : error ? (
        <EmptyState icon="⚠" title="Erreur" description={error} />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--g3-text)]">
              Artefacts de conversation <span className="text-xs font-normal text-[var(--g3-muted)]">({artifacts.length})</span>
            </h2>
            <ArtifactPanel artifacts={artifacts} resolveFileUrl={resolveFileUrl} />
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-[var(--g3-text)]">
              Stockage permanent <span className="text-xs font-normal text-[var(--g3-muted)]">({files.length} fichiers)</span>
            </h2>
            {files.length === 0 ? (
              <EmptyState
                icon="□"
                title="Aucun fichier permanent"
                description="Les fichiers joints dans vos conversations et vos livrables téléchargeables sont conservés ici, avec des liens signés."
              />
            ) : (
              <ul className="grid grid-cols-1 gap-2 md:grid-cols-2" role="list">
                {files.map((file) => (
                  <li key={file.path} className="g3-card flex items-center justify-between gap-3 !p-3">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-semibold text-[var(--g3-text)]" title={file.filename}>
                        □ {file.filename}
                      </p>
                      <p className="text-[10px] text-[var(--g3-muted)]">
                        {file.contentType ?? "fichier"}
                        {file.sizeBytes ? ` · ${file.sizeBytes} o` : ""}
                        {file.uploadedAt ? ` · ${formatRelative(file.uploadedAt)}` : ""}
                      </p>
                    </div>
                    <button type="button" onClick={() => void downloadFile(file.path)} className="g3-btn g3-btn-ghost shrink-0 !min-h-0 !px-2.5 !py-1 text-[11px]">
                      Ouvrir
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-[var(--g3-muted)]">
              Besoin de stockage structuré ? <Link href="/storage" className="underline underline-offset-2">Ouvrir le stockage complet →</Link>
            </p>
          </section>
        </>
      )}
    </div>
  );
}
