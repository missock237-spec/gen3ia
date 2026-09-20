"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

interface CatalogEntry {
  toolkit: string;
  label: string;
  description: string;
  category: string;
  auth: string;
}

interface HubConnection {
  id: string;
  toolkit: string;
  label: string;
  category: string;
  status: string;
  enabled: boolean;
}

interface OutgoingWebhook {
  id: string;
  url: string;
  events: string[];
  description?: string;
  disabled: boolean;
  createdAt: number;
}

interface MessagingPreferences {
  channel: "whatsapp" | "telegram" | "slack";
  recipient: string;
  approvalsEnabled: boolean;
}

interface PlatformStatus {
  messaging: { whatsapp: boolean; telegram: boolean; slack: boolean };
  email: boolean;
  composio: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  messaging: "Messagerie",
  social: "Réseaux sociaux",
  email_calendar: "Email & Calendrier",
  crm: "CRM",
  ecommerce: "E-commerce & Paiements",
  developer: "Développement",
  knowledge: "Base de connaissances",
  data: "Données",
  other: "Autres",
};

const EVENT_LABELS: Record<string, string> = {
  "approval.requested": "Approbation demandée",
  "approval.approved": "Approbation accordée",
  "approval.rejected": "Action refusée",
  "approval.completed": "Action terminée",
  "approval.failed": "Action en échec",
  "execution.completed": "Exécution terminée",
  "execution.failed": "Exécution en échec",
  "test.ping": "Ping de test",
};

