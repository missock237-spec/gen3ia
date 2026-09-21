"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";
import { formatHint, totalDurationSeconds, VIDEO_FORMATS, type VideoFormat, type VideoScene } from "@/lib/video/types";

/**
 * Studio Vidéo — génération multimodale :
 *  1. l'utilisateur décrit sa scène/vidéo (brief) et choisit un format
 *     (16:9, 9:16 vertical réseaux, 1:1) ;
 *  2. le planificateur IA produit un storyboard de scènes éditables ;
 *  3. édition conversationnelle (« remplace le fond par un coucher de
 *     soleil », « ajoute une voix off sur la scène 2 »…) via le monteur IA ;
 *  4. chaque scène peut recevoir une image clé générée par IA (text-to-image)
 *     et le plan de tournage complet s'exporte en un clic.
 */

interface ProjectView {
  id: string;
  title: string;
  brief: string;
  format: VideoFormat;
  status: string;
  scenes: VideoScene[];
}

const FORMATS: Array<{ value: VideoFormat; label: string; detail: string }> = [
  { value: "16:9", label: "16:9", detail: "Paysage — YouTube, site web" },
  { value: "9:16", label: "9:16", detail: "Vertical — Reels, TikTok, Shorts" },
  { value: "1:1", label: "1:1", detail: "Carré — feed Instagram, LinkedIn" },
];

