"use client";

/**
 * ATELIER DE PRODUCTION VIDÉO (Task 79).
 *
 * Six ateliers qui reflètent exactement les modules du moteur :
 * Directeur (plan + révision conversationnelle), Scénario, Storyboard
 * (images IA + Consistency Engine), Voix (enregistrement MediaRecorder +
 * bibliothèque + narrations), Timeline (multi-pistes éditable), Rendu
 * (file, checkpoints, QC, exports, versions).
 */

import { useCallback, useEffect, useState, useRef } from "react";
import Link from "next/link";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";
// Task 1-c — cadre de progression RÉELLE partagé (rendu vidéo + storyboard).
import { MediaProgressFrame, type MediaProgressStatus } from "@/components/media/media-progress-frame";

type JobWithUrls = Omit<RenderJob, "exports" | "output"> & {
  output?: (NonNullable<RenderJob["output"]> & { playbackUrl?: string | null }) | undefined;
  exports: Array<RenderJob["exports"][number] & { playbackUrl?: string | null }>;
};
import { formatTimecode, type VideoProject, type VideoTimeline, type VideoAsset, type RenderJob, type VoiceProfile, type ProductionLogEntry, type TimelineClip } from "@/lib/video/types";
import { listLocalFiles, createLocalObjectUrl, type LocalFileRecord, cacheLocalProject, getCachedLocalProject, enqueueLocalSync, listLocalSyncItems, updateLocalSyncItem, getLocalFile, updateLocalFile } from "@/lib/storage/local-file-store";

type Tab = "director" | "script" | "storyboard" | "voice" | "timeline" | "render";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "director", label: "Directeur" },
  { id: "script", label: "Scénario" },
  { id: "storyboard", label: "Storyboard" },
  { id: "voice", label: "Voix" },
  { id: "timeline", label: "Timeline" },
  { id: "render", label: "Rendu & versions" },
];

export function VideoProjectWorkspace({ projectId }: { projectId: string }) {
  const session = useSessionAvailable();
  const [tab, setTab] = useState<Tab>("director");
  const [project, setProject] = useState<VideoProject | null>(null);
  const [assets, setAssets] = useState<VideoAsset[]>([]);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [jobs, setJobs] = useState<JobWithUrls[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    const response = await authFetch(`/api/video/projects/${projectId}`);
    if (!response.ok) {
      setError((await response.json().catch(() => ({}))).error ?? "Projet introuvable");
      return;
    }
    if (response.ok) {
      const data = (await response.json()) as { project: VideoProject };
      setProject(data.project);
      await cacheLocalProject(data.project);
      return;
    }
    const cached = await getCachedLocalProject<VideoProject>(projectId);
    if (cached) {
      setProject(cached.project);
      setError("Mode hors connexion : dernière version locale utilisée.");
      return;
    }
    setError((await response.json().catch(() => ({}))).error ?? "Projet introuvable");
  }, [projectId]);

  const loadAssets = useCallback(async () => {
    const response = await authFetch(`/api/video/projects/${projectId}/assets`);
    if (response.ok) setAssets(((await response.json()) as { assets: VideoAsset[] }).assets);
  }, [projectId]);

  const loadVoices = useCallback(async () => {
    const response = await authFetch(`/api/video/projects/${projectId}/recordings`);
    if (response.ok) setVoices(((await response.json()) as { voices: VoiceProfile[] }).voices);
  }, [projectId]);

  const loadJobs = useCallback(async () => {
    const response = await authFetch(`/api/video/projects/${projectId}/render`);
    if (response.ok) setJobs(((await response.json()) as { jobs: JobWithUrls[] }).jobs);
  }, [projectId]);

  useEffect(() => {
    if (!session) return;
    void loadProject();
    void loadAssets();
    void loadVoices();
    void loadJobs();
  }, [session, loadProject, loadAssets, loadVoices, loadJobs]);

  const syncLocalFiles = useCallback(async () => {
    if (!navigator.onLine) return;
    const items = await listLocalSyncItems();
    for (const item of items) {
      if (item.status === "synced" || item.status === "syncing") continue;
      const local = await getLocalFile(item.localFileId);
      if (!local || local.serverAssetId) {
        await updateLocalSyncItem(item.id, { status: "synced" });
        continue;
      }
      await updateLocalSyncItem(item.id, { status: "syncing", attempts: item.attempts + 1 });
      try {
        const form = new FormData();
        form.append("file", local.blob, local.name);
        const response = await authFetch(`/api/video/projects/${item.projectId}/assets`, { method: "POST", body: form });
        const data = (await response.json().catch(() => ({}))) as { asset?: { id: string }; error?: string };
        if (!response.ok || !data.asset?.id) throw new Error(data.error ?? "Synchronisation impossible");
        await updateLocalFile(local.id, { serverAssetId: data.asset.id });
        await updateLocalSyncItem(item.id, { status: "synced", lastError: undefined });
      } catch (error) {
        await updateLocalSyncItem(item.id, { status: "error", lastError: error instanceof Error ? error.message : "Erreur de synchronisation" });
      }
    }
  }, []);

  useEffect(() => {
    const handler = () => void syncLocalFiles();
    window.addEventListener("online", handler);
    void syncLocalFiles();
    return () => window.removeEventListener("online", handler);
  }, [syncLocalFiles]);



  async function importLocalMedia(fileList: FileList | null) {
    if (!fileList?.length) return;
    const { saveLocalFile } = await import("@/lib/storage/local-file-store");
    for (const file of Array.from(fileList)) {
      if (!/^((image|video|audio)\\/)/.test(file.type)) throw new Error(`Format non pris en charge : ${file.name}`);
      if (file.size > 50 * 1024 * 1024) throw new Error(`Fichier trop volumineux : ${file.name}`);
      const saved = await saveLocalFile(file, crypto.randomUUID(), projectId);
      await enqueueLocalSync(projectId, saved.id);
    }
    await loadAssets();
  }

  // Polling pendant les rendus actifs (survit aux reloads : la file est côté serveur).
  const hasActiveJob = jobs.some((j) => j.status === "processing" || j.status === "queued");
  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = setInterval(() => {
      void loadJobs();
      void loadProject();
    }, 4_000);
    return () => clearInterval(timer);
  }, [hasActiveJob, loadJobs, loadProject]);

  async function runAction(key: string, action: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setBusy(null);
    }
  }

  if (!session) return <div className="p-6"><Callout tone="info">Connectez-vous pour accéder à cet atelier.</Callout></div>;
  if (!project) return <div className="p-6"><p className="text-sm text-neutral-500">{error ?? "Chargement…"}</p></div>;

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <div>
        <Link href="/studio/video" className="text-xs text-blue-600 hover:underline">← Studio vidéo</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="cursor-pointer rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium hover:bg-neutral-50">
          + Média local
          <input
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            className="hidden"
            onChange={(e) => { void importLocalMedia(e.target.files); e.currentTarget.value = ""; }}
          />
        </label>
          <h1 className="text-2xl font-bold text-neutral-900">{project.title}</h1>
          <span className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-600">{project.style}</span>
          <span className="text-xs text-neutral-500">{project.aspectRatio} · {project.resolution} · {formatTimecode(project.script?.estimatedDurationSec ?? project.targetDurationSec)}</span>
        </div>
      </div>

      {error ? <Callout tone="error">{error}</Callout> : null}

      <LocalMediaPanel projectId={project.id} />

      <nav className="flex flex-wrap gap-1 border-b border-neutral-200" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-t-lg px-4 py-2 text-sm font-medium ${tab === t.id ? "border-b-2 border-blue-600 text-blue-700" : "text-neutral-500 hover:text-neutral-800"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "director" ? <DirectorPanel project={project} onRefresh={() => runAction("refresh", async () => { await loadProject(); })} busy={busy} runAction={runAction} /> : null}
      {tab === "script" ? <ScriptPanel project={project} onRefresh={() => runAction("refresh", async () => { await loadProject(); await loadAssets(); })} busy={busy} runAction={runAction} /> : null}
      {tab === "storyboard" ? <StoryboardPanel project={project} assets={assets} onRefresh={() => runAction("refresh", async () => { await loadProject(); await loadAssets(); })} busy={busy} runAction={runAction} /> : null}
      {tab === "voice" ? <VoicePanel project={project} voices={voices} assets={assets} onRefresh={() => runAction("refresh", async () => { await loadProject(); await loadAssets(); await loadVoices(); })} busy={busy} runAction={runAction} /> : null}
      {tab === "timeline" ? <TimelinePanel project={project} onRefresh={() => runAction("refresh", loadProject)} busy={busy} runAction={runAction} /> : null}
      {tab === "render" ? <RenderPanel project={project} jobs={jobs} onRefresh={async () => { await loadJobs(); await loadProject(); }} busy={busy} runAction={runAction} /> : null}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Médias locaux — stockage appareil, zéro upload automatique
