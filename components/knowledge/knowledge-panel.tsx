"use client";

import * as React from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/states";
import { Field, Input, Select } from "@/components/ui/field";

/**
 * Knowledge Spaces — interface d'ingestion et de gestion RAG.
 * Les documents ingérés (fichiers ou URLs) sont indexés (chunks +
 * embeddings Qdrant) et consultables par les agents via l'outil
 * `knowledge.search`, scopés par projet.
 */

interface KnowledgeDocument {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  source: "upload" | "url";
  charCount: number;
  chunkCount: number;
  status: "indexed" | "empty" | string;
  createdAt: string;
  lastError?: string;
}

interface ProjectSummary {
  id: string;
  name: string;
}

const ACCEPTED = ".txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.docx,.log,.xml,.yml,.yaml";

export function KnowledgePanel() {
  const [documents, setDocuments] = React.useState<KnowledgeDocument[]>([]);
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [busyUrl, setBusyUrl] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    setError("");
    try {
      const [docsResponse, projectsResponse] = await Promise.all([
        authFetch("/api/knowledge"),
        authFetch("/api/workspace/projects"),
      ]);
      const docsData = await docsResponse.json().catch(() => ({}));
      const projectsData = await projectsResponse.json().catch(() => ({}));
      if (docsResponse.ok) setDocuments((docsData.documents ?? []) as KnowledgeDocument[]);
      if (projectsResponse.ok) {
        const list = ((projectsData.projects ?? []) as Array<{ id: string; name: string }>);
        setProjects(list);
        setProjectId((current) => current || list[0]?.id || "");
      }
    } catch {
      setError("Chargement des documents impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (!projectId) {
      setError("Créez d'abord un projet : chaque base de connaissances est rattachée à un projet.");
      return;
    }
    setError("");
    setNotice("");
    setUploading(true);
    try {
      const form = new FormData();
      Array.from(files).forEach((file) => form.append("files", file));
      form.append("projectId", projectId);
      const response = await authFetch("/api/knowledge", { method: "POST", body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Téléversement impossible.");
      const results = (data.results ?? []) as Array<{ name: string; status: string; chunkCount?: number; error?: string }>;
      const failures = results.filter((result) => result.status === "failed");
      const indexed = results.filter((result) => result.status !== "failed");
      if (failures.length > 0) {
        setNotice(`${indexed.length} document(s) indexé(s), ${failures.length} en échec : ${failures.map((f) => `${f.name} — ${f.error}`).join(" · ")}`);
      } else {
        setNotice(`${indexed.length} document(s) indexé(s) (${indexed.reduce((total, result) => total + (result.chunkCount ?? 0), 0)} fragments au total).`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Téléversement impossible.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addUrl = async () => {
    if (!url.trim()) return;
    if (!projectId) {
      setError("Créez d'abord un projet : chaque base de connaissances est rattachée à un projet.");
      return;
    }
    setError("");
    setNotice("");
    setBusyUrl(true);
    try {
      const response = await authFetch("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), projectId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Ingestion de l'URL impossible.");
      setNotice(`Page indexée : ${data.document?.chunkCount ?? 0} fragments.`);
      setUrl("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ingestion de l'URL impossible.");
    } finally {
      setBusyUrl(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      const response = await authFetch(`/api/knowledge?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "Suppression impossible.");
      }
      setDocuments((current) => current.filter((document) => document.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression impossible.");
    }
  };

  const projectName = (id: string) => projects.find((project) => project.id === id)?.name ?? id;

  return (
    <div className="space-y-5">
      <div className="g3-card p-5 md:p-6">
        <h2 className="text-lg font-bold md:text-xl">Bases de connaissances</h2>
        <p className="mt-1 max-w-3xl text-sm leading-6" style={{ color: "var(--g3-muted)" }}>
          Importez vos documents et pages web : Gen3ia les découpe en fragments, génère les embeddings et les rend
          consultables par vos agents (outil <code className="rounded px-1 py-0.5 text-xs" style={{ background: "var(--g3-elevated)" }}>knowledge.search</code>),
          toujours limités au projet sélectionné.
        </p>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Field label="Projet de la base de connaissances" htmlFor="knowledge-project">
            <Select id="knowledge-project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.length === 0 && <option value="">Aucun projet — créez-en un dans « Projets »</option>}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Ajouter une page web" htmlFor="knowledge-url" hint="Page HTML ou texte public — la récupération est protégée contre les adresses internes.">
            <div className="flex gap-2">
              <Input
                id="knowledge-url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://exemple.com/documentation…"
                inputMode="url"
              />
              <button type="button" className="g3-btn g3-btn-ghost shrink-0" onClick={() => void addUrl()} disabled={busyUrl || !url.trim() || !projectId}>
                {busyUrl ? "Indexation…" : "Indexer"}
              </button>
            </div>
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED}
            className="hidden"
            onChange={(event) => void uploadFiles(event.target.files)}
            aria-label="Téléverser des documents"
          />
          <button
            type="button"
            className="g3-btn g3-btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Indexation en cours…" : "Téléverser des documents"}
          </button>
          <span className="text-xs" style={{ color: "var(--g3-faint)" }}>
            TXT · Markdown · CSV · JSON · HTML · DOCX — 20 Mo max par fichier
          </span>
        </div>

        {notice && <Callout tone="success" className="mt-4 rounded-2xl">{notice}</Callout>}
        {error && <Callout tone="error" className="mt-4 rounded-2xl">{error}</Callout>}
      </div>

      <div className="g3-card overflow-hidden">
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--g3-border)" }}>
          <h3 className="text-sm font-bold">Documents indexés</h3>
          <Badge tone="neutral">{documents.length}</Badge>
        </div>
        {loading ? (
          <div className="px-5 py-10 text-center text-sm" style={{ color: "var(--g3-faint)" }}>Chargement…</div>
        ) : documents.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon="▤"
              title="Aucune base de connaissances pour le moment"
              description="Téléversez vos documents ou indexez une page web : vos agents pourront s'appuyer sur ce contenu dans leurs réponses."
            />
          </div>
        ) : (
          <ul>
            {documents.map((document) => (
              <li key={document.id} className="flex items-center justify-between gap-4 border-b px-5 py-3.5 last:border-b-0" style={{ borderColor: "var(--g3-border)" }}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold" style={{ color: "var(--g3-text)" }}>{document.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" style={{ color: "var(--g3-muted)" }}>
                    <span>{projectName(document.projectId)}</span>
                    <span>{document.source === "url" ? "Page web" : "Fichier"}</span>
                    <span>{(document.charCount ?? 0).toLocaleString("fr-FR")} caractères</span>
                    <span>{document.chunkCount} fragments</span>
                    {document.status !== "indexed" && <Badge tone="warning">{document.status === "empty" ? "Vide" : document.status}</Badge>}
                  </p>
                  {document.lastError && (
                    <p className="mt-1 text-xs" style={{ color: "var(--g3-danger-strong)" }}>{document.lastError}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={document.status === "indexed" && document.chunkCount > 0 ? "success" : "warning"}>
                    {document.status === "indexed" && document.chunkCount > 0 ? "Indexé" : "À vérifier"}
                  </Badge>
                  <button
                    type="button"
                    className="g3-btn g3-btn-danger !px-3 !py-1.5 text-xs"
                    onClick={() => void remove(document.id)}
                    aria-label={`Supprimer ${document.name}`}
                  >
                    Supprimer
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
