"use client";

import { useMemo, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";

export type MemoryEntry = {
  key: string;
  value: string;
  source: string;
  updatedAt?: string;
};

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function formatDate(iso?: string): string {
  if (!iso) return "";
  const cached = dateFormatters.get("fr-FR") ?? new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  dateFormatters.set("fr-FR", cached);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return cached.format(date);
}

/**
 * Souvenirs texte (clé/valeur) : création, recherche, édition, copie et
 * oubli. Les valeurs sont rejouées aux agents selon leurs permissions et
 * toute tentative d'y cacher un secret est refusée par le serveur.
 */
export function SouvenirsPanel(props: {
  memories: MemoryEntry[];
  loaded: boolean;
  onRefresh: () => Promise<void>;
  onNotify: (message: string) => void;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  // Conflit de clé (HTTP 409 MEMORY_KEY_EXISTS) : une écriture sur une clé
  // existante avec une valeur différente exige une confirmation explicite.
  const [conflict, setConflict] = useState<{ key: string; value: string } | null>(null);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return props.memories;
    return props.memories.filter(
      (entry) => entry.key.toLowerCase().includes(query) || String(entry.value).toLowerCase().includes(query),
    );
  }, [props.memories, search]);

  /** Écriture sans consentement d'écrasement : un 409 MEMORY_KEY_EXISTS ouvre la confirmation ci-dessous. */
  const remember = async () => {
    if (!key.trim() || !value.trim()) return;
    setBusy(true);
    setMessage("");
    setConflict(null);
    try {
      const response = await authFetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim(), value: value.trim() }),
      });
      const data = await response.json();
      if (response.status === 409 && data.code === "MEMORY_KEY_EXISTS") {
        setConflict({ key: key.trim(), value: value.trim() });
        setMessage(`Un souvenir existe déjà pour « ${key.trim()} » avec une valeur différente. Écraser ?`);
        return;
      }
      if (!response.ok) throw new Error(data.error ?? "Enregistrement impossible");
      setKey("");
      setValue("");
      setMessage("Mémorisé. Vos agents y accéderont selon leurs permissions.");
      await props.onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  };

  /** Confirmation d'écrasement après un 409 : ré-envoi explicite avec overwrite:true. */
  const overwriteExisting = async () => {
    if (!conflict) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await authFetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: conflict.key, value: conflict.value, overwrite: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Écrasement impossible");
      setConflict(null);
      setKey("");
      setValue("");
      setMessage("Souvenir remplacé.");
      await props.onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Écrasement impossible");
    } finally {
      setBusy(false);
    }
  };

  // L'édition d'une entrée existante est un remplacement volontaire (l'ancienne
  // valeur était visible) : overwrite:true est envoyé d'office, pas de 409 attendu.
  const saveEdit = async (target: string) => {
    if (!editValue.trim()) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await authFetch("/api/memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: target, value: editValue.trim(), overwrite: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Modification impossible");
      setEditingKey(null);
      setEditValue("");
      setMessage("Souvenir mis à jour.");
      await props.onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Modification impossible");
    } finally {
      setBusy(false);
    }
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
      setConfirmingKey(null);
      await props.onRefresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  };

  const copyValue = async (entry: MemoryEntry) => {
    try {
      await navigator.clipboard.writeText(String(entry.value));
      setMessage(`Valeur de « ${entry.key} » copiée.`);
    } catch {
      setMessage("Copie impossible dans ce navigateur.");
    }
  };

  return (
    <section className="g3-card p-5 md:p-6" aria-label="Souvenirs texte">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-xl font-semibold">Souvenirs texte</h2>
          <p className="mt-1 text-sm text-neutral-500">
            Informations clés/valeur que vous ou vos agents enregistrez pour les missions futures.
          </p>
        </div>
        {props.memories.length > 3 && (
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Rechercher un souvenir…"
            aria-label="Rechercher un souvenir"
            className="g3-input w-full sm:w-64"
          />
        )}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
        <input
          value={key}
          onChange={(event) => { setKey(event.target.value); setConflict(null); }}
          placeholder="clé (ex. projet.nom)"
          aria-label="Clé de mémoire"
          maxLength={160}
          className="g3-input min-w-0"
        />
        <input
          value={value}
          onChange={(event) => { setValue(event.target.value); setConflict(null); }}
          placeholder="valeur à mémoriser"
          aria-label="Valeur de mémoire"
          maxLength={2000}
          className="g3-input min-w-0"
        />
        <button
          disabled={busy || !key.trim() || !value.trim()}
          onClick={remember}
          className="g3-btn g3-btn-primary min-h-11 whitespace-nowrap"
        >
          Mémoriser
        </button>
      </div>
      {conflict && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="alert">
          <span>Cette clé existe déjà avec une autre valeur. Remplacer l&apos;ancienne valeur ?</span>
          <button disabled={busy} onClick={overwriteExisting} className="min-h-8 rounded-full bg-amber-600 px-3 font-semibold text-white hover:bg-amber-500 disabled:opacity-40">
            Écraser et remplacer
          </button>
          <button disabled={busy} onClick={() => setConflict(null)} className="min-h-8 rounded-full border border-[var(--g3-border)] bg-white px-3 font-semibold text-neutral-600">
            Annuler
          </button>
        </div>
      )}
      <p className="mt-2 text-xs text-neutral-400">
        Astuce : préférez des clés structurées (client.acme.contact, projet.gen3ia.deadline…). Secrets, mots de
        passe et données bancaires sont refusés automatiquement.
      </p>
      {message && <p className="mt-2 text-xs text-neutral-500" role="status">{message}</p>}

      {props.loaded && filtered.length > 0 && (
        <ul className="mt-4 space-y-2">
          {filtered.map((entry) => (
            <li
              key={entry.key}
              className="rounded-xl border border-[var(--g3-border)] bg-neutral-50 px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-neutral-700">{entry.key}</span>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${entry.source === "agent" ? "bg-sky-100 text-sky-700" : "bg-neutral-200 text-neutral-600"}`}>
                      {entry.source === "agent" ? "agent" : "vous"}
                    </span>
                  </div>
                  {editingKey === entry.key ? (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={editValue}
                        onChange={(event) => setEditValue(event.target.value)}
                        aria-label={`Nouvelle valeur pour ${entry.key}`}
                        maxLength={2000}
                        className="g3-input min-w-0 flex-1"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button disabled={busy} onClick={() => saveEdit(entry.key)} className="g3-btn g3-btn-primary min-h-9 px-3 text-xs">Enregistrer</button>
                        <button disabled={busy} onClick={() => { setEditingKey(null); setEditValue(""); }} className="min-h-9 rounded-full border border-[var(--g3-border)] bg-white px-3 text-xs font-semibold text-neutral-600">Annuler</button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 break-words text-sm text-neutral-600">{String(entry.value)}</p>
                  )}
                  {entry.updatedAt && (
                    <p className="mt-1 text-[11px] text-neutral-400">Mis à jour le {formatDate(entry.updatedAt)}</p>
                  )}
                </div>
                {editingKey !== entry.key && (
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <button
                      disabled={busy}
                      onClick={() => copyValue(entry)}
                      aria-label={`Copier la valeur de ${entry.key}`}
                      className="min-h-9 rounded-md border border-[var(--g3-border)] bg-white px-2.5 text-[11px] font-semibold text-neutral-600 hover:bg-neutral-100"
                    >
                      Copier
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => { setEditingKey(entry.key); setEditValue(String(entry.value)); }}
                      aria-label={`Modifier ${entry.key}`}
                      className="min-h-9 rounded-md border border-[var(--g3-border)] bg-white px-2.5 text-[11px] font-semibold text-neutral-600 hover:bg-neutral-100"
                    >
                      Modifier
                    </button>
                    {confirmingKey === entry.key ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          disabled={busy}
                          onClick={() => forget(entry.key)}
                          className="min-h-9 rounded-md border border-red-300 bg-red-50 px-2.5 text-[11px] font-semibold text-red-700 hover:bg-red-100"
                        >
                          Confirmer
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => setConfirmingKey(null)}
                          className="min-h-9 rounded-md border border-[var(--g3-border)] bg-white px-2.5 text-[11px] font-semibold text-neutral-500"
                        >
                          Non
                        </button>
                      </div>
                    ) : (
                      <button
                        disabled={busy}
                        onClick={() => setConfirmingKey(entry.key)}
                        aria-label={`Oublier ${entry.key}`}
                        className="min-h-9 rounded-md border border-red-200 bg-white px-2.5 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40"
                      >
                        Oublier
                      </button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {props.loaded && props.memories.length > 0 && filtered.length === 0 && (
        <p className="mt-4 text-sm text-neutral-400">Aucun souvenir ne correspond à « {search} ».</p>
      )}
      {props.loaded && props.memories.length === 0 && (
        <p className="mt-4 text-sm text-neutral-400">
          Aucun souvenir enregistré pour le moment. Commencez par une clé simple, par exemple
          <span className="font-mono text-neutral-500"> projet.objectif</span>.
        </p>
      )}
    </section>
  );
}
