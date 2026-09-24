"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type User } from "firebase/auth";
import { watchAuth } from "@/lib/firebase/client";
import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";

type PermanentFile = { path: string; filename: string; sizeBytes: number };
type CameraRequest = { id: string; reason: string; facingMode: string };

export default function StoragePage() {
  const [user, setUser] = useState<User | null>(null); const [files, setFiles] = useState<PermanentFile[]>([]); const [requests, setRequests] = useState<CameraRequest[]>([]); const [busy, setBusy] = useState(false); const videoRef = useRef<HTMLVideoElement>(null);
  const [loaded, setLoaded] = useState(false); const [loadError, setLoadError] = useState<string | null>(null); const [actionError, setActionError] = useState<string | null>(null);
  const sessionDisponible = useSessionAvailable();

  // Chargement robuste : une panne réseau/Firestore affiche un état d'erreur
  // réessayable — jamais un faux "Aucun fichier" ni un spinner infini.
  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const [f, r] = await Promise.all([
        authFetch("/api/storage/permanent", { cache: "no-store" }),
        authFetch("/api/camera/requests", { cache: "no-store" }),
      ]);
      if (f.ok) setFiles((await readJsonSafely<{ files?: PermanentFile[] }>(f))?.files ?? []);
      if (r.ok) setRequests((await readJsonSafely<{ requests?: CameraRequest[] }>(r))?.requests ?? []);
      if (!f.ok || !r.ok) {
        setLoadError(f.status === 401 || r.status === 401 ? "Session expirée : reconnectez-vous." : "Impossible de charger vos fichiers pour le moment.");
      }
    } catch {
      setLoadError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void refresh(); return watchAuth(current => { setUser(current); }); }, [refresh]);

  const upload = async (file: File) => {
    if (sessionDisponible === false) return;
    setBusy(true); setActionError(null);
    try {
      const form = new FormData(); form.append("file", file);
      const response = await authFetch("/api/storage/permanent", { method: "POST", body: form }, { timeoutMs: 120_000 });
      if (!response.ok) {
        const detail = (await readJsonSafely<{ error?: string }>(response))?.error;
        throw new Error(detail ?? `Échec de l'import (erreur ${response.status}).`);
      }
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Échec de l'import : le fichier n'a pas été enregistré.");
    } finally { setBusy(false); }
  };

  const capture = async (requestId: string, facingMode: "user" | "environment") => {
    if (sessionDisponible === false || !videoRef.current) return;
    setBusy(true); setActionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } }); videoRef.current.srcObject = stream; await videoRef.current.play(); await new Promise(r => setTimeout(r, 800)); const canvas = document.createElement("canvas"); canvas.width = videoRef.current.videoWidth; canvas.height = videoRef.current.videoHeight; canvas.getContext("2d")?.drawImage(videoRef.current, 0, 0); stream.getTracks().forEach(t => t.stop()); const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("Camera capture failed")), "image/jpeg", .92));
      const response = await authFetch(`/api/camera/complete`, { method: "POST", headers: { "content-type": "image/jpeg", "x-camera-request-id": requestId }, body: blob });
      if (!response.ok) {
        const detail = (await readJsonSafely<{ error?: string }>(response))?.error;
        throw new Error(detail ?? "La photo n'a pas pu être envoyée à l'agent.");
      }
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error && error.name !== "NotAllowedError" ? error.message : "Accès caméra refusé ou indisponible sur cet appareil.");
    } finally { setBusy(false); }
  };

  return <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)] p-6"><div className="mx-auto max-w-6xl"><h1 className="font-serif text-3xl font-bold">Stockage permanent</h1><p className="mt-2 text-[var(--g3-muted)]">Vos fichiers restent associés à votre compte. Les agents peuvent les lire et les manipuler uniquement selon leurs permissions.</p>
    {actionError && <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{actionError}</div>}
    <div className="mt-6 rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"><label className="inline-flex cursor-pointer rounded-full bg-[var(--g3-deep)] px-5 py-3 font-semibold text-white hover:bg-[var(--g3-deep)]"><input type="file" className="hidden" disabled={busy} onChange={e => e.target.files?.[0] && upload(e.target.files[0])}/>Importer un fichier</label>
    {loadError && <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800"><span>{loadError}</span><button type="button" onClick={() => void refresh()} className="shrink-0 rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-500">Réessayer</button></div>}
    {!loadError && !loaded && <p className="mt-4 text-sm text-[var(--g3-faint)]">Chargement de vos fichiers…</p>}
    <div className="mt-6 space-y-2">{files.map(file => <div key={file.path} className="flex items-center justify-between rounded-xl border border-[var(--g3-border)] p-4"><span>{file.filename}</span><span className="text-xs text-[var(--g3-muted)]">{(file.sizeBytes / 1024).toFixed(1)} KB</span></div>)}{loaded && !loadError && !files.length && <p className="text-sm text-[var(--g3-faint)]">Aucun fichier permanent.</p>}</div></div><div className="mt-6 rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"><h2 className="font-serif text-xl font-semibold">Demandes caméra des agents</h2><p className="mt-2 text-sm text-[var(--g3-muted)]">La caméra n’est jamais activée silencieusement. Une demande d’agent doit être acceptée par l’utilisateur et expire automatiquement.</p><video ref={videoRef} className="mt-4 hidden w-full max-w-xl rounded-xl" playsInline muted /> <div className="mt-5 space-y-3">{requests.map(r => <div key={r.id} className="rounded-xl border border-amber-200 bg-amber-50 p-4"><p className="text-sm">{r.reason}</p><button disabled={busy} onClick={() => capture(r.id, r.facingMode === "user" ? "user" : "environment")} className="mt-3 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500">Autoriser et prendre la photo</button></div>)}{loaded && !requests.length && <p className="text-sm text-[var(--g3-faint)]">Aucune demande en attente.</p>}</div></div></div></div>;
}
