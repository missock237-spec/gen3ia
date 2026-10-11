"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Section « Clés API » des Paramètres (Task 126) — self-service des clés
 * `g3a_` : liste, création (clé affichée UNE seule fois) et révocation.
 *
 * Palette : tokens 2 couleurs existants UNIQUEMENT (famille violet/cyan) —
 * aucune nouvelle couleur.
 */

interface ApiKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  rateLimitPerMinute: number;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

const ALL_SCOPES = ["media", "agents", "terminal", "read"] as const;

function dateFr(value: number | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["agents"]);
  const [creating, setCreating] = useState(false);
  const [freshKey, setFreshKey] = useState<{ key: string; prefix: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/settings/api-keys", { cache: "no-store" });
      const body = (await response.json()) as { keys?: ApiKeyView[]; error?: string };
      if (!response.ok) throw new Error(body.error || "Chargement impossible.");
      setKeys(body.keys ?? []);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleScope(scope: string) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  async function create() {
    if (!name.trim() || scopes.length === 0) return;
    setCreating(true);
    setError("");
    try {
      const response = await fetch("/api/settings/api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scopes }),
      });
      const body = (await response.json()) as { key?: string; view?: ApiKeyView; error?: string };
      if (!response.ok || !body.key || !body.view) throw new Error(body.error || "Création impossible.");
      setFreshKey({ key: body.key, prefix: body.view.prefix });
      setCopied(false);
      setName("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Création impossible.");
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    if (!window.confirm("Révoquer cette clé API ? Les intégrations qui l'utilisent cesseront immédiatement de fonctionner.")) return;
    setError("");
    try {
      const response = await fetch("/api/settings/api-keys", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Révocation impossible.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Révocation impossible.");
    }
  }

  async function copyKey() {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="g3-gradient-border mt-6 p-6" aria-labelledby="settings-apikeys-title">
      <h2 id="settings-apikeys-title" className="font-[family-name:var(--font-display)] text-2xl font-semibold">
        Clés API
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
        Appelez l&apos;API publique Gen3ia (<code className="text-[var(--g3-text)]">/api/v1</code>) depuis vos
        intégrations avec un en-tête <code className="text-[var(--g3-text)]">Authorization: Bearer g3a_…</code>.
        La clé complète n&apos;est affichée qu&apos;une seule fois, à la création.
      </p>

      {error && (
        <p className="mt-3 rounded-xl border border-[rgba(124,92,255,0.5)] bg-[var(--g3-primary-soft)] px-3 py-2 text-sm" role="alert">
          {error}
        </p>
      )}

      {freshKey && (
        <div className="mt-4 rounded-2xl border border-[rgba(42,212,232,0.5)] bg-[var(--g3-elevated)]/60 p-4">
          <p className="text-sm font-semibold">Clé « {freshKey.prefix} » créée — copiez-la maintenant</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="max-w-full truncate rounded-lg bg-[var(--g3-bg)] px-3 py-2 text-xs text-[var(--g3-text)]">
              {freshKey.key}
            </code>
            <button
              type="button"
              onClick={copyKey}
              className="rounded-full border border-[rgba(42,212,232,0.6)] px-3 py-1.5 text-xs font-semibold transition hover:bg-[var(--g3-primary-soft)]"
            >
              {copied ? "Copiée ✓" : "Copier"}
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--g3-faint)]">
            Elle ne sera plus jamais affichée. Révoquez-la et recréez-en une en cas de perte.
          </p>
        </div>
      )}

      <div className="mt-4 rounded-2xl bg-[var(--g3-elevated)]/60 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nom de la clé (ex. n8n production)"
            maxLength={100}
            className="w-full rounded-xl border border-[rgba(124,92,255,0.35)] bg-[var(--g3-bg)] px-3 py-2 text-sm text-[var(--g3-text)] outline-none focus:border-[rgba(124,92,255,0.8)]"
          />
          <button
            type="button"
            onClick={create}
            disabled={creating || !name.trim() || scopes.length === 0}
            className="shrink-0 rounded-full bg-[var(--g3-primary)] px-4 py-2 text-sm font-semibold text-[var(--g3-bg)] transition disabled:opacity-50"
          >
            {creating ? "Création…" : "Générer une clé"}
          </button>
        </div>
        <fieldset className="mt-3">
          <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Scopes</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {ALL_SCOPES.map((scope) => {
              const active = scopes.includes(scope);
              return (
                <button
                  key={scope}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleScope(scope)}
                  className={
                    "rounded-full border px-3 py-1.5 text-xs font-semibold transition " +
                    (active
                      ? "border-[rgba(42,212,232,0.8)] bg-[var(--g3-primary-soft)] text-[var(--g3-text)]"
                      : "border-[rgba(124,92,255,0.3)] text-[var(--g3-muted)] hover:border-[rgba(124,92,255,0.6)]")
                  }
                >
                  {scope}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="mt-4">
        {loading ? (
          <p className="text-sm text-[var(--g3-muted)]" role="status">Chargement des clés…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-[var(--g3-muted)]">Aucune clé API pour le moment.</p>
        ) : (
          <ul className="space-y-2">
            {keys.map((key) => (
              <li
                key={key.id}
                className={
                  "flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-4 py-3 " +
                  (key.revokedAt
                    ? "border-[rgba(124,92,255,0.2)] opacity-60"
                    : "border-[rgba(124,92,255,0.35)] bg-[var(--g3-elevated)]/40")
                }
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-[var(--g3-text)]">
                    {key.name} <span className="font-mono text-xs text-[var(--g3-muted)]">{key.prefix}…</span>
                    {key.revokedAt && <span className="ml-2 text-xs text-[var(--g3-faint)]">(révoquée)</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-[var(--g3-faint)]">
                    {key.scopes.join(" · ")} — {key.rateLimitPerMinute} req/min — créée {dateFr(key.createdAt)} —
                    dernier usage {dateFr(key.lastUsedAt)}
                  </p>
                </div>
                {!key.revokedAt && (
                  <button
                    type="button"
                    onClick={() => revoke(key.id)}
                    className="shrink-0 rounded-full border border-[rgba(124,92,255,0.5)] px-3 py-1.5 text-xs font-semibold transition hover:bg-[var(--g3-primary-soft)]"
                  >
                    Révoquer
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
