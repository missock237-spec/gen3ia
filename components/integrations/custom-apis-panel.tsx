"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

/**
 * API personnelles de l'utilisateur — gestion complète :
 *  - déclaration d'une API (URL de base + authentification Bearer / en-tête /
 *    paramètre d'URL) ;
 *  - activation / désactivation (un connecteur désactivé n'est plus appelé) ;
 *  - TEST RÉEL : la requête HTTP part du serveur avec l'authentification
 *    enregistrée et la réponse brute de l'API est affichée ;
 *  - suppression.
 * Les connecteurs créés ici sont utilisables depuis le chat (conversation et
 * agents) : « Utilise l'API <nom> pour … » déclenche un appel réel.
 */

interface CustomApiView {
  id: string;
  name: string;
  baseUrl: string;
  description?: string;
  authType: "none" | "bearer" | "header" | "query";
  authHeader?: string;
  queryKey?: string;
  enabled: boolean;
  lastCallAt?: string;
  lastCallStatus?: "success" | "failed";
  lastCallHttp?: number;
  hasSecret: boolean;
}

interface CallResultView {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  body?: string;
  latencyMs: number;
}

const AUTH_TYPE_LABELS: Record<CustomApiView["authType"], string> = {
  none: "Aucune (API publique)",
  bearer: "Bearer (en-tête Authorization)",
  header: "En-tête personnalisé",
  query: "Paramètre d'URL",
};

