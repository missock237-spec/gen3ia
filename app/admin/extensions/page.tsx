"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

interface PendingVersion {
  extensionId: string;
  version: string;
  changelog?: string;
  permissions: string[];
  tools: string[];
  pricing: { model?: string };
  author?: string;
  submittedAt?: number | null;
}

/**
 * File de modération Marketplace (admin uniquement — custom claim `admin: true`).
 * Page accessible par URL directe : /admin/extensions. Aucun lien dans la
 * navigation principale pour éviter d'exposer l'entrée aux comptes standards.
 */
export default function AdminReviewPage() {
  const [pending, setPending] = useState<PendingVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const sessionDisponible = useSessionAvailable();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/admin/extensions/review", { cache: "no-store" });
      const data = await response.json();
      if (response.status === 403) throw new Error("Accès réservé aux administrateurs (claim admin manquant).");
      if (response.status === 401) throw new Error("Session expirée. Reconnectez-vous.");
      if (!response.ok) throw new Error(data.error ?? "Chargement impossible.");
      setPending(data.pending ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void load();
  }, [load, sessionDisponible]);

  const review = async (extensionId: string, version: string, decision: "approved" | "rejected") => {
    setBusy(true); setMessage(""); setError("");
    try {
      const note = notes[`${extensionId}@${version}`]?.trim();
      const response = await authFetch("/api/admin/extensions/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extensionId, version, decision, ...(note ? { note } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Décision impossible.");
      setMessage(`Version ${version} de « ${extensionId} » ${decision === "approved" ? "approuvée" : "rejetée"}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Décision impossible.");
    } finally { setBusy(false); }
  };

  const suspend = async (extensionId: string) => {
    if (!window.confirm(`Suspendre l'extension « ${extensionId} » ?`)) return;
    setBusy(true); setMessage(""); setError("");
    try {
      const note = notes[extensionId]?.trim();
      const response = await authFetch("/api/admin/extensions/review?suspend=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extensionId, ...(note ? { note } : {}) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Suspension impossible.");
      setMessage(`Extension « ${extensionId} » suspendue.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suspension impossible.");
    } finally { setBusy(false); }
  };

  if (sessionDisponible === false) {
    return (
      <div className="rounded-3xl border border-white/10 bg-white/5 p-8 text-center">
        <h1 className="font-serif text-xl font-bold">Modération Marketplace</h1>
        <p className="mt-2 text-sm text-neutral-400">Connectez-vous avec un compte administrateur.</p>
        <Link href="/login" className="mt-4 inline-flex rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-neutral-900">Se connecter</Link>
      </div>
    );
  }

  return (
    <div>
      {message && <div className="mb-5 rounded-xl border border-emerald-300/30 bg-emerald-300/10 p-4 text-sm text-emerald-200" role="status">{message}</div>}
      {error && <div className="mb-5 rounded-xl border border-red-300/30 bg-red-300/10 p-4 text-sm text-red-300" role="alert">{error}</div>}

        {loading ? (
          <p className="text-sm text-neutral-400">Chargement de la file…</p>
        ) : pending.length === 0 ? (
          <p className="text-sm text-neutral-400">Aucune version en attente de modération.</p>
        ) : (
          <ul className="space-y-4">
            {pending.map((item) => {
              const noteKey = `${item.extensionId}@${item.version}`;
              return (
                <li key={noteKey} className="rounded-2xl border border-white/10 bg-white/5 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="font-semibold text-neutral-100">{item.extensionId} <span className="font-mono text-xs text-neutral-400">v{item.version}</span></h2>
                      <p className="mt-1 text-xs text-neutral-400">
                        {item.author ? `Par ${item.author} · ` : ""}{item.pricing?.model ?? "free"}{item.submittedAt ? ` · soumis le ${new Date(item.submittedAt).toLocaleString("fr-FR")}` : ""}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button disabled={busy} onClick={() => review(item.extensionId, item.version, "approved")} className="rounded-full bg-emerald-500 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-400 disabled:opacity-40">Approuver</button>
                      <button disabled={busy} onClick={() => review(item.extensionId, item.version, "rejected")} className="rounded-full border border-red-400/40 bg-red-400/10 px-4 py-2 text-xs font-semibold text-red-300 hover:bg-red-400/20 disabled:opacity-40">Rejeter</button>
                      <button disabled={busy} onClick={() => suspend(item.extensionId)} className="rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-400/20 disabled:opacity-40">Suspendre</button>
                    </div>
                  </div>
                  {item.changelog && <p className="mt-3 text-sm text-neutral-300">{item.changelog}</p>}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {item.permissions.map((permission) => <span key={permission} className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-[10px] text-neutral-300">{permission}</span>)}
                  </div>
                  {item.tools.length > 0 && <p className="mt-2 text-[11px] text-neutral-400">Tools : {item.tools.join(", ")}</p>}
                  <input
                    value={notes[noteKey] ?? ""}
                    onChange={(event) => setNotes((current) => ({ ...current, [noteKey]: event.target.value }))}
                    placeholder="Note de modération (facultatif)"
                    aria-label={`Note pour ${noteKey}`}
                    maxLength={500}
                    className="mt-3 w-full rounded-lg border border-white/10 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-100 outline-none focus:border-sky-400/60"
                  />
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );
}
