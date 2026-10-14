"use client";

import { useState } from "react";

import { authFetch, readJsonSafely } from "@/lib/firebase/auth-client";

/**
 * Carte « Connecter <App> » (Task 143 — axe 1) : quand un agent IA a besoin
 * d'une API que l'utilisateur n'a pas encore autorisée via les connecteurs,
 * la carte s'affiche SOUS la réponse avec le bouton de connexion OAuth
 * direct — l'utilisateur clique, autorise le service chez le fournisseur,
 * et revient dans la conversation pour relancer l'action.
 *
 * Flux exact du hub Intégrations (components/integrations/integrations-workspace.tsx) :
 *   POST /api/integrations/composio/connect { toolkit }
 *   → { authorizationUrl } → redirection pleine page vers l'OAuth Composio.
 */

/** Libellés lisibles des services populaires (slug Composio → nom). */
const TOOLKIT_LABELS: Record<string, string> = {
  github: "GitHub",
  gmail: "Gmail",
  slack: "Slack",
  googlecalendar: "Google Agenda",
  googledrive: "Google Drive",
  googlesheets: "Google Sheets",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  x: "X (Twitter)",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  notion: "Notion",
  hubspot: "HubSpot",
  salesforce: "Salesforce",
  shopify: "Shopify",
  stripe: "Stripe",
  airtable: "Airtable",
  zendesk: "Zendesk",
  servicenow: "ServiceNow",
  jira: "Jira",
  trello: "Trello",
  discord: "Discord",
  dropbox: "Dropbox",
  calendly: "Calendly",
  zoom: "Zoom",
};

function toolkitLabel(toolkit: string): string {
  const normalized = toolkit.trim().toLowerCase();
  return TOOLKIT_LABELS[normalized] ?? normalized.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

interface ConnectorConnectCardProps {
  /** Slugs Composio à connecter (dédupliqués par le moteur). */
  toolkits: string[];
}

export function ConnectorConnectCard({ toolkits }: ConnectorConnectCardProps) {
  const [busyToolkit, setBusyToolkit] = useState<string | null>(null);
  const [failedToolkit, setFailedToolkit] = useState<string | null>(null);
  if (toolkits.length === 0) return null;

  /** Lance la connexion OAuth d'un service (redirection vers Composio). */
  const connect = async (toolkit: string) => {
    if (busyToolkit) return;
    setBusyToolkit(toolkit);
    setFailedToolkit(null);
    try {
      const response = await authFetch("/api/integrations/composio/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolkit }),
      });
      const body = await readJsonSafely<{ authorizationUrl?: string; error?: string }>(response);
      if (!response.ok || !body?.authorizationUrl) {
        setFailedToolkit(toolkit);
        setBusyToolkit(null);
        return;
      }
      window.location.assign(body.authorizationUrl);
    } catch {
      setFailedToolkit(toolkit);
      setBusyToolkit(null);
    }
  };

  return (
    <div
      className="my-2 rounded-xl border border-[var(--g3-border-strong)] bg-[var(--g3-elevated)] p-3.5"
      data-missing-connectors={toolkits.join(",")}
      role="button"
      aria-label="Autoriser l'accès au service demandé par l'agent"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--g3-text)]">
          <span
            aria-hidden
            className="grid size-6 place-items-center rounded-full bg-[var(--g3-primary-soft,var(--g3-elevated))] text-xs text-[var(--g3-primary)]"
          >
            ⚿
          </span>
          {toolkits.length === 1
            ? `Accès ${toolkitLabel(toolkits[0]!)} requis`
            : `${toolkits.length} services à connecter`}
        </p>
        <span className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--g3-muted)]">
          Autorisation du compte
        </span>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-[var(--g3-text-secondary)]">
        Pour exécuter cette demande, l&apos;agent a besoin de votre autorisation. Cliquez sur le service
        concerné : vous serez redirigé vers sa page de connexion sécurisée (OAuth), puis ramené ici —
        renvoyez ensuite votre demande pour que l&apos;agent agisse avec l&apos;accès accordé.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {toolkits.map((toolkit) => (
          <button
            key={toolkit}
            type="button"
            onClick={() => void connect(toolkit)}
            disabled={busyToolkit !== null}
            className="g3-btn g3-btn-primary rounded-full text-xs"
            aria-label={`Connecter ${toolkitLabel(toolkit)}`}
          >
            {busyToolkit === toolkit ? "Redirection…" : `Connecter ${toolkitLabel(toolkit)}`}
          </button>
        ))}
        <a
          href="/integrations"
          className="g3-btn g3-btn-ghost rounded-full text-xs"
          aria-label="Gérer toutes les connexions"
        >
          Toutes mes connexions
        </a>
      </div>

      {failedToolkit && (
        <p className="mt-2 text-[11px] text-[var(--g3-warning-strong)]" role="alert">
          La connexion de {toolkitLabel(failedToolkit)} n&apos;a pas pu être initiée. Réessayez dans un
          instant ou connectez le service depuis la page Intégrations.
        </p>
      )}
    </div>
  );
}
