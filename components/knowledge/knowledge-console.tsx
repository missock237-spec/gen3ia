"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";

/**
 * Connaissances — espace Knowledge Spaces (LOT 6 du plan plateforme).
 *
 * La bibliothèque RAG du projet : liste des documents indexés, import de
 * fichiers réels (TXT/MD/CSV/JSON/HTML/DOCX — extraction, chunking et
 * miroir Qdrant côté serveur) et ajout d'une page web (garde SSRF
 * serveur). Les documents sont scopés par projet : l'outil
 * `knowledge.search` de l'agent ne retrouve que les documents du projet
 * courant (isolation stricte).
 *
 * Conventions du fichier : authFetch same-origin (cookie gen3ia_session),
 * états honnêtes (401 connexion, 429 patientez, échec réseau affiché).
 */

interface TrainingProject {
  id: string;
  name: string;
  family: string;
  updatedAt: string;
}

interface KnowledgeDocument {
  id: string;
  projectId: string;
  name: string;
  mimeType: string;
  source: "upload" | "url";
  charCount: number;
  chunkCount: number;
  status: "indexed" | "empty";
  createdAt: string;
}

interface ResultatImport {
  name: string;
  status: "indexed" | "empty" | "failed";
  documentId?: string;
  chunkCount?: number;
  error?: string;
}

const formatDateFr = (iso?: string | null): string => {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className ?? "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
      {label}
    </span>
  );
}

