"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";

import { auth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

interface DeveloperExtension {
  id: string;
  name: string;
  description: string;
  category: string;
  status: string;
  latestVersion: string | null;
  approvedVersion: string | null;
  permissions: string[];
  pricing: { model: string };
  stats: { installs: number; ratingCount: number; executions: number };
  rating: number | null;
}

interface RevenueSummary {
  totalGrossMinor: number;
  totalFeeMinor: number;
  totalNetMinor: number;
  currency: string;
  entries: number;
}

interface ApiKeyEntry {
  prefix: string;
  name: string;
  status: string;
  createdAt: number;
}

interface SecretRef {
  ref: string;
  description?: string;
  configured: boolean;
}

const MANIFEST_TEMPLATE = `{
  "id": "mon-extension",
  "name": "Mon Extension",
  "version": "1.0.0",
  "author": "rempli-automatiquement",
  "description": "Ce que fait mon extension pour les agents Gen3ia.",
  "category": "productivity",
  "tags": ["exemple"],
  "permissions": ["http.fetch:api.exemple.com"],
  "secrets": { "api_key": { "description": "Clé API du service externe" } },
  "tools": [
    {
      "id": "exemple-appel",
      "name": "Appel exemple",
      "description": "Interroge l'API externe.",
      "inputSchema": { "query": { "type": "string", "required": true, "maxLength": 200 } },
      "outputSchema": { "result": { "type": "string" } },
      "endpoint": {
        "method": "GET",
        "url": "https://api.exemple.com/v1/search?q={{input.query}}",
        "headers": [{ "name": "Authorization", "value": "Bearer {{secret.api_key}}" }],
        "timeoutMs": 8000
      }
    }
  ],
  "skills": [],
  "workflows": [],
  "settings": [],
  "pricing": { "model": "free", "maxExecutionsPerDay": 100 }
}`;

export default function DeveloperPage() {
  const [user, setUser] = useState<User | null>(null);
  const [extensions, setExtensions] = useState<DeveloperExtension[]>([]);
  const [revenue, setRevenue] = useState<RevenueSummary | null>(null);
  const [apiKeys, setApiKeys] = useState<ApiKeyEntry[]>([]);
  const [manifest, setManifest] = useState(MANIFEST_TEMPLATE);
  const [newKey, setNewKey] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [logs, setLogs] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [secrets, setSecrets] = useState<SecretRef[]>([]);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const sessionDisponible = useSessionAvailable();

  const authedFetch = useCallback(async (path: string, init?: RequestInit) => {
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    return authFetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
  }, []);

  const loadAll = useCallback(async () => {
    const [extensionsRes, revenueRes, keysRes] = await Promise.all([
      authedFetch("/api/developer/extensions"),
      authedFetch("/api/developer/revenue"),
      authedFetch("/api/developer/api-keys"),
    ]);
    if (extensionsRes.ok) setExtensions((await extensionsRes.json()).extensions ?? []);
    if (revenueRes.ok) setRevenue((await revenueRes.json()).revenue ?? null);
    if (keysRes.ok) setApiKeys((await keysRes.json()).keys ?? []);
  }, [authedFetch]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (current) => {
      setUser(current);
      void loadAll();
    });
    // Charge aussi sans etat Firebase client (le cookie de session suffit).
    void loadAll();
    return () => unsubscribe();
  }, [loadAll]);

  const createExtension = async () => {
    setBusy(true);
    setMessage("");
    try {
      const parsed = JSON.parse(manifest);
      const response = await authedFetch("/api/extensions", { method: "POST", body: JSON.stringify({ manifest: parsed }) });
      const data = await response.json();
      if (!response.ok) throw new Error([data.error, ...(data.details ?? [])].filter(Boolean).join(" — "));
      setMessage(`Extension « ${data.extension.id} » créée (v${data.extension.latestVersion}). Soumettez-la après tests.`);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  };

  const submit = async (extensionId: string, version: string | null) => {
    if (!version) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await authedFetch(`/api/extensions/${extensionId}/submit`, { method: "POST", body: JSON.stringify({ version }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(`Version ${version} soumise à la modération.`);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Soumission impossible");
    } finally {
      setBusy(false);
    }
  };

  const createApiKey = async () => {
    setBusy(true);
    try {
      const response = await authedFetch("/api/developer/api-keys", { method: "POST", body: JSON.stringify({ name: "SDK" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setNewKey(data.key);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Création de clé impossible");
    } finally {
      setBusy(false);
    }
  };

  const revokeApiKey = async (prefix: string) => {
    if (!window.confirm(`Révoquer définitivement la clé ${prefix}… ? Les intégrations qui l'utilisent cesseront de fonctionner.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await authedFetch("/api/developer/api-keys", { method: "DELETE", body: JSON.stringify({ prefix }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(`Clé ${prefix}… révoquée.`);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Révocation impossible");
    } finally {
      setBusy(false);
    }
  };

  const loadSecrets = async (extensionId: string) => {
    setSelected(extensionId);
    setSecrets([]);
    setSecretValues({});
    const response = await authedFetch(`/api/developer/secrets?extensionId=${encodeURIComponent(extensionId)}`);
    const data = await response.json();
    if (!response.ok) { setMessage(data.error ?? "Chargement des secrets impossible"); return; }
    setSecrets(data.secrets ?? []);
  };

  const saveSecret = async (extensionId: string, ref: string) => {
    const value = secretValues[ref];
    if (!value || !value.trim()) { setMessage(`Valeur vide pour ${ref}.`); return; }
    setBusy(true);
    setMessage("");
    try {
      const response = await authedFetch("/api/developer/secrets", { method: "PUT", body: JSON.stringify({ extensionId, ref, value: value.trim() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(`Secret ${ref} enregistré (jamais relu par l'interface).`);
      setSecretValues((current) => ({ ...current, [ref]: "" }));
      await loadSecrets(extensionId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible");
    } finally {
      setBusy(false);
    }
  };

  const removeSecret = async (extensionId: string, ref: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await authedFetch("/api/developer/secrets", { method: "DELETE", body: JSON.stringify({ extensionId, ref }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setMessage(`Secret ${ref} supprimé.`);
      await loadSecrets(extensionId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  };

  const loadLogs = async (extensionId: string) => {
    setSelected(extensionId);
    const response = await authedFetch(`/api/extensions/${extensionId}/executions?limit=30`);
    if (response.ok) setLogs((await response.json()).executions ?? []);
  };

  if (sessionDisponible === false) {
    return (
      <div className="flex min-h-full items-center justify-center bg-[#f6f4ef] p-6 text-neutral-900">
        <div className="max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <h1 className="font-serif text-xl font-bold">Espace développeur</h1>
          <p className="mt-2 text-sm text-neutral-600">Connectez-vous pour créer et publier des extensions Gen3ia.</p>
          <Link href="/login" className="mt-6 inline-flex rounded-full bg-neutral-900 px-6 py-3 text-sm font-semibold text-white hover:bg-neutral-800">Se connecter</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-[#f6f4ef] text-neutral-900 p-5 md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs tracking-[.3em] text-sky-700">GEN3IA DEVELOPER STUDIO</div>
            <h1 className="mt-2 font-serif text-3xl font-bold">Mes extensions</h1>
            <p className="mt-2 text-neutral-600">Créez, testez, soumettez et monétisez vos extensions.</p>
          </div>
          <div className="flex gap-3">
            <Link href="/marketplace" className="rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm hover:bg-neutral-50">Marketplace</Link>
            <Link href="/studio" className="rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm hover:bg-neutral-50">Studio</Link>
          </div>
        </header>

        {message && <div className="mb-5 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-neutral-800">{message}</div>}

        <section className="mb-8 grid gap-4 md:grid-cols-4">
          <Stat title="Extensions" value={String(extensions.length)} />
          <Stat title="Installations" value={String(extensions.reduce((total, extension) => total + extension.stats.installs, 0))} />
          <Stat title="Exécutions" value={String(extensions.reduce((total, extension) => total + extension.stats.executions, 0))} />
          <Stat title="Revenus nets" value={revenue ? `${(revenue.totalNetMinor / 100).toLocaleString("fr-FR")} ${revenue.currency}` : "—"} />
        </section>

        <section className="mb-8 grid gap-5 lg:grid-cols-[1.3fr_1fr]">
          <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <h2 className="font-serif text-xl font-semibold">Créer une extension (manifest)</h2>
            <p className="mt-2 text-sm text-neutral-500">
              Le manifest déclare tools, skills, workflows, permissions, secrets et prix.
              Il est validé côté serveur à chaque étape. Aucun code tiers n’est exécuté :
              les tools sont des connecteurs HTTPS déclaratifs.
            </p>
            <textarea
              value={manifest}
              onChange={(event) => setManifest(event.target.value)}
              className="mt-4 min-h-80 w-full resize-y rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-4 font-mono text-xs leading-5 outline-none focus:border-sky-300"
              spellCheck={false}
            />
            <button disabled={busy} onClick={createExtension} className="mt-4 rounded-full bg-neutral-900 px-5 py-3 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-40">
              Créer l’extension
            </button>
          </div>

          <div className="space-y-5">
            <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
              <h2 className="font-serif text-lg font-semibold">Clés SDK / API</h2>
              <p className="mt-1 text-xs text-neutral-500">Authentifie l’API développeur depuis vos outils CI (`Authorization: Bearer g3x_…`).</p>
              {newKey && (
                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                  <div className="text-xs text-emerald-600">Nouvelle clé (affichée une seule fois) :</div>
                  <code className="mt-1 block overflow-x-auto font-mono text-xs text-emerald-700">{newKey}</code>
                </div>
              )}
              <button disabled={busy} onClick={createApiKey} className="mt-3 rounded-xl border border-neutral-200 bg-white px-4 py-2.5 text-sm font-semibold hover:bg-neutral-50">Générer une clé</button>
              <ul className="mt-4 space-y-2 text-xs text-neutral-500">
                {apiKeys.map((key, index) => (
                  <li key={index} className="flex items-center justify-between gap-2 rounded-lg bg-neutral-50 px-3 py-2">
                    <span className="font-mono">{key.prefix}…</span>
                    <span className={key.status === "active" ? "text-emerald-600" : "text-neutral-400"}>{key.status === "active" ? "active" : key.status}</span>
                    {key.status === "active" && (
                      <button disabled={busy} onClick={() => revokeApiKey(key.prefix)} className="rounded-md border border-red-200 bg-red-50 px-2 py-1 font-semibold text-red-600 hover:bg-red-100 disabled:opacity-40">Révoquer</button>
                    )}
                  </li>
                ))}
                {apiKeys.length === 0 && <li>Aucune clé SDK pour le moment.</li>}
              </ul>
            </div>

            <div className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
              <h2 className="font-serif text-lg font-semibold">Revenus</h2>
              {revenue ? (
                <div className="mt-3 space-y-1 text-sm text-neutral-600">
                  <div>Brut : {(revenue.totalGrossMinor / 100).toLocaleString("fr-FR")} {revenue.currency}</div>
                  <div>Commission plateforme : {(revenue.totalFeeMinor / 100).toLocaleString("fr-FR")} {revenue.currency}</div>
                  <div className="font-semibold text-emerald-600">Net : {(revenue.totalNetMinor / 100).toLocaleString("fr-FR")} {revenue.currency}</div>
                  <p className="mt-2 text-xs text-neutral-400">{revenue.entries} transactions vérifiées (wallet/Chariow).</p>
                </div>
              ) : (
                <p className="mt-2 text-sm text-neutral-400">Aucun revenu pour le moment.</p>
              )}
            </div>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-serif text-xl font-semibold">Mes extensions publiées</h2>
          {extensions.length === 0 && <p className="text-sm text-neutral-400">Aucune extension — créez la première ci-dessus.</p>}
          {extensions.map((extension) => (
            <div key={extension.id} className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{extension.name}</h3>
                    <span className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                      extension.status === "approved" ? "bg-emerald-100 text-emerald-600" :
                      extension.status === "pending" ? "bg-amber-100 text-amber-700" :
                      extension.status === "rejected" || extension.status === "suspended" ? "bg-red-50 text-red-600" :
                      "bg-neutral-100 text-neutral-500"
                    }`}>{extension.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    {extension.id} · v{extension.latestVersion} · {extension.stats.installs} install. · {extension.stats.executions} exéc.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => void loadLogs(extension.id)} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Logs</button>
                  <button onClick={() => void loadSecrets(extension.id)} className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold hover:bg-neutral-50">Secrets</button>
                  <button disabled={busy || extension.status === "approved"} onClick={() => submit(extension.id, extension.latestVersion)} className="rounded-full bg-neutral-900 px-3 py-2 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-40">Soumettre v{extension.latestVersion}</button>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {extension.permissions.map((permission) => (
                  <span key={permission} className="rounded-md bg-neutral-100 px-2 py-0.5 font-mono text-[10px] text-neutral-500">{permission}</span>
                ))}
              </div>
              {selected === extension.id && (
                <div className="mt-4 rounded-xl border border-neutral-200 bg-neutral-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-neutral-400">Dernières exécutions</div>
                  <ul className="mt-2 space-y-1 font-mono text-[11px] text-neutral-500">
                    {logs.map((log, index) => (
                      <li key={index}>
                        {String(log.createdAt ? new Date(Number(log.createdAt)).toLocaleString("fr-FR") : "")} · {String(log.toolId)} · {String(log.status)} · {String(log.durationMs)}ms{log.error ? ` · ${String(log.error).slice(0, 120)}` : ""}
                      </li>
                    ))}
                    {logs.length === 0 && <li>Aucune exécution enregistrée.</li>}
                  </ul>
                </div>
              )}
              {selected === extension.id && secrets.length > 0 && (
                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <div className="text-xs uppercase tracking-widest text-amber-700">Secrets de l&apos;extension (stockés côté serveur, jamais relus)</div>
                  <div className="mt-3 space-y-3">
                    {secrets.map((secret) => (
                      <div key={secret.ref} className="flex flex-wrap items-center gap-2">
                        <code className="font-mono text-[11px] text-amber-800">{secret.ref}</code>
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${secret.configured ? "bg-emerald-100 text-emerald-700" : "bg-neutral-100 text-neutral-500"}`}>{secret.configured ? "configuré" : "non configuré"}</span>
                        <input
                          type="password"
                          autoComplete="off"
                          placeholder="valeur du secret"
                          value={secretValues[secret.ref] ?? ""}
                          onChange={(event) => setSecretValues((current) => ({ ...current, [secret.ref]: event.target.value }))}
                          className="min-w-40 flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs outline-none focus:border-amber-400"
                        />
                        <button disabled={busy} onClick={() => void saveSecret(extension.id, secret.ref)} className="rounded-lg bg-neutral-900 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-neutral-800 disabled:opacity-40">Enregistrer</button>
                        {secret.configured && <button disabled={busy} onClick={() => void removeSecret(extension.id, secret.ref)} className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40">Supprimer</button>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function Stat({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
      <div className="text-xs text-neutral-500">{title}</div>
      <div className="mt-2 text-xl font-bold">{value}</div>
    </div>
  );
}
