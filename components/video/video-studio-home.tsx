"use client";

/**
 * STUDIO VIDÉO — GEN3IA VIDEO AGENT (Task 79).
 *
 * Liste des productions + création via la demande libre adressée au
 * Directeur de production. Chaque production est un projet persistant
 * (brouillon, reprise, versions, rendu arrière-plan).
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { StudioHeader } from "@/components/studio/studio-header";
import { Callout } from "@/components/studio/callout";
import type { VideoProject } from "@/lib/video/types";
import { saveLocalFile } from "@/lib/storage/local-file-store";


const STATUS_LABELS: Record<string, string> = {
  draft: "Brouillon",
  planning: "Planifié",
  scripted: "Scénario prêt",
  storyboarded: "Storyboard prêt",
  assets_ready: "Assets prêts",
  rendering: "Rendu en cours",
  completed: "Terminé",
  failed: "Échec",
  archived: "Archivé",
};

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-neutral-200 text-neutral-700",
  planning: "bg-sky-100 text-sky-700",
  scripted: "bg-indigo-100 text-indigo-700",
  storyboarded: "bg-violet-100 text-violet-700",
  assets_ready: "bg-amber-100 text-amber-700",
  rendering: "bg-blue-100 text-blue-700 animate-pulse",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-rose-100 text-rose-700",
  archived: "bg-neutral-100 text-neutral-500",
};

const TEMPLATES = [
  { label: "Documentaire YouTube 16:9", brief: "Crée une vidéo documentaire destinée à YouTube, format 16:9, style documentaire cinématographique, musique discrète, narration posée, sous-titres.", duration: 480, aspect: "16:9", res: "1080p" },
  { label: "Short TikTok/Reels 9:16", brief: "Crée un Short vertical 9:16 pour TikTok et Reels : rythme rapide, sous-titres gras centrés, musique énergique, hook dans les 2 premières secondes.", duration: 45, aspect: "9:16", res: "1080p" },
  { label: "Tutoriel explicatif", brief: "Crée une vidéo tutorielle claire et pédagogique, format 16:9, avec écrans de texte, transitions sobres et musique neutre.", duration: 300, aspect: "16:9", res: "1080p" },
  { label: "Publicité produit", brief: "Crée une publicité percutante pour un produit : 30 secondes, format 16:9, transitions dynamiques, effets sonores d'impact, CTA final.", duration: 30, aspect: "16:9", res: "1080p" },
];

export function VideoStudioHome() {
  const session = useSessionAvailable();
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localMedia, setLocalMedia] = useState<File[]>([]);

  const load = useCallback(async () => {
    try {
      const response = await authFetch("/api/video/projects");
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Chargement impossible");
      const data = (await response.json()) as { projects: VideoProject[] };
      setProjects(data.projects.filter((p) => p.status !== "archived"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session) void load();
  }, [session, load]);

  async function createProject(template?: (typeof TEMPLATES)[number]) {
    setCreating(true);
    setError(null);
    try {
      const chosen = template ?? null;
      const description = chosen ? chosen.brief : brief.trim();
      if (!description || description.length < 10) throw new Error("Décrivez votre vidéo en quelques mots (10 caractères minimum).");
      for (const file of localMedia) {
        const kind = file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : null;
        if (!kind) throw new Error(`Format non pris en charge : ${file.name}`);
        const allowed = {
          image: ["image/png", "image/jpeg", "image/webp"],
          video: ["video/mp4", "video/webm", "video/quicktime"],
          audio: ["audio/mpeg", "audio/mp4", "audio/wav", "audio/webm", "audio/ogg", "audio/opus", "audio/flac"],
        } as const;
        if (!allowed[kind].includes(file.type as never)) throw new Error(`Format non autorisé : ${file.name}`);
        const maxBytes = 50 * 1024 * 1024;
        if (file.size <= 0 || file.size > maxBytes) throw new Error(`Fichier trop volumineux : ${file.name} (maximum 50 Mo)`);
      }

      const createResponse = await authFetch("/api/video/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: description.slice(0, 80),
          description,
          targetDurationSec: chosen?.duration ?? 180,
          aspectRatio: chosen?.aspect ?? "16:9",
          resolution: chosen?.res ?? "1080p",
        }),
      });
      if (!createResponse.ok) throw new Error((await createResponse.json().catch(() => ({}))).error ?? "Création impossible");
      const { project } = (await createResponse.json()) as { project: VideoProject };
      await Promise.all(localMedia.map((file) => saveLocalFile(file, crypto.randomUUID(), project.id)));
      // Le Directeur planifie immédiatement à partir du brief.
      await authFetch(`/api/video/projects/${project.id}/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief: description }),
      }).catch(() => undefined);
      window.location.href = `/studio/video/${project.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
      setCreating(false);
    }
  }

  if (!session) {
    return (
      <div className="p-6">
        <StudioHeader eyebrow="Studio" title="Vidéo" description="Le studio de production vidéo par IA." />
        <Callout tone="info">Connectez-vous pour accéder à votre studio de production vidéo.</Callout>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <StudioHeader
        eyebrow="Studio"
        title="Agent Vidéo"
        description="Décrivez une vidéo : le Directeur de production écrit le scénario, génère les images et les voix, monte la timeline, rend le film et contrôle la qualité — jusqu'à la livraison."
      />

      {error ? <Callout tone="error">{error}</Callout> : null}

      {/* Création — demande libre au Directeur */}
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-4">
        <h2 className="text-lg font-semibold text-neutral-900">Nouvelle production</h2>
        <label className="block text-sm font-medium text-neutral-700">
          Médias locaux (stockés sur cet appareil)
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/ogg,audio/opus,audio/flac"
            onChange={(e) => setLocalMedia(Array.from(e.target.files ?? []))}
            className="mt-2 block w-full text-sm"
          />
          <span className="mt-1 block text-xs font-normal text-neutral-500">
            {localMedia.length ? `${localMedia.length} fichier(s) resteront sur cet appareil et seront associés au projet.` : "Aucun fichier importé. Les médias ne sont pas envoyés au serveur à cette étape."}
          </span>
        </label>

        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Ex. : Crée un documentaire de 30 minutes sur l'évolution de l'intelligence artificielle, destiné à YouTube, en français, style documentaire cinématographique. Utilise ma voix, ajoute une musique documentaire, des sous-titres et une introduction accrocheuse."
          rows={4}
          className="w-full rounded-xl border border-neutral-300 p-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              onClick={() => createProject(t)}
              disabled={creating}
              className="rounded-full border border-neutral-300 px-4 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50"
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={() => createProject()}
            disabled={creating || brief.trim().length < 10}
            className="ml-auto rounded-xl bg-blue-600 px-6 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? "Le Directeur planifie…" : "Lancer la production"}
          </button>
        </div>
      </section>

      {/* Liste des projets */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-neutral-900">Mes productions</h2>
        {loading ? (
          <p className="text-sm text-neutral-500">Chargement…</p>
        ) : projects.length === 0 ? (
          <p className="text-sm text-neutral-500">Aucune production pour le moment — lancez votre première vidéo ci-dessus.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/studio/video/${p.id}`}
                  className="block rounded-2xl border border-neutral-200 bg-white p-5 hover:border-blue-400 hover:shadow-sm transition"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_COLORS[p.status] ?? "bg-neutral-100"}`}>
                      {STATUS_LABELS[p.status] ?? p.status}
                    </span>
                    <span className="text-[11px] text-neutral-400">
                      {p.aspectRatio} · {p.resolution} · {Math.round(p.targetDurationSec / 60)} min
                    </span>
                  </div>
                  <h3 className="mt-3 line-clamp-2 font-semibold text-neutral-900">{p.title}</h3>
                  <p className="mt-1 line-clamp-2 text-xs text-neutral-500">{p.description || "—"}</p>
                  <p className="mt-3 text-[11px] text-neutral-400">
                    {p.stats?.sceneCount ?? 0} scènes · {p.stats?.assetCount ?? 0} assets · maj {new Date(p.updatedAt).toLocaleDateString("fr-FR")}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