// ────────────────────────────────────────────────────────────────────────────

function LocalMediaPanel({ projectId }: { projectId: string }) {
  const [files, setFiles] = useState<LocalFileRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setFiles(await listLocalFiles(projectId));
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  async function importFiles(fileList: FileList | null) {
    if (!fileList?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(fileList)) {
        const kind = file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/");
        if (!kind) throw new Error(`Format non pris en charge : ${file.name}`);
        if (file.size <= 0 || file.size > 50 * 1024 * 1024) {
          throw new Error(`Fichier trop volumineux : ${file.name} (maximum 50 Mo)`);
        }
        await import("@/lib/storage/local-file-store").then(({ saveLocalFile }) =>
          saveLocalFile(file, crypto.randomUUID(), projectId),
        );
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">Médias de l’appareil</h2>
          <p className="text-xs text-neutral-500">Les fichiers restent dans le stockage local de cet appareil. Aucun upload cloud automatique.</p>
        </div>
        <label className="cursor-pointer rounded-xl bg-neutral-900 px-4 py-2 text-xs font-semibold text-white hover:bg-neutral-800">
          {busy ? "Importation…" : "Ajouter des médias"}
          <input
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/mpeg,audio/mp4,audio/wav,audio/webm,audio/ogg,audio/opus,audio/flac"
            className="hidden"
            disabled={busy}
            onChange={(e) => { void importFiles(e.target.files); e.currentTarget.value = ""; }}
          />
        </label>
      </div>
      {files.length ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {files.map((file) => <LocalMediaTile key={file.id} file={file} onDelete={async () => { await deleteLocalFile(file.id); await load(); }} />)}
        </div>
      ) : (
        <p className="mt-3 text-xs text-neutral-400">Aucun média local associé à ce projet.</p>
      )}
    </section>
  );
}

