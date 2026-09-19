"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

interface MemoryEntry {
  key: string;
  value: string;
  source: string;
}

/**
 * Panneau « Mémoire » : consultation et gestion de la mémoire permanente
 * disponible aux agents (clé/valeur non sensible, contrôle propriétaire).
 * Consomme GET/POST/DELETE /api/memory (memories[]).
 */
export function MemoryPanel() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState("");
  const sessionDisponible = useSessionAvailable();

  const load = useCallback(async () => {
    try {
      const response = await authFetch("/api/memory", { cache: "no-store" });
      if (!response.ok) return;
      setMemories((await response.json()).memories ?? []);
    } catch { /* mémoire indisponible */ } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void load();
  }, [load, sessionDisponible]);

  const remember = async () => {
    if (!key.trim() || !value.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await authFetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim(), value: value.trim() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Enregistrement impossible");
      setKey("");
      setValue("");
      setMessage("Mémorisé. Les agents y accéderont selon leurs permissions.");
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Enregistrement impossible");
    } finally { setBusy(false); }
  };

  const forget = async (target: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await authFetch("/api/memory", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: target }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Suppression impossible");
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Suppression impossible");
    } finally { setBusy(false); }
  };

  if (sessionDisponible === false) return null;

  return (
    <section className="g3-card p-6" aria-label="Mémoire permanente">
      <div className="flex items-center justify-between">
        <h2 className="font-serif text-xl font-semibold">Mémoire permanente</h2>
        <span className="rounded-full border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-2.5 py-1 text-[11px] text-neutral-500">{memories.length} entrée{memories.length > 1 ? "s" : ""}</span>
      </div>
      <p className="mt-2 text-sm text-neutral-500">Informations clés/valeur que vous ou vos agents enregistrez pour les missions futures. Secrets, mots de passe et données bancaires y sont interdits.</p>

      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
        <input
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="clé (ex. projet.nom)"
          aria-label="Clé de mémoire"
          maxLength={160}
          className="g3-input min-w-0"
        />
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="valeur à mémoriser"
          aria-label="Valeur de mémoire"
          maxLength={2000}
          className="g3-input min-w-0"
        />
        <button disabled={busy || !key.trim() || !value.trim()} onClick={remember} className="g3-btn g3-btn-primary whitespace-nowrap">Mémoriser</button>
      </div>
      {message && <p className="mt-2 text-xs text-neutral-500">{message}</p>}

      {loaded && memories.length > 0 && (
        <ul className="mt-4 space-y-2">
          {memories.map((entry) => (
            <li key={entry.key} className="flex items-center justify-between gap-3 rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-4 py-2.5">
              <div className="min-w-0">
                <div className="truncate font-mono text-xs font-semibold text-neutral-700">{entry.key}</div>
                <div className="truncate text-xs text-neutral-500">{entry.value}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${entry.source === "agent" ? "bg-sky-100 text-sky-700" : "bg-neutral-100 text-neutral-500"}`}>{entry.source === "agent" ? "agent" : "vous"}</span>
                <button disabled={busy} onClick={() => forget(entry.key)} aria-label={`Oublier ${entry.key}`} className="rounded-md border border-red-200 bg-white px-2 py-1 text-[10px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40">Oublier</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {loaded && memories.length === 0 && <p className="mt-4 text-sm text-neutral-400">Aucune mémoire enregistrée pour le moment.</p>}
    </section>
  );
}