const CHANNEL_HINTS: Record<string, string> = {
  whatsapp: "Numéro international, ex. +237690000000",
  telegram: "Chat ID numérique ou @nomdecanal",
  slack: "ID de canal (C123456) ou #canal",
};

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm text-neutral-500">{subtitle}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function IntegrationsWorkspace() {
  const sessionAvailable = useSessionAvailable();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [connections, setConnections] = useState<HubConnection[]>([]);
  const [webhooks, setWebhooks] = useState<OutgoingWebhook[]>([]);
  const [availableEvents, setAvailableEvents] = useState<string[]>([]);
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [preferences, setPreferences] = useState<MessagingPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDescription, setWebhookDescription] = useState("");
  const [webhookEvents, setWebhookEvents] = useState<string[]>(["approval.requested"]);
  const [webhookSecret, setWebhookSecret] = useState("");
  const [webhookError, setWebhookError] = useState("");

  const [prefChannel, setPrefChannel] = useState<"whatsapp" | "telegram" | "slack">("telegram");
  const [prefRecipient, setPrefRecipient] = useState("");
  const [prefApprovals, setPrefApprovals] = useState(true);
  const [prefMessage, setPrefMessage] = useState("");

  const reload = useCallback(async () => {
    setError("");
    try {
      const [catalogRes, connectionsRes, webhooksRes, statusRes, prefsRes] = await Promise.all([
        authFetch("/api/integrations/catalog", { cache: "no-store" }),
        authFetch("/api/integrations/composio/connections", { cache: "no-store" }),
        authFetch("/api/integrations/webhooks", { cache: "no-store" }),
        authFetch("/api/integrations/status", { cache: "no-store" }),
        authFetch("/api/integrations/messaging/preferences", { cache: "no-store" }),
      ]);
      if (catalogRes.ok) setCatalog(((await catalogRes.json()) as { catalog: CatalogEntry[] }).catalog);
      if (connectionsRes.ok) setConnections(((await connectionsRes.json()) as { connections: HubConnection[] }).connections);
      if (webhooksRes.ok) {
        const body = (await webhooksRes.json()) as { webhooks: OutgoingWebhook[]; availableEvents: string[] };
        setWebhooks(body.webhooks ?? []);
        setAvailableEvents(body.availableEvents ?? []);
      }
      if (statusRes.ok) setStatus((await statusRes.json()) as PlatformStatus);
      if (prefsRes.ok) {
        const body = (await prefsRes.json()) as { preferences: MessagingPreferences | null };
        if (body.preferences) {
          setPreferences(body.preferences);
          setPrefChannel(body.preferences.channel);
          setPrefRecipient(body.preferences.recipient);
          setPrefApprovals(body.preferences.approvalsEnabled ?? true);
        }
      }
    } catch {
      setError("Impossible de charger vos intégrations. Réessayez.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionAvailable === true) void reload();
    else if (sessionAvailable === false) setLoading(false);
  }, [sessionAvailable, reload]);

  const catalogByCategory = useMemo(() => {
    const groups = new Map<string, CatalogEntry[]>();
    for (const entry of catalog) {
      const list = groups.get(entry.category) ?? [];
      list.push(entry);
      groups.set(entry.category, list);
    }
    return groups;
  }, [catalog]);

  async function connect(toolkit: string) {
    setConnecting(toolkit);
    setError("");
    try {
      const response = await authFetch("/api/integrations/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit }),
      });
      const body = (await response.json()) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !body.authorizationUrl) {
        setError(body.error ?? "Connexion impossible.");
        return;
      }
      window.location.href = body.authorizationUrl;
    } catch {
      setError("Connexion impossible. Réessayez.");
    } finally {
      setConnecting(null);
    }
  }

  async function revoke(connectionId: string) {
    setError("");
    try {
      const response = await authFetch("/api/integrations/composio/connections", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ connectionId }),
      });
      if (response.ok) setConnections((previous) => previous.filter((connection) => connection.id !== connectionId));
      else setError("Révocation impossible.");
    } catch {
      setError("Révocation impossible.");
    }
  }

  async function createWebhook() {
    setWebhookError("");
    setWebhookSecret("");
    try {
      const response = await authFetch("/api/integrations/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: webhookUrl.trim(), events: webhookEvents, description: webhookDescription.trim() || undefined }),
      });
      const body = (await response.json()) as { webhook?: OutgoingWebhook & { secret: string }; error?: string };
      if (!response.ok || !body.webhook) {
        setWebhookError(body.error ?? "Création impossible.");
        return;
      }
      setWebhooks((previous) => [{ ...body.webhook!, secret: undefined } as unknown as OutgoingWebhook, ...previous]);
      setWebhookSecret(body.webhook.secret);
      setWebhookUrl("");
      setWebhookDescription("");
    } catch {
      setWebhookError("Création impossible.");
    }
  }

  async function deleteWebhook(webhookId: string) {
    try {
      const response = await authFetch("/api/integrations/webhooks", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookId }),
      });
      if (response.ok) setWebhooks((previous) => previous.filter((webhook) => webhook.id !== webhookId));
    } catch {
      /* silencieux */
    }
  }

  async function toggleWebhook(webhook: OutgoingWebhook) {
    try {
      const response = await authFetch("/api/integrations/webhooks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ webhookId: webhook.id, disabled: !webhook.disabled }),
      });
      if (response.ok) setWebhooks((previous) => previous.map((item) => (item.id === webhook.id ? { ...item, disabled: !webhook.disabled } : item)));
    } catch {
      /* silencieux */
    }
  }

  async function savePreferences() {
    setPrefMessage("");
    try {
      const response = await authFetch("/api/integrations/messaging/preferences", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: prefChannel, recipient: prefRecipient.trim(), approvalsEnabled: prefApprovals }),
      });
      const body = (await response.json()) as { preferences?: MessagingPreferences; error?: string };
      setPrefMessage(response.ok ? "Préférences enregistrées." : body.error ?? "Enregistrement impossible.");
    } catch {
      setPrefMessage("Enregistrement impossible.");
    }
  }

  if (sessionAvailable === false) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Connectez-vous pour gérer vos intégrations</h1>
        <a href="/login" className="mt-4 inline-block rounded-xl bg-neutral-900 px-5 py-3 text-sm font-semibold text-white">Se connecter</a>
      </div>
    );
  }

  const connectedToolkits = new Set(connections.filter((connection) => connection.enabled && connection.status === "ACTIVE").map((connection) => connection.toolkit));
  const categoriesToShow = statusFilter === "all" ? [...catalogByCategory.keys()] : [statusFilter];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6 sm:pt-10">
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Plateforme</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">Intégrations</h1>
        <p className="mt-2 max-w-2xl text-sm text-neutral-600">
          Connectez vos services externes à vos agents : messagerie, réseaux sociaux, email, calendrier, CRM, paiements. Chaque action externe sensible reste soumise à votre approbation — même depuis votre téléphone.
        </p>
      </header>

      {error ? <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}

      {loading ? (
        <p className="mt-10 text-sm text-neutral-500">Chargement des intégrations…</p>
      ) : (
        <div className="mt-6 grid gap-5">
          {/* Statut plateforme */}
          <SectionCard title="Canaux natifs de la plateforme" subtitle="Fournisseurs configurés côté serveur, disponibles immédiatement pour vos agents.">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {[
                { label: "WhatsApp", ok: status?.messaging.whatsapp },
                { label: "Telegram", ok: status?.messaging.telegram },
                { label: "Slack", ok: status?.messaging.slack },
                { label: "Email (Resend)", ok: status?.email },
                { label: "Composio Hub", ok: status?.composio },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border border-neutral-200 px-4 py-3">
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className={`mt-1 text-xs font-semibold ${item.ok ? "text-emerald-600" : "text-neutral-400"}`}>{item.ok ? "● Actif" : "○ Non configuré"}</p>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* Connexions actives */}
          <SectionCard title={`Connexions actives (${connections.length})`} subtitle="Comptes OAuth liés à vos agents. Vous pouvez révoquer une connexion à tout moment.">
            {connections.length === 0 ? (
              <p className="text-sm text-neutral-500">Aucune connexion pour le moment. Choisissez un service dans le catalogue ci-dessous.</p>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2">
                {connections.map((connection) => (
                  <li key={connection.id} className="flex items-center justify-between gap-3 rounded-xl border border-neutral-200 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{connection.label}</p>
                      <p className="text-xs text-neutral-500">{CATEGORY_LABELS[connection.category] ?? connection.category} · {connection.status}</p>
                    </div>
                    <button type="button" onClick={() => revoke(connection.id)} className="shrink-0 rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-100">
                      Révoquer
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          {/* Catalogue */}
          <SectionCard title="Catalogue de services" subtitle="Cliquez sur Connecter pour autoriser un service via OAuth sécurisé.">
            <div className="mb-4 flex flex-wrap gap-2">
              <button type="button" onClick={() => setStatusFilter("all")} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${statusFilter === "all" ? "bg-neutral-900 text-white" : "border border-neutral-300"}`}>
                Tous
              </button>
              {[...catalogByCategory.keys()].map((category) => (
                <button key={category} type="button" onClick={() => setStatusFilter(category)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${statusFilter === category ? "bg-neutral-900 text-white" : "border border-neutral-300"}`}>
                  {CATEGORY_LABELS[category] ?? category}
                </button>
              ))}
            </div>
            <div className="grid gap-5">
              {categoriesToShow.map((category) => (
                <div key={category}>
                  <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">{CATEGORY_LABELS[category] ?? category}</h3>
                  <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {(catalogByCategory.get(category) ?? []).map((entry) => (
                      <li key={entry.toolkit} className="flex flex-col justify-between rounded-xl border border-neutral-200 p-4">
                        <div>
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-semibold">{entry.label}</p>
                            {connectedToolkits.has(entry.toolkit) ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">Connecté</span> : null}
                          </div>
                          <p className="mt-1 text-xs text-neutral-500">{entry.description}</p>
                        </div>
                        <button
                          type="button"
                          disabled={connecting === entry.toolkit}
                          onClick={() => connect(entry.toolkit)}
                          className="mt-3 w-full rounded-lg bg-neutral-900 px-3 py-2 text-xs font-semibold text-white hover:bg-neutral-700 disabled:opacity-50"
                        >
                          {connecting === entry.toolkit ? "Connexion…" : connectedToolkits.has(entry.toolkit) ? "Connecter un autre compte" : "Connecter"}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </SectionCard>

          {/* Notifications & approbation distante */}
          <SectionCard title="Notifications & approbation depuis votre messagerie" subtitle="Recevez les demandes d'approbation d'actions sensibles sur WhatsApp, Telegram ou Slack, et approuvez-les d'un clic depuis votre téléphone.">
            {status && !status.messaging.whatsapp && !status.messaging.telegram && !status.messaging.slack ? (
              <p className="text-sm text-neutral-500">Aucun canal de messagerie n&apos;est encore activé sur la plateforme. Les connexions OAuth du catalogue restent disponibles.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Canal</span>
                  <select value={prefChannel} onChange={(event) => setPrefChannel(event.target.value as typeof prefChannel)} className="w-full rounded-xl border border-neutral-300 px-3 py-2">
                    {status?.messaging.whatsapp ? <option value="whatsapp">WhatsApp</option> : null}
                    {status?.messaging.telegram ? <option value="telegram">Telegram</option> : null}
                    {status?.messaging.slack ? <option value="slack">Slack</option> : null}
                  </select>
                </label>
                <label className="text-sm sm:col-span-2">
                  <span className="mb-1 block font-medium">Destinataire</span>
                  <input value={prefRecipient} onChange={(event) => setPrefRecipient(event.target.value)} placeholder={CHANNEL_HINTS[prefChannel]} className="w-full rounded-xl border border-neutral-300 px-3 py-2" />
                </label>
                <label className="flex items-center gap-2 text-sm sm:col-span-3">
                  <input type="checkbox" checked={prefApprovals} onChange={(event) => setPrefApprovals(event.target.checked)} className="h-4 w-4" />
                  <span>Recevoir les demandes d&apos;approbation par message (liens signés, expirent automatiquement)</span>
                </label>
                <div className="sm:col-span-3">
                  <button type="button" onClick={savePreferences} className="rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-neutral-700">
                    Enregistrer
                  </button>
                  {prefMessage ? <span className="ml-3 text-sm text-neutral-600">{prefMessage}</span> : null}
                </div>
              </div>
            )}
          </SectionCard>

          {/* Webhooks sortants */}
          <SectionCard title="Webhooks sortants" subtitle="Émettez les événements Gen3ia (approbation, exécution, échec) vers n8n, Make, Zapier ou votre API. Livraisons signées HMAC-SHA256.">
            <div className="grid gap-3 sm:grid-cols-2">
              <input value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://votre-api.example.com/hook" className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm" />
              <input value={webhookDescription} onChange={(event) => setWebhookDescription(event.target.value)} placeholder="Description (optionnel)" className="w-full rounded-xl border border-neutral-300 px-3 py-2 text-sm" />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
              {availableEvents.map((event) => (
                <label key={event} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={webhookEvents.includes(event)}
                    onChange={(checkedEvent) =>
                      setWebhookEvents((previous) => (checkedEvent.target.checked ? [...previous, event] : previous.filter((item) => item !== event)))
                    }
                    className="h-3.5 w-3.5"
                  />
                  <span>{EVENT_LABELS[event] ?? event}</span>
                </label>
              ))}
            </div>
            <button type="button" onClick={createWebhook} disabled={!webhookUrl.trim() || webhookEvents.length === 0} className="mt-3 rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-neutral-700 disabled:opacity-50">
              Ajouter l&apos;endpoint
            </button>
            {webhookError ? <p className="mt-2 text-sm text-red-600">{webhookError}</p> : null}
            {webhookSecret ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
                <p className="font-semibold text-amber-800">Secret de signature (affiché une seule fois) :</p>
                <code className="mt-1 block break-all text-xs text-amber-900">{webhookSecret}</code>
              </div>
            ) : null}

            <ul className="mt-4 grid gap-3">
              {webhooks.map((webhook) => (
                <li key={webhook.id} className="rounded-xl border border-neutral-200 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{webhook.url}</p>
                      <p className="mt-0.5 truncate text-xs text-neutral-500">{webhook.events.map((event) => EVENT_LABELS[event] ?? event).join(" · ")}</p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button type="button" onClick={() => toggleWebhook(webhook)} className="rounded-lg border border-neutral-300 px-3 py-1.5 text-xs font-semibold hover:bg-neutral-100">
                        {webhook.disabled ? "Activer" : "Désactiver"}
                      </button>
                      <button type="button" onClick={() => deleteWebhook(webhook.id)} className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">
                        Supprimer
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      )}
    </div>
  );
}