export function KnowledgeConsole() {
  const sessionDisponible = useSessionAvailable();

  const [projects, setProjects] = useState<TrainingProject[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Import fichiers + URL
  const [files, setFiles] = useState<FileList | null>(null);
  const [url, setUrl] = useState("");
  const [results, setResults] = useState<ResultatImport[] | null>(null);
  const fichierRef = useRef<HTMLInputElement | null>(null);

  const chargerProjets = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await authFetch("/api/training/projects", { cache: "no-store" });
      if (response.ok) {
        const data = await readJsonSafely<{ projects?: TrainingProject[] }>(response);
        const list = data?.projects ?? [];
        setProjects(list);
        setSelectedProject((current) => current || list[0]?.id || "");
      } else if (response.status !== 401) {
        setLoadError("Impossible de charger vos projets.");
      }
    } catch {
      setLoadError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
    } finally {
      setLoaded(true);
    }
  }, []);

  const chargerDocuments = useCallback(async (projectId: string) => {
    if (!projectId) { setDocuments([]); return; }
    setBusy(true);
    try {
      const response = await authFetch(`/api/knowledge?projectId=${projectId}`, { cache: "no-store" });
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (response.ok) {
        const data = await readJsonSafely<{ documents?: KnowledgeDocument[] }>(response);
        setDocuments(data?.documents ?? []);
      } else if (response.status !== 401) {
        setActionError("Impossible de charger les documents de ce projet.");
      }
    } catch {
      setActionError("Connexion au serveur impossible. Réessayez.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void chargerProjets();
  }, [sessionDisponible, chargerProjets]);

  useEffect(() => {
    if (selectedProject) void chargerDocuments(selectedProject);
  }, [selectedProject, chargerDocuments]);

  /* Ingestion RAG réelle — POST /api/knowledge (multipart) : extraction,
   * chunking et indexation côté serveur, résultats par fichier restitués
   * tels quels (indexed / empty / failed). À la demande : le rate-limit
   * 30/h de la porte reste disponible. */
  const importerFichiers = async () => {
    if (!selectedProject || !files || files.length === 0 || busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setResults(null);
    try {
      const form = new FormData();
      form.append("projectId", selectedProject);
      Array.from(files).slice(0, 10).forEach((file) => form.append("files", file));
      const response = await authFetch("/api/knowledge", { method: "POST", body: form }, { timeoutMs: 180_000 });
      const data = await readJsonSafely<{ results?: ResultatImport[]; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (response.status === 429) {
        setActionError(data?.error ?? "Trop de téléversements. Réessayez dans un instant.");
        return;
      }
      if (!response.ok || !data?.results) {
        throw new Error(data?.error ?? `L'import a échoué (erreur ${response.status}).`);
      }
      setResults(data.results);
      setFiles(null);
      if (fichierRef.current) fichierRef.current.value = "";
      const indexes = data.results.filter((resultat) => resultat.status === "indexed").length;
      setNotice(`${indexes} document${indexes > 1 ? "s" : ""} indexé${indexes > 1 ? "s" : ""} sur ${data.results.length} — l'agent y accède via l'outil knowledge.search du projet.`);
      await chargerDocuments(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'import des documents a échoué.");
    } finally {
      setBusy(false);
    }
  };

  /* Ingestion par URL — POST /api/knowledge (JSON) : la page est
   * téléchargée côté serveur (garde SSRF) puis convertie en texte. */
  const importerUrl = async () => {
    if (!selectedProject || !url.trim() || busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    setResults(null);
    try {
      const response = await authFetch("/api/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), projectId: selectedProject }),
      });
      const data = await readJsonSafely<{ document?: KnowledgeDocument; error?: string }>(response);
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (response.status === 429) {
        setActionError(data?.error ?? "Trop de téléversements. Réessayez dans un instant.");
        return;
      }
      if (!response.ok || !data?.document) {
        throw new Error(data?.error ?? `L'ajout de la page a échoué (erreur ${response.status}).`);
      }
      setNotice(`Page « ${data.document.name} » extraite et indexée : ${data.document.chunkCount} fragment${data.document.chunkCount > 1 ? "s" : ""} ajouté${data.document.chunkCount > 1 ? "s" : ""} à la base du projet.`);
      setUrl("");
      await chargerDocuments(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "L'ajout de la page a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const supprimerDocument = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch(`/api/knowledge?id=${id}`, { method: "DELETE" });
      if (response.status === 401) {
        setActionError("Connectez-vous pour gérer vos connaissances.");
        return;
      }
      if (!response.ok) {
        const data = await readJsonSafely<{ error?: string }>(response);
        throw new Error(data?.error ?? `La suppression a échoué (erreur ${response.status}).`);
      }
      setNotice("Document supprimé : fragments et miroir vectoriel retirés.");
      await chargerDocuments(selectedProject);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La suppression a échoué.");
    } finally {
      setBusy(false);
    }
  };

  const projetActif = projects.find((project) => project.id === selectedProject);

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6">
      <SectionHeader
        eyebrow="GEN3IA · CONNAISSANCES"
        title="Espace"
        highlight="connaissances"
        description="La bibliothèque RAG de vos projets : importez des documents réels (fichiers ou pages web), ils sont extraits, découpés et indexés — l'agent les retrouve via l'outil knowledge.search du projet courant."
      />

      {notice && (
        <p className="mb-4 rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <div className="mb-4 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {actionError}
          <button type="button" onClick={() => selectedProject ? void chargerDocuments(selectedProject) : void chargerProjets()} className="ml-3 underline underline-offset-2">
            Réessayer
          </button>
        </div>
      )}

      {sessionDisponible === false ? (
        <EmptyState
          icon="❑"
          title="Connectez-vous pour gérer vos connaissances"
          description="Vos documents restent privés : ils sont scopés par compte ET par projet, et seuls les agents du projet peuvent les consulter."
          action={
            <a href="/login" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Se connecter
            </a>
          }
        />
      ) : !loaded ? (
        <LoadingState label="Chargement de l'espace connaissances…" rows={3} />
      ) : loadError && projects.length === 0 ? (
        <EmptyState
          icon="⚠"
          title="Projets indisponibles"
          description={loadError}
          action={
            <button type="button" onClick={() => void chargerProjets()} className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-5 py-2.5 text-sm font-semibold">
              Réessayer
            </button>
          }
        />
      ) : projects.length === 0 ? (
        <EmptyState
          icon="❑"
          title="Aucun projet d'entraînement"
          description="La base de connaissances se rattache à un projet : créez d'abord votre projet dans le Laboratoire de modèles."
          action={
            <a href="/lab" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Ouvrir le Laboratoire →
            </a>
          }
        />
      ) : (
        <div className="space-y-5">
          {/* Sélecteur de projet */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
              Projet
              <select
                value={selectedProject}
                onChange={(event) => setSelectedProject(event.target.value)}
                className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)] sm:max-w-md"
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            {projetActif && (
              <p className="mt-2 text-xs text-[var(--g3-faint)]">
                {documents.length} document{documents.length > 1 ? "s" : ""} indexé{documents.length > 1 ? "s" : ""} pour ce projet · l&apos;outil knowledge.search de l&apos;agent les consulte pendant les conversations.
              </p>
            )}
          </section>

          {/* Import fichiers */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Importer des documents</h3>
            <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
              Formats acceptés : txt, md, csv, json, html, docx. L&apos;extraction du texte, le découpage en fragments et l&apos;indexation vectorielle sont réellement effectués côté serveur.
            </p>
            <form
              className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]"
              onSubmit={(event) => { event.preventDefault(); void importerFichiers(); }}
            >
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Fichiers (10 maximum par lot)
                <input
                  ref={fichierRef}
                  type="file"
                  multiple
                  accept=".txt,.md,.csv,.json,.html,.docx"
                  onChange={(event) => setFiles(event.target.files)}
                  className="mt-1.5 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-2.5 text-sm text-[var(--g3-text)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--g3-primary-soft)] file:px-3.5 file:py-1.5 file:text-xs file:font-semibold file:text-[var(--g3-primary-strong)]"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={busy || !files || files.length === 0}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50 sm:w-auto"
                >
                  {busy ? "Import…" : "Importer et indexer"}
                </button>
              </div>
            </form>

            {results && results.length > 0 && (
              <ul className="mt-3 space-y-1 text-xs">
                {results.map((resultat, index) => (
                  <li key={index} className={resultat.status === "failed" ? "text-[var(--g3-danger-strong)]" : "text-[var(--g3-muted)]"}>
                    {resultat.status === "indexed"
                      ? `✓ ${resultat.name} — indexé · ${resultat.chunkCount ?? "?"} fragment${resultat.chunkCount === 1 ? "" : "s"}`
                      : resultat.status === "empty"
                        ? `○ ${resultat.name} — vide (aucun texte extrait)`
                        : `✕ ${resultat.name} — échec : ${resultat.error ?? "ingestion impossible"}`}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Import par URL */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Ajouter une page web</h3>
            <p className="mt-1.5 text-sm text-[var(--g3-muted)]">
              La page est téléchargée puis convertie en texte côté serveur (protection SSRF) — seule la page fournie est consultée, jamais de navigation automatique.
            </p>
            <form
              className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto]"
              onSubmit={(event) => { event.preventDefault(); void importerUrl(); }}
            >
              <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
                Adresse de la page
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="adresse complète de la page à indexer"
                  maxLength={2000}
                  className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
                />
              </label>
              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={busy || !url.trim()}
                  className="inline-flex min-h-11 w-full items-center justify-center rounded-full border border-[var(--g3-border)] px-6 py-2.5 text-sm font-semibold transition enabled:hover:border-[var(--g3-primary-border)] disabled:opacity-50 sm:w-auto"
                >
                  {busy ? "Extraction…" : "Extraire et indexer"}
                </button>
              </div>
            </form>
          </section>

          {/* Liste des documents */}
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <h3 className="font-semibold text-[var(--g3-text)]">Documents du projet{projetActif ? ` : ${projetActif.name}` : ""}</h3>
            {busy && documents.length === 0 ? (
              <LoadingState label="Chargement des documents…" rows={2} />
            ) : documents.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucun document pour ce projet : importez un fichier ou ajoutez une page web pour alimenter l&apos;agent.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {documents.map((doc) => (
                  <li key={doc.id} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-semibold text-[var(--g3-text)]">{doc.name}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge label={doc.source === "url" ? "Page web" : "Fichier"} />
                        <Badge
                          label={doc.status === "indexed" ? "Indexé" : "Vide"}
                          className={doc.status === "indexed" ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]"}
                        />
                        <button
                          type="button"
                          onClick={() => void supprimerDocument(doc.id)}
                          disabled={busy}
                          className="inline-flex min-h-9 items-center rounded-full border border-[var(--g3-border)] px-4 py-1.5 text-xs font-semibold transition enabled:hover:border-[var(--g3-danger-soft)] disabled:opacity-50"
                        >
                          Supprimer
                        </button>
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-[var(--g3-muted)]">
                      {doc.mimeType} · {doc.charCount} caractères · {doc.chunkCount} fragment{doc.chunkCount > 1 ? "s" : ""}
                      {` · ajouté ${formatDateFr(doc.createdAt)}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
