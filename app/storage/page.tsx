"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { type User } from "firebase/auth";
import { watchAuth } from "@/lib/firebase/client";
import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import ChariowWidget, { CHARIOW_ESPACE_WIDGETS } from "@/components/billing/chariow-widget";

type ImportedFile = { id: string; filename: string; contentType: string; sizeBytes: number; kind: string; charCount: number; conversion: "full" | "metadata-only"; createdAt?: string };

type PermanentFile = { path: string; filename: string; sizeBytes: number };
type CameraRequest = { id: string; reason: string; facingMode: string };
type StorageLicenceView = { licenceId: string; label: string; extraBytes: number; grantedAt: number };
type StoragePlanInfo = { id: "free" | "storage-pro5" | "storage-pro10"; label: string; quotaBytes: number; priceMinor: number; priceLabel: string; highlight?: boolean };
type StorageProfile = { plan: StoragePlanInfo; renewalAt: number | null; lastRenewalError: string | null; licenceExtraBytes: number; licences: StorageLicenceView[] };
type StorageUsage = { usedBytes: number; quotaBytes: number; fileCount: number };

/** Tailles en unités FR canoniques (Ko/Mo — aligné sur formatBytes du workspace). */
function formatBytesFr(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} ${units[exponent]}`;
}

export default function StoragePage() {
  const [_user, setUser] = useState<User | null>(null); const [files, setFiles] = useState<PermanentFile[]>([]); const [artifacts, setArtifacts] = useState<ImportedFile[]>([]); const [requests, setRequests] = useState<CameraRequest[]>([]); const [busy, setBusy] = useState(false); const videoRef = useRef<HTMLVideoElement>(null);
  const [loaded, setLoaded] = useState(false); const [loadError, setLoadError] = useState<string | null>(null); const [actionError, setActionError] = useState<string | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null); const [profile, setProfile] = useState<StorageProfile | null>(null); const [plans, setPlans] = useState<StoragePlanInfo[]>([]); const [planBusy, setPlanBusy] = useState(false); const [planDone, setPlanDone] = useState<string | null>(null);
  const sessionDisponible = useSessionAvailable();

  // Chargement robuste : une panne réseau/Firestore affiche un état d'erreur
  // réessayable — jamais un faux "Aucun fichier" ni un spinner infini.
  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      const [f, r, p, a] = await Promise.all([
        authFetch("/api/storage/permanent", { cache: "no-store" }),
        authFetch("/api/camera/requests", { cache: "no-store" }),
        authFetch("/api/storage/plan", { cache: "no-store" }),
        authFetch("/api/files/imported", { cache: "no-store" }),
      ]);
      if (f.ok) { const data = await readJsonSafely<{ files?: PermanentFile[]; usage?: StorageUsage }>(f); setFiles(data?.files ?? []); if (data?.usage) setUsage(data.usage); }
      if (r.ok) setRequests((await readJsonSafely<{ requests?: CameraRequest[] }>(r))?.requests ?? []);
      if (p.ok) { const data = await readJsonSafely<{ profile?: StorageProfile; usage?: StorageUsage; plans?: StoragePlanInfo[] }>(p); if (data?.profile) setProfile(data.profile); if (data?.usage) setUsage(data.usage); if (data?.plans) setPlans(data.plans); }
      // Artefacts des conversations : non bloquant (section complémentaire).
      if (a.ok) setArtifacts((await readJsonSafely<{ files?: ImportedFile[] }>(a))?.files ?? []);
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
    setBusy(true); setActionError(null); setPlanDone(null);
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

  /** Suppression DÉFINITIVE (R2 + métadonnées) — libère le quota immédiatement. */
  const removeFile = async (path: string) => {
    if (sessionDisponible === false) return;
    setBusy(true); setActionError(null); setPlanDone(null);
    try {
      const response = await authFetch("/api/storage/permanent", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
      if (!response.ok) {
        const detail = (await readJsonSafely<{ error?: string }>(response))?.error;
        throw new Error(detail ?? `La suppression a échoué (erreur ${response.status}).`);
      }
      setPlanDone("Fichier supprimé définitivement — espace libéré.");
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La suppression définitive a échoué.");
    } finally { setBusy(false); }
  };

  /** Achat / changement de plan (5 Go à 2,5 €/mois, 10 Go à 5 €/mois). */
  const choosePlan = async (planId: StoragePlanInfo["id"]) => {
    if (sessionDisponible === false || planBusy) return;
    setPlanBusy(true); setActionError(null); setPlanDone(null);
    try {
      const response = await authFetch("/api/storage/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId }) });
      if (!response.ok) {
        const detail = (await readJsonSafely<{ error?: string }>(response))?.error;
        throw new Error(detail ?? `Le changement de plan a échoué (erreur ${response.status}).`);
      }
      setPlanDone(planId === "free" ? "Plan de base activé — quota ramené à 1 Go." : "Plan activé — votre quota est étendu immédiatement.");
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Le changement de plan a échoué.");
    } finally { setPlanBusy(false); }
  };

  const capture = async (requestId: string, facingMode: "user" | "environment") => {
    if (sessionDisponible === false || !videoRef.current) return;
    setBusy(true); setActionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode } }); videoRef.current.srcObject = stream; await videoRef.current.play(); await new Promise(r => setTimeout(r, 800)); const canvas = document.createElement("canvas"); canvas.width = videoRef.current.videoWidth; canvas.height = videoRef.current.videoHeight; canvas.getContext("2d")?.drawImage(videoRef.current, 0, 0); stream.getTracks().forEach(t => t.stop()); const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error("La capture caméra a échoué.")), "image/jpeg", .92));
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

  const usedRatio = usage && usage.quotaBytes > 0 ? Math.min(1, usage.usedBytes / usage.quotaBytes) : 0;
  const quotaFull = usage ? usage.usedBytes >= usage.quotaBytes : false;

  return <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text)] p-6"><div className="mx-auto max-w-6xl"><h1 className="font-serif text-3xl font-bold">Bibliothèque de fichiers et d&apos;artefacts</h1><p className="mt-2 text-[var(--g3-muted)]">Destination « Stockage » de la plateforme : vos fichiers permanents ET les artefacts produits avec vos agents, au même endroit. Les agents ne lisent vos contenus que selon leurs permissions.</p>
    {actionError && <div className="mt-4 rounded-2xl border border-[var(--g3-danger-border)] bg-[var(--g3-danger-soft)] p-4 text-sm text-[var(--g3-danger-strong)]">{actionError}</div>}
    {planDone && <div className="mt-4 rounded-2xl border border-[var(--g3-success-border,var(--g3-info-border))] bg-[var(--g3-success-soft)] p-4 text-sm text-[var(--g3-success-strong)]">{planDone}</div>}

    <div className="mt-6 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[var(--gen3ia-shadow-md)]">
      {/* Barre d'utilisation du quota (Task 150) */}
      {usage && <div className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm text-[var(--g3-text-secondary)]">Espace utilisé — plan <span className="font-semibold text-[var(--g3-text)]">{profile?.plan.label ?? "Base"}</span></p>
          <p className="font-mono text-sm text-[var(--g3-muted)]">{formatBytesFr(usage.usedBytes)} / {formatBytesFr(usage.quotaBytes)}</p>
        </div>
        <div className="mt-2 h-3 w-full overflow-hidden rounded-full bg-[var(--g3-elevated)]" role="progressbar" aria-valuenow={Math.round(usedRatio * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Quota de stockage utilisé">
          <div className={`h-full rounded-full transition-all ${quotaFull ? "bg-[var(--g3-danger)]" : "bg-[var(--g3-gradient)]"}`} style={{ width: `${Math.max(2, Math.round(usedRatio * 100))}%` }} />
        </div>
        {profile?.renewalAt && <p className="mt-2 text-xs text-[var(--g3-faint)]">Prochain renouvellement le {new Date(profile.renewalAt).toLocaleDateString("fr-FR")} — débité automatiquement sur votre portefeuille Gen3ia.</p>}
        {profile && profile.licenceExtraBytes > 0 && <p className="mt-2 text-xs text-[var(--g3-success-strong)]">+ {formatBytesFr(profile.licenceExtraBytes)} d&apos;espace acheté (permanent) — {profile.licences.map(l => l.label).join(" · ")}.</p>}
        {profile?.lastRenewalError && <p className="mt-2 text-xs text-[var(--g3-warning-strong)]">Dernier renouvellement impossible : {profile.lastRenewalError} Le compte est repassé sur le plan de base — vos fichiers sont conservés.</p>}
        {quotaFull && <p className="mt-2 text-sm text-[var(--g3-warning-strong)]">Stockage plein : supprimez des fichiers ci-dessous ou étendez votre quota avec un plan payant.</p>}
      </div>}

      <label className="inline-flex cursor-pointer rounded-full bg-[var(--g3-primary)] px-5 py-3 font-semibold text-[var(--g3-on-primary)] hover:bg-[var(--g3-primary-strong)]"><input type="file" className="hidden" disabled={busy} onChange={e => e.target.files?.[0] && upload(e.target.files[0])}/>Importer un fichier</label>
      {loadError && <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-[var(--g3-warning-border)] bg-[var(--g3-warning-soft)] p-4 text-sm text-[var(--g3-warning-strong)]"><span>{loadError}</span><button type="button" onClick={() => void refresh()} className="shrink-0 rounded-full bg-[var(--g3-warning)] px-4 py-2 text-xs font-semibold text-[var(--g3-on-primary)] hover:brightness-110">Réessayer</button></div>}
      {!loadError && !loaded && <p className="mt-4 text-sm text-[var(--g3-faint)]">Chargement de vos fichiers…</p>}
      <div className="mt-6 space-y-2">{files.map(file => <div key={file.path} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4"><span className="min-w-0 truncate" title={file.filename}>{file.filename}</span><span className="flex shrink-0 items-center gap-3"><span className="text-xs text-[var(--g3-muted)]">{formatBytesFr(file.sizeBytes)}</span><button type="button" disabled={busy} onClick={() => void removeFile(file.path)} className="rounded-full border border-[var(--g3-danger-border)] bg-[var(--g3-danger-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-danger-strong)] hover:brightness-110 disabled:opacity-50">Supprimer définitivement</button></span></div>)}{loaded && !loadError && !files.length && <p className="text-sm text-[var(--g3-faint)]">Aucun fichier permanent.</p>}</div>
    </div>

    {/* Artefacts des conversations — bibliothèque unifiée (restructuration des parcours) */}
    <div className="mt-6 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[var(--gen3ia-shadow-md)]">
      <h2 className="font-serif text-xl font-semibold">Artefacts des conversations</h2>
      <p className="mt-2 text-sm text-[var(--g3-muted)]">Documents, tableaux et médias importés ou générés avec vos agents — analysés réellement (caractères, pages, lignes) et conservés ici.</p>
      <div className="mt-5 space-y-2">{artifacts.map(artifact => <div key={artifact.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4"><span className="min-w-0"><span className="block truncate" title={artifact.filename}>{artifact.filename}</span><span className="text-xs text-[var(--g3-faint)]">{artifact.kind} · {artifact.conversion === "full" ? `analyse complète · ${artifact.charCount.toLocaleString("fr-FR")} caractères` : "métadonnées"}</span></span><span className="flex shrink-0 items-center gap-3"><span className="text-xs text-[var(--g3-muted)]">{formatBytesFr(artifact.sizeBytes)}</span><a href={`/api/files/artifacts/${artifact.id}`} target="_blank" rel="noopener noreferrer" className="rounded-full bg-[var(--g3-primary-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-primary-strong)]">Ouvrir</a></span></div>)}{loaded && !artifacts.length && <p className="text-sm text-[var(--g3-faint)]">Aucun artefact : importez un document dans le Chat IA, il apparaîtra ici.</p>}</div>
    </div>

    {/* Plans de stockage — 1 Go inclus, 5 Go à 2,5 €/mois, 10 Go à 5 €/mois */}
    <div className="mt-6 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[var(--gen3ia-shadow-md)]">
      <h2 className="font-serif text-xl font-semibold">Étendre mon stockage</h2>
      <p className="mt-2 text-sm text-[var(--g3-muted)]">Chaque compte dispose de 1 Go offert. Les plans payants sont débités chaque mois sur votre portefeuille Gen3ia et peuvent être annulés à tout moment — vos fichiers sont toujours conservés.</p>
      <div className="mt-5 grid gap-4 md:grid-cols-3">{plans.map(plan => {
        const active = profile?.plan.id === plan.id;
        return <div key={plan.id} className={`rounded-2xl border p-5 ${active ? "border-[var(--g3-primary)] bg-[var(--g3-primary-soft)]" : "border-[var(--g3-border)] bg-[var(--g3-elevated)]"}`}>
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="font-semibold">{plan.label}</h3>
            {active && <span className="rounded-full bg-[var(--g3-primary)] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[var(--g3-on-primary)]">Actif</span>}
          </div>
          <p className="mt-2 font-serif text-2xl font-bold text-[var(--g3-primary-strong)]">{plan.priceLabel}</p>
          <p className="mt-1 text-xs text-[var(--g3-muted)]">{formatBytesFr(plan.quotaBytes)} de stockage permanent</p>
          <button type="button" disabled={busy || planBusy || active} onClick={() => void choosePlan(plan.id)} className="mt-4 w-full rounded-full bg-[var(--g3-primary)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-on-primary)] hover:bg-[var(--g3-primary-strong)] disabled:cursor-not-allowed disabled:opacity-50">{active ? "Plan actuel" : plan.id === "free" ? "Revenir au plan de base" : `Passer à ${plan.label.split(" ").pop()}`}</button>
        </div>;
      })}{!plans.length && loaded && <p className="text-sm text-[var(--g3-faint)]">Offres indisponibles pour le moment.</p>}</div>

      {/* Achat DIRECT d'espace (boutique Chariow) : licences PERMANENTES sans abonnement.
          Le quota est accordé automatiquement après paiement (webhook Pulse) et s'empile
          au-dessus du plan courant — il survit à une retombée au plan de base. */}
      <h3 className="mt-7 font-serif text-lg font-semibold">Achat direct d&apos;espace — permanent</h3>
      <p className="mt-1 text-sm text-[var(--g3-muted)]">Achète ton espace en un clic sur la boutique officielle (Mobile Money ou carte) : la licence est ajoutée automatiquement à ton quota après paiement — sans abonnement, sans renouvellement, tes fichiers sont toujours conservés. <span className="font-semibold text-[var(--g3-text)]">Important : paie avec l&apos;adresse e-mail de ton compte Gen3ia</span> — l&apos;espace est rapproché de ton compte par cet e-mail.</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{CHARIOW_ESPACE_WIDGETS.map(widget => (
        <div key={widget.productId} className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-5">
          <h4 className="font-semibold">{widget.label}</h4>
          <p className="mt-1 text-xs text-[var(--g3-muted)]">{widget.note}</p>
          <div className="mt-3"><ChariowWidget productId={widget.productId} /></div>
        </div>
      ))}</div>
      <p className="mt-3 text-xs text-[var(--g3-faint)]">Payé avec une autre adresse ? Contacte le support : la vente est conservée et peut être rapprochée manuellement de ton compte.</p>
    </div>

    <div className="mt-6 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[var(--gen3ia-shadow-md)]"><h2 className="font-serif text-xl font-semibold">Demandes caméra des agents</h2><p className="mt-2 text-sm text-[var(--g3-muted)]">La caméra n’est jamais activée silencieusement. Une demande d’agent doit être acceptée par l’utilisateur et expire automatiquement.</p><video ref={videoRef} className="mt-4 hidden w-full max-w-xl rounded-xl" playsInline muted /> <div className="mt-5 space-y-3">{requests.map(r => <div key={r.id} className="rounded-xl border border-[var(--g3-warning-border)] bg-[var(--g3-warning-soft)] p-4"><p className="text-sm">{r.reason}</p><button disabled={busy} onClick={() => capture(r.id, r.facingMode === "user" ? "user" : "environment")} className="mt-3 rounded-full bg-[var(--g3-success)] px-4 py-2 text-sm font-semibold text-[var(--g3-on-primary)] hover:brightness-110">Autoriser et prendre la photo</button></div>)}{loaded && !requests.length && <p className="text-sm text-[var(--g3-faint)]">Aucune demande en attente.</p>}</div></div></div></div>;
}
