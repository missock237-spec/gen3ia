"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { authFetch } from "@/lib/firebase/auth-client";
import { ArtifactPanel } from "@/components/workspace/artifact-panel";
import { formatRelative } from "@/components/workspace/labels";
import type { Conversation, ConversationArtifact } from "@/lib/domain/conversations/types";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * /workspace/projects/[projectId] — détail d'un projet : instructions
 * persistantes (injectées dans chaque conversation), connecteurs autorisés,
 * règles de confidentialité, conversations rattachées et artefacts produits.
 */

type Tab = "instructions" | "conversations" | "artifacts" | "settings";

export default function ProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const projectId = params.projectId;

  const [project, setProject] = useState<WorkspaceProject | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [artifacts, setArtifacts] = useState<ConversationArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>("instructions");

  // Formulaires d'édition
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [privacyRules, setPrivacyRules] = useState("");
  const [connectorsText, setConnectorsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const [projectRes, conversationsRes, artifactsRes] = await Promise.allSettled([
        authFetch(`/api/workspace/projects/${projectId}`, { cache: "no-store" }),
        authFetch(`/api/workspace/conversations?projectId=${encodeURIComponent(projectId)}&limit=30`, { cache: "no-store" }),
        authFetch(`/api/workspace/artifacts?projectId=${encodeURIComponent(projectId)}&limit=100`, { cache: "no-store" }),
      ]);
      if (projectRes.status === "fulfilled" && projectRes.value.ok) {
        const data = (await projectRes.value.json()) as { project: WorkspaceProject };
        setProject(data.project);
        setName(data.project.name);
        setDescription(data.project.description ?? "");
        setInstructions(data.project.instructions ?? "");
        setPrivacyRules(data.project.privacyRules ?? "");
        setConnectorsText(data.project.authorizedConnectors.join(", "));
      } else if (projectRes.status === "fulfilled" && projectRes.value.status === 404) {
        setNotFound(true);
      }
      if (conversationsRes.status === "fulfilled" && conversationsRes.value.ok) {
        const data = (await conversationsRes.value.json()) as { conversations: Conversation[] };
        setConversations(data.conversations);
      }
      if (artifactsRes.status === "fulfilled" && artifactsRes.value.ok) {
        const data = (await artifactsRes.value.json()) as { artifacts: ConversationArtifact[] };
        setArtifacts(data.artifacts);
      }
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setSavedNote("");
    setError("");
    try {
      const response = await authFetch(`/api/workspace/projects/${projectId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          instructions: instructions.trim(),
          privacyRules: privacyRules.trim(),
          authorizedConnectors: connectorsText
            .split(",")
            .map((x) => x.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 64),
        }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Enregistrement impossible.");
      }
      const data = (await response.json()) as { project: WorkspaceProject };
      setProject(data.project);
      setSavedNote("Projet enregistré ✓");
      setTimeout(() => setSavedNote(""), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enregistrement impossible.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm("Supprimer ce projet ? Les conversations rattachées seront conservées, sans projet.")) return;
    const response = await authFetch(`/api/workspace/projects/${projectId}`, { method: "DELETE" });
    if (response.ok) router.push("/workspace/projects");
  };

  if (loading) return <LoadingState label="Chargement du projet…" />;
  if (notFound || !project) {
    return (
      <EmptyState
        icon="▦"
        title="Projet introuvable"
        description="Ce projet n'existe pas ou n'appartient pas à votre compte."
        action={<Link href="/workspace/projects" className="g3-btn g3-btn-ghost text-xs">← Tous les projets</Link>}
      />
    );
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="PROJET"
        title={project.name}
        description={project.description || "Contexte persistant : instructions, connecteurs autorisés, confidentialité, conversations et livrables."}
        action={
          <Link href="/workspace/projects" className="g3-btn g3-btn-ghost text-xs">
            ← Projets
          </Link>
        }
      />

      <div className="g3-tabs" role="tablist">
        {(
          [
            { id: "instructions", label: "Instructions" },
            { id: "conversations", label: `Conversations (${conversations.length})` },
            { id: "artifacts", label: `Livrables (${artifacts.length})` },
            { id: "settings", label: "Paramètres" },
          ] as Array<{ id: Tab; label: string }>
        ).map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} data-active={tab === t.id} onClick={() => setTab(t.id)} className="g3-tab text-xs">
            {t.label}
          </button>
        ))}
      </div>

      {tab === "instructions" && (
        <div className="g3-card space-y-4 !p-4">
          <div>
            <label htmlFor="project-instructions" className="g3-label">Instructions persistantes</label>
            <p className="mb-1.5 text-[11px] text-neutral-500">
              Injectées dans chaque conversation du projet : ton, contexte, format attendu, contraintes.
            </p>
            <textarea
              id="project-instructions"
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              rows={7}
              maxLength={8000}
              placeholder="Ex. : Tu travailles pour une PME B2B française. Ton professionnel et concis. Les prix sont en euros HT…"
              className="g3-textarea text-sm"
            />
          </div>
          <div>
            <label htmlFor="project-privacy" className="g3-label">Règles de confidentialité</label>
            <p className="mb-1.5 text-[11px] text-neutral-500">
              Impératives pour l&apos;agent dans ce projet : données à ne jamais citer, périmètre autorisé.
            </p>
            <textarea
              id="project-privacy"
              value={privacyRules}
              onChange={(event) => setPrivacyRules(event.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="Ex. : Ne jamais mentionner le nom des clients ni les montants exacts hors de ce projet."
              className="g3-textarea text-sm"
            />
          </div>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void save()} disabled={saving} className="g3-btn g3-btn-primary text-xs">
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
            {savedNote && <span className="text-xs text-emerald-700">{savedNote}</span>}
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </div>
      )}

      {tab === "conversations" && (
        conversations.length === 0 ? (
          <EmptyState
            icon="✦"
            title="Aucune conversation dans ce projet"
            description="Démarrez une conversation en sélectionnant ce projet dans le composer, ou depuis la Bibliothèque."
            action={<Link href="/workspace" className="g3-btn g3-btn-primary text-xs">Nouvelle conversation</Link>}
          />
        ) : (
          <ul className="grid grid-cols-1 gap-2 md:grid-cols-2" role="list">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <Link href={`/workspace/conversations/${conversation.id}`} className="g3-card block !p-3 transition-colors hover:border-neutral-400">
                  <p className="truncate text-xs font-semibold text-neutral-800">{conversation.title || "Sans titre"}</p>
                  <p className="mt-0.5 text-[10px] text-neutral-500">
                    {conversation.messageCount} message(s) · {formatRelative(conversation.updatedAt)}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )
      )}

      {tab === "artifacts" && <ArtifactPanel artifacts={artifacts} />}

      {tab === "settings" && (
        <div className="g3-card space-y-4 !p-4">
          <div>
            <label htmlFor="project-name" className="g3-label">Nom</label>
            <input id="project-name" value={name} onChange={(event) => setName(event.target.value)} className="g3-input text-sm" maxLength={120} />
          </div>
          <div>
            <label htmlFor="project-description" className="g3-label">Description</label>
            <input id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} className="g3-input text-sm" maxLength={600} />
          </div>
          <div>
            <label htmlFor="project-connectors" className="g3-label">Connecteurs autorisés</label>
            <p className="mb-1.5 text-[11px] text-neutral-500">
              Slugs séparés par des virgules (ex. : gmail, googledrive, notion). L&apos;agent ne mobilisera dans ce projet que ces connecteurs.
            </p>
            <input id="project-connectors" value={connectorsText} onChange={(event) => setConnectorsText(event.target.value)} className="g3-input text-sm" placeholder="gmail, googledrive, notion" />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void save()} disabled={saving} className="g3-btn g3-btn-primary text-xs">
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
            {savedNote && <span className="text-xs text-emerald-700">{savedNote}</span>}
          </div>
          <div className="border-t border-neutral-100 pt-3">
            <button type="button" onClick={() => void remove()} className="g3-btn g3-btn-danger text-xs">
              Supprimer le projet
            </button>
            <p className="mt-1.5 text-[10px] text-neutral-500">Les conversations rattachées sont conservées (détachées), aucun contenu n&apos;est détruit.</p>
          </div>
        </div>
      )}
    </div>
  );
}
