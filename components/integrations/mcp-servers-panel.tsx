"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

/**
 * Serveurs MCP (Model Context Protocol) connectés par l'utilisateur.
 * L'utilisateur ajoute un endpoint HTTP « streamable » (avec en-têtes
 * d'authentification optionnels) : Gen3ia effectue la poignée de main MCP,
 * découvre les outils exposés (tools/list) et les rend disponibles à ses
 * agents via l'outil mcp.call — sans configuration manuelle supplémentaire.
 */

interface McpServerView {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  tools: Array<{ name: string; description: string }>;
  toolCount?: number;
  lastSyncAt?: string;
  lastError?: string;
}

export function McpServersPanel() {
  const sessionAvailable = useSessionAvailable();
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headerKey, setHeaderKey] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch("/api/integrations/mcp", { cache: "no-store" });
      if (response.ok) {
        const body = await response.json();
        setServers(Array.isArray(body.servers) ? body.servers : []);
      }
    } catch { /* indisponible ponctuellement */ }
    finally { setLoaded(true); }
  }, []);

  useEffect(() => {
    if (sessionAvailable === false) { setLoaded(true); return; }
    if (sessionAvailable === null) return;
    void refresh();
  }, [sessionAvailable, refresh]);

  async function addServer(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const headers = headerKey.trim() && headerValue.trim() ? { [headerKey.trim()]: headerValue.trim() } : {};
      const response = await authFetch("/api/integrations/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), headers }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Ajout impossible.");
      setServers((previous) => [...previous, body.server]);
      setNotice(`Serveur « ${body.server.name} » connecté : ${body.server.toolCount ?? body.server.tools?.length ?? 0} outil(s) découvert(s).`);
      setName("");
      setUrl("");
      setHeaderKey("");
      setHeaderValue("");
      setExpanded(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ajout impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function patchServer(payload: Record<string, unknown>) {
    setError("");
    setNotice("");
    try {
      const response = await authFetch("/api/integrations/mcp", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Mise à jour impossible.");
      if (body.server) setServers((previous) => previous.map((item) => (item.id === body.server.id ? body.server : item)));
      else if (payload.action === "toggle") void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mise à jour impossible.");
    }
  }

  async function deleteServer(id: string) {
    setError("");
    try {
      const response = await authFetch(`/api/integrations/mcp?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Suppression impossible.");
      setServers((previous) => previous.filter((item) => item.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Suppression impossible.");
    }
  }

  if (!loaded && sessionAvailable !== false) {
    return (
      <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-sm sm:p-6">
        <p className="text-sm text-[var(--g3-muted)]">Chargement des serveurs MCP…</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold sm:text-base">Serveurs MCP ({servers.length})</h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-[var(--g3-muted)] sm:text-sm">
            Le Model Context Protocol (MCP) est le standard pour connecter des agents à des outils externes :
            Google Drive, GitHub, bases de données… Ajoutez l&apos;URL d&apos;un serveur MCP : Gen3ia découvre
            automatiquement ses outils et les met à disposition de vos agents.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="shrink-0 rounded-xl bg-[var(--g3-deep)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--g3-deep)]"
        >
          {expanded ? "Annuler" : "Ajouter un serveur"}
        </button>
      </div>

      {error ? <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
      {notice ? <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div> : null}

      {expanded && (
        <form onSubmit={addServer} className="mt-4 grid gap-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--g3-muted)]">Nom du serveur *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} placeholder="Ex. GitHub MCP, Drive d&apos;équipe…" className="mt-1 w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--g3-muted)]">URL de l&apos;endpoint MCP *</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} required type="url" placeholder="https://exemple.com/mcp" className="mt-1 w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--g3-muted)]">En-tête d&apos;authentification (optionnel)</span>
            <input value={headerKey} onChange={(e) => setHeaderKey(e.target.value)} maxLength={120} placeholder="Ex. Authorization" className="mt-1 w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wide text-[var(--g3-muted)]">Valeur de l&apos;en-tête (optionnel)</span>
            <input value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} maxLength={2_000} type="password" placeholder="Ex. Bearer vGH…" className="mt-1 w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2 text-sm" />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy || name.trim().length < 2 || url.trim().length < 8} className="rounded-xl bg-[var(--g3-deep)] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-40 hover:bg-[var(--g3-deep)]">
              {busy ? "Découverte en cours…" : "Connecter et découvrir les outils"}
            </button>
            <p className="mt-2 text-xs text-[var(--g3-faint)]">La poignée de main MCP valide l&apos;endpoint et liste ses outils. Les en-têtes ne sont jamais réaffichés en clair.</p>
          </div>
        </form>
      )}

      {servers.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--g3-muted)]">Aucun serveur MCP connecté. Ajoutez-en un pour étendre les capacités de vos agents.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {servers.map((server) => (
            <li key={server.id} className="rounded-xl border border-[var(--g3-border)] px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {server.name}{" "}
                    <span className={`ml-1 text-xs font-semibold ${server.enabled ? "text-emerald-600" : "text-[var(--g3-faint)]"}`}>
                      {server.enabled ? "● Actif" : "○ Désactivé"}
                    </span>
                  </p>
                  <p className="truncate text-xs text-[var(--g3-faint)]">{server.url}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => patchServer({ id: server.id, action: "toggle", enabled: !server.enabled })} className="rounded-lg border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--g3-elevated)]">
                    {server.enabled ? "Désactiver" : "Activer"}
                  </button>
                  <button type="button" onClick={() => patchServer({ id: server.id, action: "refresh" })} className="rounded-lg border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--g3-elevated)]">
                    Rafraîchir
                  </button>
                  <button type="button" onClick={() => deleteServer(server.id)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">
                    Supprimer
                  </button>
                </div>
              </div>
              {server.lastError ? <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">Dernière erreur : {server.lastError}</p> : null}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(server.tools ?? []).slice(0, 8).map((tool) => (
                  <span key={tool.name} title={tool.description} className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--g3-muted)]">
                    {tool.name}
                  </span>
                ))}
                {(server.tools?.length ?? 0) > 8 ? <span className="text-[11px] text-[var(--g3-faint)]">+{(server.tools?.length ?? 0) - 8} autres</span> : null}
                {(server.tools?.length ?? 0) === 0 ? <span className="text-xs text-[var(--g3-faint)]">Aucun outil découvert — essayez « Rafraîchir ».</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