function exportShotList(project: ProjectView): void {
  const lines: string[] = [
    `# Plan de tournage — ${project.title}`,
    "",
    `Format : ${project.format} (${formatHint(project.format)})`,
    `Durée estimée : ${totalDurationSeconds(project.scenes)} s · ${project.scenes.length} scènes`,
    "",
    "## Brief",
    project.brief,
    "",
  ];
  project.scenes.forEach((scene, index) => {
    lines.push(
      `## Scène ${index + 1} — ${scene.title || "Sans titre"} (${scene.durationSeconds}s)`,
      "",
      `- Prompt visuel : ${scene.visualPrompt}`,
      `- Voix off : ${scene.narration || "—"}`,
      `- Texte à l'écran : ${scene.onScreenText || "—"}`,
      `- Image clé : ${scene.keyframePath ? "générée" : "non générée"}`,
      "",
    );
  });
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `plan-de-tournage-${project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function VideoWorkshop() {
  const sessionDisponible = useSessionAvailable();
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const [selected, setSelected] = useState<ProjectView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Création
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [format, setFormat] = useState<VideoFormat>("16:9");
  const [sceneCount, setSceneCount] = useState(6);
  // Édition conversationnelle
  const [instruction, setInstruction] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch("/api/video/projects", { cache: "no-store" });
      if (response.ok) setProjects((await response.json()).projects ?? []);
    } catch { /* indisponible ponctuellement */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) { setLoaded(true); return; }
    if (sessionDisponible === null) return;
    void refresh();
  }, [sessionDisponible, refresh]);

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await authFetch("/api/video/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), brief: brief.trim(), format, sceneCount }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Création impossible.");
      setProjects((current) => [data.project, ...current]);
      setSelected(data.project);
      setNotice("Storyboard généré : ajustez les scènes, puis générez les images clés.");
      setTitle(""); setBrief("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function applyInstruction() {
    if (!selected || busy || instruction.trim().length < 2) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await authFetch(`/api/video/projects/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: instruction.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Édition impossible.");
      setSelected(data.project);
      setProjects((current) => current.map((item) => (item.id === data.project.id ? data.project : item)));
      setInstruction("");
      setNotice("Modification appliquée au storyboard.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Édition impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function saveScene(sceneId: string, patch: Partial<VideoScene>) {
    if (!selected) return;
    const scenes = selected.scenes.map((scene) => (scene.id === sceneId ? { ...scene, ...patch } : scene));
    setSelected({ ...selected, scenes });
    try {
      const response = await authFetch(`/api/video/projects/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenes }),
      });
      const data = await response.json();
      if (response.ok) {
        setSelected(data.project);
        setProjects((current) => current.map((item) => (item.id === data.project.id ? data.project : item)));
      }
    } catch { /* sauvegarde silencieuse : le prochain PATCH renverra l'état */ }
  }

  async function generateKeyframe(sceneId: string) {
    if (!selected || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await authFetch(`/api/video/projects/${selected.id}/keyframes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sceneId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Génération impossible.");
      setSelected(data.project);
      setProjects((current) => current.map((item) => (item.id === data.project.id ? data.project : item)));
      setNotice("Image clé générée et attachée à la scène.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Génération impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function loadKeyframeImage(sceneId: string, event: HTMLImageElement | null) {
    if (!selected || !event) return;
    try {
      const response = await authFetch(`/api/video/projects/${selected.id}/keyframes?sceneId=${encodeURIComponent(sceneId)}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      if (typeof data.url === "string") event.src = data.url;
    } catch { /* image optionnelle */ }
  }

  async function removeProject(project: ProjectView) {
    if (!window.confirm(`Supprimer « ${project.title} » ?`)) return;
    try {
      const response = await authFetch(`/api/video/projects/${project.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Suppression impossible.");
      setProjects((current) => current.filter((item) => item.id !== project.id));
      if (selected?.id === project.id) setSelected(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression impossible.");
    }
  }

  if (sessionDisponible === false) {
    return (
      <div className="g3-card p-8 text-center">
        <h2 className="font-serif text-xl font-semibold">Connectez-vous pour créer vos vidéos</h2>
        <p className="mt-2 text-sm text-neutral-500">Le Studio Vidéo fait partie de votre espace personnel Gen3ia.</p>
        <a href="/login?next=/studio?tab=video" className="g3-btn g3-btn-primary mt-5 inline-flex">Se connecter</a>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {error ? <Callout tone="error" className="rounded-2xl">{error}</Callout> : null}
      {notice ? <Callout tone="info" className="rounded-2xl">{notice}</Callout> : null}

      <div className="grid gap-5 lg:grid-cols-[.9fr_1.1fr]">
        {/* Création + projets */}
        <div className="space-y-4">
          <form onSubmit={createProject} className="g3-card p-5" aria-label="Nouveau projet vidéo">
            <h2 className="text-base font-bold">Décrire ma vidéo</h2>
            <p className="mt-1 text-sm text-neutral-500">
              Décrivez la vidéo souhaitée : sujet, message, style visuel, durée cible. L&apos;IA découpe
              votre brief en scènes avec prompts visuels, voix off et textes à l&apos;écran.
            </p>
            <div className="mt-4 space-y-3">
              <div>
                <label className="g3-label" htmlFor="video-title">Titre du projet</label>
                <input id="video-title" className="g3-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Lancement de ma collection printemps" maxLength={120} />
              </div>
              <div>
                <label className="g3-label" htmlFor="video-brief">Brief créatif *</label>
                <textarea id="video-brief" className="g3-textarea min-h-28" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Ex. Une vidéo de 30 secondes pour présenter ma nouvelle marque de café artisanal à Douala : ambiance matinale, grains torréfiés, sourire des clients…" maxLength={4000} required minLength={3} />
              </div>
              <div>
                <span className="g3-label">Format cible</span>
                <div className="grid gap-2 sm:grid-cols-3">
                  {FORMATS.map((option) => (
                    <button key={option.value} type="button" aria-pressed={format === option.value} onClick={() => setFormat(option.value)}
                      className={`rounded-xl border p-3 text-left transition-colors ${format === option.value ? "border-neutral-900 bg-neutral-50" : "border-[rgba(23,23,20,0.09)] bg-white hover:bg-neutral-50"}`}>
                      <span className="block text-sm font-bold">{option.label}</span>
                      <span className="mt-0.5 block text-xs text-neutral-500">{option.detail}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="g3-label" htmlFor="video-scenes">Nombre de scènes</label>
                <input id="video-scenes" type="number" min={3} max={20} value={sceneCount} onChange={(e) => setSceneCount(Math.max(3, Math.min(20, Number(e.target.value) || 6)))} className="g3-input" />
              </div>
              <button type="submit" className="g3-btn g3-btn-primary w-full" disabled={busy || brief.trim().length < 3}>
                {busy ? <>Génération<span className="g3-dots"><span /><span /><span /></span></> : "Générer le storyboard"}
              </button>
            </div>
          </form>

          <div className="g3-card p-5">
            <h2 className="text-base font-bold">Mes projets vidéo ({projects.length})</h2>
            {!loaded ? <p className="mt-2 text-sm text-neutral-400">Chargement…</p> : projects.length === 0 ? (
              <p className="mt-2 text-sm text-neutral-400">Aucun projet pour le moment.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {projects.map((project) => (
                  <li key={project.id} className="flex items-center justify-between gap-2 rounded-xl border border-[rgba(23,23,20,0.09)] bg-white px-3.5 py-2.5">
                    <button type="button" onClick={() => setSelected(project)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-sm font-semibold">{project.title}</span>
                      <span className="block text-xs text-neutral-400">{project.format} · {project.scenes.length} scènes · {totalDurationSeconds(project.scenes)}s</span>
                    </button>
                    <button type="button" onClick={() => void removeProject(project)} aria-label={`Supprimer ${project.title}`} className="shrink-0 rounded-lg border border-red-200 px-2.5 py-1.5 text-xs text-red-600 hover:bg-red-50">×</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Storyboard */}
        <div className="space-y-4">
          {!selected ? (
            <div className="g3-card flex h-full flex-col items-center justify-center p-10 text-center">
              <p className="font-serif text-lg font-semibold">Votre storyboard apparaîtra ici</p>
              <p className="mt-2 max-w-sm text-sm text-neutral-500">
                Décrivez votre vidéo à gauche : l&apos;IA planifie les scènes, vous éditez en langage
                naturel, générez les images clés, puis exportez le plan de tournage.
              </p>
            </div>
          ) : (
            <>
              <div className="g3-card p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h2 className="text-lg font-bold">{selected.title}</h2>
                    <p className="text-xs text-neutral-400">{selected.format} · {selected.scenes.length} scènes · durée estimée {totalDurationSeconds(selected.scenes)}s</p>
                  </div>
                  <button type="button" onClick={() => exportShotList(selected)} className="g3-btn g3-btn-ghost text-xs">Export .md</button>
                </div>

                <div className="mt-4">
                  <label className="g3-label" htmlFor="video-instruction">Assistant de montage (langage naturel)</label>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <input
                      id="video-instruction"
                      className="g3-input flex-1"
                      value={instruction}
                      onChange={(e) => setInstruction(e.target.value)}
                      placeholder="Ex. Remplace le fond de la scène 2 par un coucher de soleil, et raccourcis la scène 3"
                      maxLength={2000}
                    />
                    <button type="button" className="g3-btn g3-btn-primary" onClick={() => void applyInstruction()} disabled={busy || instruction.trim().length < 2}>
                      Appliquer
                    </button>
                  </div>
                </div>
              </div>

              <ol className="space-y-3">
                {selected.scenes.map((scene, index) => (
                  <li key={scene.id} className="g3-card p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-bold">Scène {index + 1} — {scene.title || "Sans titre"}</h3>
                      <span className="rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-0.5 text-[10px] font-bold uppercase text-neutral-500">{scene.durationSeconds}s</span>
                    </div>
                    <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_180px]">
                      <div className="space-y-2.5">
                        <div>
                          <label className="g3-label" htmlFor={`vp-${scene.id}`}>Prompt visuel (IA image)</label>
                          <textarea id={`vp-${scene.id}`} className="g3-textarea min-h-16 text-xs" value={scene.visualPrompt} onChange={(e) => setSelected((current) => current ? { ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, visualPrompt: e.target.value } : item) } : current)} onBlur={(e) => void saveScene(scene.id, { visualPrompt: e.target.value })} maxLength={1000} />
                        </div>
                        <div>
                          <label className="g3-label" htmlFor={`vo-${scene.id}`}>Voix off</label>
                          <textarea id={`vo-${scene.id}`} className="g3-textarea min-h-12 text-xs" value={scene.narration} onChange={(e) => setSelected((current) => current ? { ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, narration: e.target.value } : item) } : current)} onBlur={(e) => void saveScene(scene.id, { narration: e.target.value })} maxLength={1200} />
                        </div>
                        <div className="grid grid-cols-[1fr_90px] gap-2">
                          <div>
                            <label className="g3-label" htmlFor={`ot-${scene.id}`}>Texte à l&apos;écran</label>
                            <input id={`ot-${scene.id}`} className="g3-input text-xs" value={scene.onScreenText} onChange={(e) => setSelected((current) => current ? { ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, onScreenText: e.target.value } : item) } : current)} onBlur={(e) => void saveScene(scene.id, { onScreenText: e.target.value })} maxLength={300} />
                          </div>
                          <div>
                            <label className="g3-label" htmlFor={`dur-${scene.id}`}>Durée (s)</label>
                            <input id={`dur-${scene.id}`} type="number" min={2} max={60} className="g3-input text-xs" value={scene.durationSeconds} onChange={(e) => setSelected((current) => current ? { ...current, scenes: current.scenes.map((item) => item.id === scene.id ? { ...item, durationSeconds: Math.max(2, Math.min(60, Number(e.target.value) || 6)) } : item) } : current)} onBlur={(e) => void saveScene(scene.id, { durationSeconds: Math.max(2, Math.min(60, Number(e.target.value) || 6)) })} />
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-col items-center gap-2">
                        {scene.keyframePath ? (
                          <img
                            ref={(element) => { void loadKeyframeImage(scene.id, element); }}
                            alt={`Image clé de la scène ${index + 1}`}
                            className="w-full rounded-xl border border-neutral-200 object-cover"
                          />
                        ) : (
                          <div className="flex h-24 w-full items-center justify-center rounded-xl border border-dashed border-neutral-300 bg-neutral-50 text-[10px] text-neutral-400">Pas d&apos;image clé</div>
                        )}
                        <button type="button" className="g3-btn g3-btn-ghost !px-3 !py-1.5 text-xs" disabled={busy} onClick={() => void generateKeyframe(scene.id)}>
                          {scene.keyframePath ? "Régénérer" : "Générer l'image clé"}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