export function CustomApisPanel() {
  const sessionAvailable = useSessionAvailable();
  const [apis, setApis] = useState<CustomApiView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [description, setDescription] = useState("");
  const [authType, setAuthType] = useState<CustomApiView["authType"]>("none");
  const [authValue, setAuthValue] = useState("");
  const [authHeader, setAuthHeader] = useState("X-API-Key");
  const [queryKey, setQueryKey] = useState("api_key");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; result?: CallResultView; error?: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await authFetch("/api/custom-apis", { cache: "no-store" });
      if (response.ok) {
        const body = (await response.json()) as { apis?: CustomApiView[] };
        setApis(Array.isArray(body.apis) ? body.apis : []);
      }
    } catch {
      /* indisponible ponctuellement */
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (sessionAvailable === false) {
      setLoaded(true);
      return;
    }
    if (sessionAvailable === null) return;
    void refresh();
  }, [sessionAvailable, refresh]);

  async function createApi(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await authFetch("/api/custom-apis", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          baseUrl,
          ...(description.trim() ? { description } : {}),
          authType,
          ...(authValue.trim() ? { authValue } : {}),
          ...(authType === "header" ? { authHeader } : {}),
          ...(authType === "query" ? { queryKey } : {}),
          enabled: true,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Création impossible.");
      setNotice(`Connecteur « ${name} » créé. Vous pouvez maintenant l'utiliser dans le chat : « Utilise l'API ${name} pour … ».`);
      setName("");
      setBaseUrl("");
      setDescription("");
      setAuthValue("");
      setAuthType("none");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Création impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function toggleApi(api: CustomApiView) {
    setError("");
    setNotice("");
    try {
      const response = await authFetch(`/api/custom-apis/${api.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !api.enabled }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Mise à jour impossible.");
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Mise à jour impossible.");
    }
  }

  async function removeApi(api: CustomApiView) {
    setError("");
    setNotice("");
    try {
      const response = await authFetch(`/api/custom-apis/${api.id}`, { method: "DELETE" });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Suppression impossible.");
      }
      setNotice(`API « ${api.name} » supprimée.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Suppression impossible.");
    }
  }

  async function testApi(api: CustomApiView) {
    setTestingId(api.id);
    setTestResult(null);
    setError("");
    try {
      const response = await authFetch(`/api/custom-apis/${api.id}/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "GET", path: "" }),
      });
      const data = (await response.json().catch(() => ({}))) as { result?: CallResultView; error?: string };
      if (!response.ok) throw new Error(data.error ?? "Appel impossible.");
      setTestResult({ id: api.id, result: data.result });
    } catch (caught) {
      setTestResult({ id: api.id, error: caught instanceof Error ? caught.message : "Appel impossible." });
    } finally {
      setTestingId(null);
    }
  }

  if (sessionAvailable === false) {
    return (
      <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold">Mes API personnelles</h2>
        <p className="mt-2 text-sm text-[var(--g3-muted)]">Connectez-vous pour déclarer vos API.</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Mes API personnelles</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--g3-muted)]">
            Déclarez vos propres API (URL de base + clé) : vos agents et vos conversations les appellent
            <span className="font-semibold text-[var(--g3-text)]"> réellement</span> via le chat. Les lectures (GET) s&apos;exécutent
            directement ; toute modification de données attend votre validation. Vous pouvez aussi fournir une API
            directement dans le chat : « Connecte cette API : https://… avec la clé … ».
          </p>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="g3-btn g3-btn-ghost !min-h-0 !px-3 !py-1.5 text-xs"
          aria-expanded={expanded}
        >
          {expanded ? "Fermer" : "Ajouter une API"}
        </button>
      </div>

      {error && <p className="mt-3 text-sm text-red-600" role="alert">{error}</p>}
      {notice && <p className="mt-3 text-sm text-emerald-600">{notice}</p>}

      {expanded && (
        <form onSubmit={createApi} className="mt-4 grid gap-3 rounded-xl border border-[var(--g3-border)] p-4 sm:grid-cols-2">
          <label className="grid gap-1 text-xs font-medium">
            Nom de l&apos;API
            <input value={name} onChange={(event) => setName(event.target.value)} required minLength={2} maxLength={120}
              placeholder="Mon CRM" className="g3-input" />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            URL de base
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} required type="url"
              placeholder="https://api.exemple.com/v1" className="g3-input" />
          </label>
          <label className="grid gap-1 text-xs font-medium sm:col-span-2">
            Description (optionnelle — aide vos agents à cibler les bons endpoints)
            <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={600}
              placeholder="Gestion des clients et des devis" className="g3-input" />
          </label>
          <label className="grid gap-1 text-xs font-medium">
            Authentification
            <select value={authType} onChange={(event) => setAuthType(event.target.value as CustomApiView["authType"])} className="g3-input">
              {(Object.keys(AUTH_TYPE_LABELS) as Array<CustomApiView["authType"]>).map((type) => (
                <option key={type} value={type}>{AUTH_TYPE_LABELS[type]}</option>
              ))}
            </select>
          </label>
          {authType === "header" && (
            <label className="grid gap-1 text-xs font-medium">
              Nom de l&apos;en-tête
              <input value={authHeader} onChange={(event) => setAuthHeader(event.target.value)} className="g3-input" />
            </label>
          )}
          {authType === "query" && (
            <label className="grid gap-1 text-xs font-medium">
              Nom du paramètre d&apos;URL
              <input value={queryKey} onChange={(event) => setQueryKey(event.target.value)} className="g3-input" />
            </label>
          )}
          {authType !== "none" && (
            <label className="grid gap-1 text-xs font-medium sm:col-span-2">
              Clé / token (stocké côté serveur, jamais renvoyé au navigateur)
              <input value={authValue} onChange={(event) => setAuthValue(event.target.value)} type="password" autoComplete="off"
                className="g3-input" />
            </label>
          )}
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy || name.trim().length < 2 || baseUrl.trim().length < 8} className="g3-btn !min-h-0 !px-4 !py-2 text-sm disabled:opacity-50">
              {busy ? "Création…" : "Créer le connecteur"}
            </button>
          </div>
        </form>
      )}

      {loaded && apis.length === 0 && (
        <p className="mt-4 text-sm text-[var(--g3-muted)]">
          Aucune API personnelle pour l&apos;instant. Créez-en une ci-dessus ou fournissez-la directement dans le chat.
        </p>
      )}

      <ul className="mt-4 space-y-2.5">
        {apis.map((api) => (
          <li key={api.id} className="rounded-xl border border-[var(--g3-border)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <span aria-hidden className="grid size-5 place-items-center rounded bg-[var(--g3-deep)] text-[8px] font-bold text-white">API</span>
                  <span className="truncate">{api.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${api.enabled ? "bg-emerald-100 text-emerald-800" : "bg-neutral-200 text-neutral-700"}`}>
                    {api.enabled ? "active" : "désactivée"}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-xs text-[var(--g3-muted)]">{api.baseUrl} · auth : {AUTH_TYPE_LABELS[api.authType]}{api.hasSecret ? " (clé enregistrée)" : ""}</p>
                {api.description && <p className="mt-0.5 truncate text-xs text-[var(--g3-muted)]">{api.description}</p>}
                {api.lastCallAt && (
                  <p className="mt-0.5 text-[11px] text-[var(--g3-muted)]">
                    Dernier appel réel : {new Date(api.lastCallAt).toLocaleString("fr-FR")}
                    {api.lastCallHttp !== undefined ? ` — HTTP ${api.lastCallHttp}` : ""}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap gap-1.5">
                <button type="button" onClick={() => void testApi(api)} disabled={testingId === api.id}
                  className="g3-btn g3-btn-ghost !min-h-0 !px-3 !py-1.5 text-xs disabled:opacity-50">
                  {testingId === api.id ? "Appel réel…" : "Tester (appel réel)"}
                </button>
                <button type="button" onClick={() => void toggleApi(api)} className="g3-btn g3-btn-ghost !min-h-0 !px-3 !py-1.5 text-xs">
                  {api.enabled ? "Désactiver" : "Activer"}
                </button>
                <button type="button" onClick={() => void removeApi(api)}
                  className="rounded-lg border border-[var(--g3-border)] px-3 py-1.5 text-xs text-red-600 transition-colors hover:bg-red-50">
                  Supprimer
                </button>
              </div>
            </div>
            {testResult?.id === api.id && (
              <div className="mt-3 rounded-lg bg-[var(--g3-elevated)] p-3 text-xs">
                {testResult.error ? (
                  <p className="text-red-600" role="alert">Échec de l&apos;appel réel : {testResult.error}</p>
                ) : testResult.result ? (
                  <>
                    <p className={testResult.result.ok ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
                      Réponse réelle : HTTP {testResult.result.status} {testResult.result.statusText} — {testResult.result.latencyMs} ms
                    </p>
                    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[11px] text-[var(--g3-muted)]">
                      {(testResult.result.body ?? "").slice(0, 1_500)}
                    </pre>
                  </>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