function LocalMediaTile({ file, onDelete }: { file: LocalFileRecord; onDelete: () => Promise<void> }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void createLocalObjectUrl(file.id).then((value) => {
      if (!active) {
        if (value) URL.revokeObjectURL(value);
        return;
      }
      objectUrl = value;
      setUrl(value);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.id]);
  const media = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "audio" : "image";
  return (
    <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
      <div className="aspect-video bg-neutral-100">
        {url && media === "video" ? <video src={url} muted controls className="h-full w-full object-cover" /> : null}
        {url && media === "audio" ? <audio src={url} controls className="mt-4 w-full" /> : null}
        {url && media === "image" ? <img src={url} alt={file.name} className="h-full w-full object-cover" /> : null}
      </div>
      <div className="p-2">
        <p className="truncate text-[11px] font-medium">{file.name}</p>
        <button onClick={() => void onDelete()} className="mt-1 text-[11px] text-rose-600 hover:underline">Supprimer de l’appareil</button>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Directeur — plan + révision conversationnelle + journal de production
// ────────────────────────────────────────────────────────────────────────────

function DirectorPanel({ project, busy, runAction }: { project: VideoProject; onRefresh: () => void; busy: string | null; runAction: (key: string, a: () => Promise<void>) => Promise<void> }) {
  const [instruction, setInstruction] = useState("");
  const [reply, setReply] = useState<string | null>(null);

  function revise() {
    void runAction("revise", async () => {
      const response = await authFetch(`/api/video/projects/${project.id}/revise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const data = (await response.json()) as { message?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Révision impossible");
      setReply(data.message ?? "Appliqué.");
      setInstruction("");
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-3">
        <h2 className="font-semibold text-neutral-900">Parler au Directeur</h2>
        <p className="text-xs text-neutral-500">Modifie le projet existant : rythme, musique, voix, sous-titres, suppression de scène, chapitre étendu, intro cinématographique, version TikTok, retour à une version.</p>
        <div className="flex gap-2">
          <input
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && instruction.trim().length >= 3 && revise()}
            placeholder="Ex. : la vidéo est trop rapide"
            className="flex-1 rounded-xl border border-neutral-300 px-4 py-2 text-sm"
          />
          <button onClick={revise} disabled={busy === "revise" || instruction.trim().length < 3} className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy === "revise" ? "…" : "Appliquer"}
          </button>
        </div>
        {reply ? <Callout tone="info">{reply}</Callout> : null}
      </section>
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-3">
        <h2 className="font-semibold text-neutral-900">Journal de production</h2>
        <ul className="space-y-2 max-h-96 overflow-y-auto">
          {[...(project.productionLog ?? [])].reverse().map((entry: ProductionLogEntry, i) => (
            <li key={i} className="border-l-2 border-neutral-200 pl-3 text-xs">
              <span className="text-neutral-400">{new Date(entry.at).toLocaleTimeString("fr-FR")} · {entry.actor}</span>
              <p className="text-neutral-700">{entry.message}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Scénario
// ────────────────────────────────────────────────────────────────────────────

function ScriptPanel({ project, busy, runAction }: { project: VideoProject; onRefresh: () => void; busy: string | null; runAction: (key: string, a: () => Promise<void>) => Promise<void> }) {
  const script = project.script;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={() => runAction("script", async () => {
            const response = await authFetch(`/api/video/projects/${project.id}/script`, { method: "POST" });
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Scénario impossible");
          })}
          disabled={busy === "script"}
          className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy === "script" ? "Écriture du scénario…" : script ? "Régénérer le scénario" : "Écrire le scénario"}
        </button>
        <button
          onClick={() => runAction("storyboard", async () => {
            const response = await authFetch(`/api/video/projects/${project.id}/storyboard`, { method: "POST" });
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Storyboard impossible");
          })}
          disabled={busy === "storyboard" || !script}
          className="rounded-xl border border-neutral-300 px-5 py-2 text-sm font-medium disabled:opacity-50"
        >
          Établir le storyboard
        </button>
      </div>
      {!script ? (
        <p className="text-sm text-neutral-500">Aucun scénario — lancez l&apos;écriture (Hook → chapitres → scènes → conclusion → CTA).</p>
      ) : (
        <div className="space-y-4">
          <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <h3 className="text-xs font-bold uppercase tracking-wide text-amber-700">Hook</h3>
            <p className="mt-1 text-sm text-neutral-800">{script.hook}</p>
          </section>
          <section className="rounded-2xl border border-neutral-200 bg-white p-5">
            <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500">Introduction</h3>
            <p className="mt-1 text-sm text-neutral-800">{script.introduction}</p>
          </section>
          {script.chapters.map((chapter) => (
            <section key={chapter.id} className="rounded-2xl border border-neutral-200 bg-white p-5 space-y-3">
              <div>
                <h3 className="font-semibold text-neutral-900">{chapter.title}</h3>
                <p className="text-xs text-neutral-500">{chapter.summary}</p>
              </div>
              {chapter.sceneIds.map((sceneId) => {
                const scene = script.scenes.find((s) => s.id === sceneId);
                if (!scene) return null;
                return (
                  <div key={sceneId} className="rounded-xl bg-neutral-50 p-4">
                    <div className="flex items-center justify-between text-xs text-neutral-500">
                      <span className="font-mono">{scene.id} · {formatTimecode(scene.startSec)} → {formatTimecode(scene.startSec + scene.durationSec)}</span>
                      <span>{scene.cameraMotion} · transition {scene.transitionIn}</span>
                    </div>
                    <p className="mt-2 text-sm text-neutral-800">{scene.narration}</p>
                    <p className="mt-2 text-xs italic text-neutral-500">Visuel : {scene.visualPrompt}</p>
                    {scene.soundEffects.length > 0 ? <p className="mt-1 text-[11px] text-neutral-400">SFX : {scene.soundEffects.join(", ")}</p> : null}
                  </div>
                );
              })}
            </section>
          ))}
          <section className="rounded-2xl border border-neutral-200 bg-white p-5">
            <h3 className="text-xs font-bold uppercase tracking-wide text-neutral-500">Conclusion</h3>
            <p className="mt-1 text-sm text-neutral-800">{script.conclusion}</p>
            {script.callToAction ? <p className="mt-2 text-sm font-medium text-blue-700">{script.callToAction}</p> : null}
          </section>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Storyboard — images IA scène par scène (Consistency Engine)
// ────────────────────────────────────────────────────────────────────────────

function StoryboardPanel({ project, assets, onRefresh, busy, runAction }: { project: VideoProject; assets: VideoAsset[]; onRefresh: () => Promise<void> | void; busy: string | null; runAction: (key: string, a: () => Promise<void>) => Promise<void> }) {
  const storyboard = project.storyboard ?? [];
  const scenes = project.script?.scenes ?? [];
  const images = assets.filter((a) => a.kind === "image");

  // Task 1-c — progression RÉELLE du lot d'images en cours : pendant le POST
  // generate-assets, on sonde GET /assets toutes les 3 s et on compte les
  // scènes du scénario qui possèdent déjà leur image (kind=image + sceneId).
  const [batchProgress, setBatchProgress] = useState<{ ready: number; total: number } | null>(null);
  const pollRef = useRef<{ timer: ReturnType<typeof setInterval>; controller: AbortController } | null>(null);

  useEffect(() => () => {
    // Démontage : arrêt du sondage + abort des GET en vol.
    if (pollRef.current) {
      clearInterval(pollRef.current.timer);
      pollRef.current.controller.abort();
      pollRef.current = null;
    }
  }, []);

  function countScenesWithImage(list: VideoAsset[]) {
    return scenes.filter((s) => list.some((img) => img.kind === "image" && img.sceneId === s.id)).length;
  }

  async function generateBatch(force = false) {
    const target = scenes.filter((s) => force || !images.some((img) => img.sceneId === s.id)).slice(0, 4);
    if (target.length === 0) throw new Error("Toutes les scènes ont déjà une image — utilisez Régénérer.");
    const total = scenes.length;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const poll = await authFetch(`/api/video/projects/${project.id}/assets`, { signal: controller.signal });
        if (!poll.ok) return;
        const fresh = ((await poll.json()) as { assets: VideoAsset[] }).assets;
        setBatchProgress({ ready: countScenesWithImage(fresh), total });
      } catch {
        // GET annulé (fin de lot / démontage) — silencieux.
      }
    }, 3_000);
    pollRef.current = { timer, controller };
    setBatchProgress({ ready: countScenesWithImage(assets), total });
    try {
      const response = await authFetch(`/api/video/projects/${project.id}/generate-assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneIds: target.map((s) => s.id), force }),
      });
      const data = (await response.json()) as { error?: string; generated?: number; failed?: Array<{ error: string }> };
      if (!response.ok) throw new Error(data.error ?? "Génération impossible");
      if (data.failed?.length) throw new Error(`${data.generated ?? 0} image(s) générée(s), ${data.failed.length} échec(s) : ${data.failed[0].error}`);
    } finally {
      // Fin du lot (succès ou échec) : arrêt du sondage puis rafraîchissement
      // unique des assets (l'état réel final est relu au serveur).
      clearInterval(timer);
      controller.abort();
      pollRef.current = null;
      setBatchProgress(null);
      await onRefresh();
    }
  }

  return (
    <div className="space-y-4">
      {batchProgress ? (
        <MediaProgressFrame
          compact
          tone="dark"
          status="running"
          stageLabel="Génération des images de scènes"
          percent={batchProgress.total > 0 ? (batchProgress.ready / batchProgress.total) * 100 : null}
          detail={`${batchProgress.ready}/${batchProgress.total} images prêtes`}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => runAction("images", () => generateBatch(false))} disabled={busy === "images" || !project.script} className="rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy === "images" ? "Génération…" : `Générer les images (${Math.max(0, scenes.filter((s) => !images.some((img) => img.sceneId === s.id)).length)})`}
        </button>
        <button onClick={() => runAction("images-force", () => generateBatch(true))} disabled={busy === "images-force" || !project.script} className="rounded-xl border border-neutral-300 px-5 py-2 text-sm disabled:opacity-50">
          Régénérer (4 suivantes)
        </button>
        <span className="self-center text-xs text-neutral-500">Lot de 4 par clic — cohérence des personnages assurée par le Consistency Engine.</span>
      </div>

      {storyboard.length === 0 ? (
        <p className="text-sm text-neutral-500">Établissez d&apos;abord le storyboard (onglet Scénario).</p>
      ) : (
        <ol className="grid gap-3 sm:grid-cols-2">
          {storyboard.map((entry) => {
            const image = images.find((img) => img.sceneId === entry.sceneId);
            return (
              <li key={entry.sceneId} className="rounded-2xl border border-neutral-200 bg-white p-4">
                <div className="flex items-center justify-between text-xs text-neutral-500">
                  <span className="font-mono">SCÈNE {entry.sceneId.replace("scene_", "")} · {formatTimecode(entry.timecodeStartSec)} → {formatTimecode(entry.timecodeEndSec)}</span>
                  <span className={image ? "text-emerald-600" : "text-neutral-400"}>{image ? "image prête" : "en attente"}</span>
                </div>
                <p className="mt-2 text-sm text-neutral-800">{entry.imageBrief}</p>
                <p className="mt-2 text-[11px] text-neutral-400">Animation : {entry.animation} · Entrée : {entry.transitionIn} · Voix : {entry.voiceBrief.slice(0, 80)}…</p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Voix — MediaRecorder + bibliothèque + narrations
// ────────────────────────────────────────────────────────────────────────────

function VoicePanel({ project, voices, onRefresh, busy, runAction }: { project: VideoProject; voices: VoiceProfile[]; assets: VideoAsset[]; onRefresh: () => void; busy: string | null; runAction: (key: string, a: () => Promise<void>) => Promise<void> }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [voiceName, setVoiceName] = useState("Ma voix principale");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startRecording() {
    void navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        setAudioUrl(URL.createObjectURL(blob));
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1_000);
    });
  }

  function stopRecording() {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }

  function saveRecording() {
    void runAction("save-voice", async () => {
      if (!audioUrl) throw new Error("Enregistrez d'abord votre voix.");
      const blob = await (await fetch(audioUrl)).blob();
      const form = new FormData();
      form.append("audio", blob, "voice.webm");
      form.append("meta", JSON.stringify({
        name: voiceName,
        language: project.language,
        contentType: blob.type || "audio/webm",
        durationSec: seconds,
        isDefault: voices.length === 0,
        rightsConfirmed: true,
      }));
      const response = await authFetch(`/api/video/projects/${project.id}/recordings`, { method: "POST", body: form });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Sauvegarde impossible");
      setAudioUrl(null);
      onRefresh();
    });
  }

  function generateNarrations() {
    void runAction("narrations", async () => {
      const scenes = (project.script?.scenes ?? []).slice(0, 4);
      if (scenes.length === 0) throw new Error("Aucun scénario.");
      const response = await authFetch(`/api/video/projects/${project.id}/generate-voice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneIds: scenes.map((s) => s.id) }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Génération impossible");
      onRefresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-4">
        <h2 className="font-semibold text-neutral-900">Ma voix</h2>
        <div className="flex items-center gap-3">
          {!recording ? (
            <button onClick={startRecording} className="flex items-center gap-2 rounded-full bg-rose-600 px-5 py-2 text-sm font-semibold text-white hover:bg-rose-700">
              <span className="h-2.5 w-2.5 rounded-full bg-white" /> Enregistrer
            </button>
          ) : (
            <button onClick={stopRecording} className="flex items-center gap-2 rounded-full bg-neutral-900 px-5 py-2 text-sm font-semibold text-white">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" /> Arrêter
            </button>
          )}
          <span className="font-mono text-sm text-neutral-600">{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span>
        </div>
        {audioUrl ? (
          <div className="space-y-2">
            <audio controls src={audioUrl} className="w-full" />
            <input value={voiceName} onChange={(e) => setVoiceName(e.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-1.5 text-sm" placeholder="Nom de la voix" />
            <button onClick={saveRecording} disabled={busy === "save-voice"} className="rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
              Utiliser cette voix
            </button>
            <p className="text-[11px] text-neutral-400">En confirmant, vous attester détenir les droits sur cette voix.</p>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-3">
        <h2 className="font-semibold text-neutral-900">Bibliothèque de voix</h2>
        {voices.length === 0 ? <p className="text-sm text-neutral-500">Aucune voix enregistrée.</p> : (
          <ul className="space-y-2">
            {voices.map((v) => (
              <li key={v.id} className="flex items-center justify-between rounded-xl bg-neutral-50 px-4 py-2">
                <div>
                  <p className="text-sm font-medium text-neutral-800">{v.name} {v.isDefault ? <span className="ml-1 rounded bg-blue-100 px-1.5 text-[10px] text-blue-700">défaut</span> : null}</p>
                  <p className="text-[11px] text-neutral-400">{v.origin === "recording" ? "Enregistrement" : "ElevenLabs"} · {v.language}{v.durationSec ? ` · ${Math.round(v.durationSec)} s` : ""}</p>
                </div>
                <span className="text-xs text-neutral-400">{v.status === "active" ? "" : v.status}</span>
              </li>
            ))}
          </ul>
        )}
        <button onClick={generateNarrations} disabled={busy === "narrations" || !project.script} className="w-full rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy === "narrations" ? "Génération des narrations…" : "Générer les narrations (4 scènes suivantes)"}
        </button>
        <p className="text-[11px] text-neutral-400">Voie A : votre enregistrement est utilisé directement. Voie B : narration ElevenLabs (facturée au caractère réel).</p>
      </section>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Timeline — visualisation multi-pistes + édition des clips
// ────────────────────────────────────────────────────────────────────────────

function TimelinePanel({ project, onRefresh, busy, runAction }: { project: VideoProject; onRefresh: () => void; busy: string | null; runAction: (key: string, a: () => Promise<void>) => Promise<void> }) {
  const [timeline, setTimeline] = useState<VideoTimeline | null>(project.timeline ?? null);
  const [localFiles, setLocalFiles] = useState<LocalFileRecord[]>([]);
  const [selectedLocalId, setSelectedLocalId] = useState<string | null>(null);
  const duration = timeline?.durationSec ?? 1;

  const refreshLocal = useCallback(async () => {
    setLocalFiles(await listLocalFiles(project.id));
  }, [project.id]);

  useEffect(() => { void refreshLocal(); }, [refreshLocal]);

  useEffect(() => {
    if (project.timeline) { setTimeline(project.timeline); return; }
    if (!project.script) return;
    void runAction("timeline-init", async () => {
      const response = await authFetch(`/api/video/projects/${project.id}/timeline`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Timeline indisponible");
      setTimeline(((await response.json()) as { timeline: VideoTimeline }).timeline);
      onRefresh();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.script]);

  async function patch(op: string, payload: Record<string, unknown>, clipId?: string) {
    const response = await authFetch(`/api/video/projects/${project.id}/timeline`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, clipId, payload }),
    });
    const data = (await response.json()) as { timeline?: VideoTimeline; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Édition impossible");
    setTimeline(data.timeline ?? null);
    if (data.timeline) {
      await cacheLocalProject({ ...project, timeline: data.timeline, updatedAt: new Date().toISOString() });
    }
    onRefresh();
  }

  async function addLocalToTimeline(file: LocalFileRecord) {
    if (!timeline) return;
    const kind = file.type.startsWith("video/") ? "video" : file.type.startsWith("audio/") ? "voice" : "image";
    const track = timeline.tracks.find((t) => t.kind === kind) ?? timeline.tracks.find((t) => t.kind === "video");
    if (!track) throw new Error("Aucune piste compatible.");
    const lastEnd = track.clips.reduce((max, clip) => Math.max(max, clip.startSec + clip.durationSec), 0);
    const clip: TimelineClip = {
      id: `local_${file.id}`,
      assetId: file.serverAssetId ?? `local:${file.id}`,
      startSec: lastEnd,
      durationSec: kind === "voice" ? 5 : 4,
      layer: track.clips.length,
      transform: { x: 0, y: 0, scale: 1, rotationDeg: 0, opacity: 1 },
      effects: [],
    };
    await patch("add_clip", { trackId: track.id, clip });
    setSelectedLocalId(file.id);
  }

  if (!timeline) return <p className="text-sm text-neutral-500">{busy ? "Initialisation de la timeline…" : "Timeline indisponible (scénario requis)."}</p>;

  const trackColors: Record<string, string> = { image: "bg-indigo-400", video: "bg-indigo-500", text: "bg-amber-400", voice: "bg-emerald-400", music: "bg-sky-400", sfx: "bg-rose-400" };

  return (
    <div className="space-y-4">
      {localFiles.length ? (
        <section className="rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div><h3 className="text-sm font-semibold text-neutral-900">Médias locaux disponibles</h3><p className="text-[11px] text-neutral-500">Ils restent sur l’appareil jusqu’au rendu. Ajouter à la Timeline ne déclenche aucun upload.</p></div>
            <button onClick={() => void refreshLocal()} className="text-xs text-blue-700 hover:underline">Actualiser</button>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {localFiles.map((file) => <LocalTimelineAsset key={file.id} file={file} selected={selectedLocalId === file.id} onAdd={() => void runAction(`local-add-${file.id}`, () => addLocalToTimeline(file))} />)}
          </div>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-neutral-500">Durée : {formatTimecode(duration)} · {timeline.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · v{timeline.version}</span>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={timeline.captions.enabled} onChange={() => runAction("captions", () => patch("set_captions", { enabled: !timeline.captions.enabled }))} />Sous-titres</label>
        <select value={timeline.captions.style} onChange={(e) => runAction("captions-style", () => patch("set_captions", { enabled: true, style: e.target.value }))} className="rounded-lg border border-neutral-300 px-2 py-1 text-xs">
          <option value="documentary">Style documentaire</option><option value="minimal">Minimal</option><option value="shorts_bold">Shorts gras</option><option value="cinematic_yellow">Cinéma jaune</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white p-4">
        <div className="min-w-[720px] space-y-2">
          {timeline.tracks.map((track) => <div key={track.id} className="flex items-center gap-2"><span className="w-28 shrink-0 text-right text-[11px] font-medium text-neutral-500">{track.name}</span><div className="relative h-7 flex-1 rounded bg-neutral-100">
            {track.clips.map((clip) => <button key={clip.id} title={`${clip.id} — ${clip.startSec}s → ${clip.startSec + clip.durationSec}s`} onClick={() => runAction(`clip-${clip.id}`, () => patch("resize_clip", { durationSec: Math.max(0.5, Math.round((clip.durationSec + 0.5) * 100) / 100) }, clip.id))} className={`absolute top-0.5 h-6 rounded ${trackColors[track.kind] ?? "bg-neutral-400"} opacity-90 hover:opacity-100`} style={{ left: `${(clip.startSec / duration) * 100}%`, width: `${Math.max(1, (clip.durationSec / duration) * 100)}%` }} />)}
          </div></div>)}
          <div className="flex items-center gap-2 border-t pt-2"><span className="w-28 shrink-0" /><div className="flex flex-1 justify-between font-mono text-[10px] text-neutral-400">{[0, 0.25, 0.5, 0.75, 1].map((r) => <span key={r}>{formatTimecode(duration * r)}</span>)}</div></div>
        </div>
      </div>
      <p className="text-[11px] text-neutral-400">Les clips locaux utilisent un identifiant local tant qu’ils ne sont pas nécessaires au rendu.</p>
    </div>
  );
}

function LocalTimelineAsset({ file, selected, onAdd }: { file: LocalFileRecord; selected: boolean; onAdd: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    void createLocalObjectUrl(file.id).then((value) => { if (!active) { if (value) URL.revokeObjectURL(value); return; } objectUrlRef.current = value; setUrl(value); });
    return () => { active = false; if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current); };
  }, [file.id]);
  const isVideo = file.type.startsWith("video/");
  const isAudio = file.type.startsWith("audio/");
  return <div className={`overflow-hidden rounded-xl border bg-white ${selected ? "border-blue-500" : "border-neutral-200"}`}>
    <div className="aspect-video bg-neutral-100">
      {url && isVideo ? <video src={url} muted className="h-full w-full object-cover" /> : null}
      {url && !isVideo && !isAudio ? <img src={url} alt={file.name} className="h-full w-full object-cover" /> : null}
      {url && isAudio ? <audio src={url} controls className="mt-5 w-full" /> : null}
    </div>
    <div className="p-2"><p className="truncate text-[11px] font-medium">{file.name}</p><button onClick={onAdd} className="mt-1 w-full rounded-lg bg-neutral-900 px-2 py-1.5 text-[11px] font-semibold text-white">Ajouter à la Timeline</button></div>
  </div>;
}

// ────────────────────────────────────────────────────────────────────────────
// Rendu & versions
// ────────────────────────────────────────────────────────────────────────────

const STAGE_LABELS: Record<string, string> = {
  plan: "Plan de rendu", download: "Préparation", segments: "Segments", transitions: "Transitions",
  audio: "Mixage audio", subtitles: "Sous-titres", qc: "Contrôle qualité", exports: "Exports", finalize: "Finalisation",
};

// Task 1-c — statuts de job → états du cadre de progression partagé.
const JOB_STATUS_TO_PROGRESS: Record<RenderJob["status"], MediaProgressStatus> = {
  queued: "queued",
  processing: "running",
  paused: "paused",
  completed: "complete",
  failed: "failed",
  cancelled: "cancelled",
};

function RenderPanel({ project, jobs, onRefresh, busy, runAction }: { project: VideoProject; jobs: JobWithUrls[]; onRefresh: () => Promise<void>; busy: string | null; runAction: (key: string, a: () => Promise<void>) => Promise<void> }) {
  const [versions, setVersions] = useState<Array<{ versionNumber: number; label: string; createdAt: string }>>([]);
  const [targets, setTargets] = useState<string[]>(["shorts_9_16"]);

  useEffect(() => {
    void authFetch(`/api/video/projects/${project.id}/versions`).then(async (r) => {
      if (r.ok) setVersions(((await r.json()) as { versions: Array<{ versionNumber: number; label: string; createdAt: string }> }).versions);
    });
  }, [project.id]);

  async function ensureLocalAssetsUploaded() {
    const localFiles = await listLocalFiles(project.id);
    for (const local of localFiles) {
      if (local.serverAssetId) continue;
      const kind = local.type.startsWith("image/")
        ? "image"
        : local.type.startsWith("video/")
          ? "video"
          : "audio_music";
      const form = new FormData();
      form.append("file", local.blob, local.name);
      form.append("meta", JSON.stringify({
        kind,
        label: local.name,
        contentType: local.type,
      }));
      const response = await authFetch(`/api/video/projects/${project.id}/assets`, { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as { asset?: { id?: string }; error?: string };
      if (!response.ok || !data.asset?.id) throw new Error(data.error ?? `Upload du média local impossible : ${local.name}`);
      await updateLocalFile(local.id, { serverAssetId: data.asset.id });
      // Les clips qui pointent encore vers local:<id> sont rebinding vers
      // l'asset serveur avant le rendu. Aucun upload supplémentaire ensuite.
      const current = project.timeline;
      if (current) {
        const localClipIds = current.tracks
          .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
          .filter(({ clip }) => clip.assetId === `local:${local.id}`);
        for (const { clip } of localClipIds) {
          const bindResponse = await authFetch(`/api/video/projects/${project.id}/timeline`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              op: "set_asset",
              clipId: clip.id,
              payload: { assetId: data.asset.id },
            }),
          });
          if (!bindResponse.ok) {
            throw new Error((await bindResponse.json().catch(() => ({}))).error ?? `Association du média impossible : ${local.name}`);
          }
        }
      }
    }
  }

  function startRender() {
    void runAction("render-start", async () => {
      // Local-first : les médias restent sur l'appareil jusqu'au moment où
      // le rendu serveur en a réellement besoin. Ils sont alors enregistrés
      // une seule fois comme assets R2 et leur identifiant est mémorisé localement.
      await ensureLocalAssetsUploaded();
      const response = await authFetch(`/api/video/projects/${project.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ derivedTargets: targets }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Rendu impossible");
      await onRefresh();
    });
  }

  function jobAction(jobId: string, action: string) {
    void runAction(`job-${jobId}-${action}`, async () => {
      const response = await authFetch(`/api/video/projects/${project.id}/render`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, action }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Action impossible");
      await onRefresh();
    });
  }

  function restore(versionNumber: number) {
    void runAction(`restore-${versionNumber}`, async () => {
      const response = await authFetch(`/api/video/projects/${project.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionNumber }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Restauration impossible");
      await onRefresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-4">
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-3">
          <h2 className="font-semibold text-neutral-900">Lancer le rendu</h2>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-neutral-500">Formats de diffusion (en plus du master 16:9)</legend>
            {["shorts_9_16", "tiktok_9_16", "reels_9_16", "square_1_1"].map((t) => (
              <label key={t} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={targets.includes(t)} onChange={() => setTargets((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])} />
                {t.replace("_", " ").replace("9 16", "9:16 vertical")}
              </label>
            ))}
          </fieldset>
          <button onClick={startRender} disabled={busy === "render-start" || !project.script} className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
            Rendre la vidéo (arrière-plan, reprise automatique)
          </button>
          <p className="text-[11px] text-neutral-400">Le rendu survit à la fermeture de l&apos;onglet. En cas d&apos;échec à 73 %, reprise au dernier checkpoint — jamais de re-rendu complet.</p>
        </div>

        <div className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-3">
          <h2 className="font-semibold text-neutral-900">Rendus</h2>
          {jobs.length === 0 ? <p className="text-sm text-neutral-500">Aucun rendu pour l&apos;instant.</p> : (
            <ul className="space-y-3">
              {jobs.map((job) => {
                // Task 1-c — ROBUSTESSE D'ÉCHELLE : l'API historique expose 0..1,
                // certains chemins renvoient déjà 0..100. Tolère les deux.
                const pct = Math.max(0, Math.min(100, job.progress <= 1 ? job.progress * 100 : job.progress));
                const segmentsDone = job.checkpoints?.completedSegments?.length ?? 0;
                const totalSegments = job.plan?.segments.length ?? 0;
                const stageBase = STAGE_LABELS[job.stage] ?? job.stage;
                const stageLabel = job.stage === "segments" && totalSegments > 0
                  ? `${stageBase} · segment ${Math.min(segmentsDone + 1, totalSegments)}/${totalSegments}`
                  : stageBase;
                const startedAtMs = Date.parse(job.createdAt);
                return (
                <li key={job.id} className="rounded-xl border border-neutral-200 p-4 space-y-2">
                  <p className="font-mono text-xs text-neutral-400">{job.id.slice(0, 8)}</p>
                  <MediaProgressFrame
                    tone="dark"
                    status={JOB_STATUS_TO_PROGRESS[job.status]}
                    stageLabel={stageLabel}
                    percent={pct}
                    detail={`${segmentsDone} segment(s) rendu(s)${job.autoFixRounds ? ` · ${job.autoFixRounds} correction(s) auto` : ""}`}
                    error={job.errorMessage}
                    startedAt={Number.isFinite(startedAtMs) ? startedAtMs : undefined}
                    onCancel={job.status === "queued" || job.status === "processing" || job.status === "paused" ? () => jobAction(job.id, "cancel") : undefined}
                    onRetry={job.status === "failed" ? () => jobAction(job.id, "resume") : undefined}
                  />
                  {job.qcReport ? (
                    <p className={`text-[11px] ${job.qcReport.passed ? "text-emerald-600" : "text-amber-600"}`}>
                      QC : {job.qcReport.passed ? "validé" : `${job.qcReport.issues.length} problème(s)`}{job.qcReport.metrics?.durationSec ? ` · ${job.qcReport.metrics.durationSec.toFixed(1)} s` : ""}
                    </p>
                  ) : null}
                  {job.status === "completed" && job.output ? (
                    <video controls className="w-full rounded-lg" src={job.output.playbackUrl ?? ""} />
                  ) : null}
                  {job.exports?.some((e) => e.status === "done") ? (
                    <ul className="flex flex-wrap gap-2 text-[11px]">
                      {job.exports.filter((e) => e.status === "done").map((e) => (
                        <li key={e.target}><a href={e.playbackUrl ?? "#"} target="_blank" rel="noreferrer" className="rounded-full bg-neutral-100 px-2.5 py-1 hover:bg-neutral-200">{e.target.replace("_", " ")}</a></li>
                      ))}
                    </ul>
                  ) : null}
                  <div className="flex gap-2">
                    {job.status === "processing" || job.status === "queued" ? (
                      <button onClick={() => jobAction(job.id, "pause")} className="rounded-lg border px-3 py-1 text-xs">Pause</button>
                    ) : null}
                    {job.status === "paused" ? (
                      <button onClick={() => jobAction(job.id, "resume")} className="rounded-lg border px-3 py-1 text-xs">Reprendre</button>
                    ) : null}
                    {/* Annuler / Réessayer sont portés par MediaProgressFrame (Task 1-c). */}
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      <section className="rounded-2xl border border-neutral-200 bg-white p-6 space-y-3 self-start">
        <h2 className="font-semibold text-neutral-900">Versions</h2>
        <p className="text-xs text-neutral-500">Chaque révision crée un instantané réversible. « Reviens à la version 2 » au Directeur fait la même chose.</p>
        {versions.length === 0 ? <p className="text-sm text-neutral-500">Aucune version.</p> : (
          <ul className="space-y-1.5">
            {versions.map((v) => (
              <li key={v.versionNumber} className="flex items-center justify-between rounded-lg bg-neutral-50 px-3 py-2 text-xs">
                <span><span className="font-semibold">v{v.versionNumber}</span> · {v.label}</span>
                <button onClick={() => restore(v.versionNumber)} disabled={busy === `restore-${v.versionNumber}`} className="text-blue-600 hover:underline">Restaurer</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
