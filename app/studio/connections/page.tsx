"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { SectionHeader } from "@/components/shells/section-header";
import { ResourceList, type ResourceRow } from "@/components/shells/resource-list";
import { StatusBadge } from "@/components/shells/status-badge";
import { EmptyState, LoadingState, MetricCard } from "@/components/shells/states";
import { PermissionNotice } from "@/components/shells/permission-notice";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * /studio/connections — Connexions de l'espace utilisateur : applications
 * connectées (hub Composio), état vérifié et permissions, plus l'état des
 * services natifs (recherche, messagerie, voix).
 */

interface HubConnection {
  id: string;
  toolkit: string;
  label: string;
  category: string;
  status: string;
  enabled: boolean;
  verified: boolean;
}

interface ServiceStatus {
  search?: { provider?: string; configured?: boolean };
  voice?: { elevenlabs?: boolean };
  composio?: boolean;
  email?: boolean;
  messaging?: Record<string, unknown>;
}

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<HubConnection[]>([]);
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unauthenticated, setUnauthenticated] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setUnauthenticated(false);
    try {
      const [connectionsResponse, statusResponse] = await Promise.allSettled([
        authFetch("/api/integrations/composio/connections", { cache: "no-store" }),
        authFetch("/api/integrations/status", { cache: "no-store" }),
      ]);
      if (connectionsResponse.status === "fulfilled") {
        const response = connectionsResponse.value;
        if (response.status === 401) setUnauthenticated(true);
        else if (response.ok) {
          const data = (await response.json()) as { connections?: HubConnection[] };
          setConnections(data.connections ?? []);
        }
      }
      if (statusResponse.status === "fulfilled" && statusResponse.value.ok) {
        setStatus((await statusResponse.value.json()) as ServiceStatus);
      }
      if (connectionsResponse.status === "rejected") {
        throw new Error("Le hub de connexions est momentanément indisponible.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Impossible de charger vos connexions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const verifiedCount = connections.filter((connection) => connection.verified).length;

  const connectionRows: ResourceRow[] = useMemo(
    () =>
      connections.map((connection) => ({
        id: connection.id,
        icon: connection.label.slice(0, 1).toUpperCase(),
        title: connection.label,
        meta: `${connection.toolkit} · ${connection.category}${connection.verified ? " · vérifié" : ""}`,
        status: connection.verified ? "connected" : connection.enabled ? "unauthorized" : "disconnected",
        statusLabel: undefined,
        action: (
          <StatusBadge
            status={connection.verified ? "ok" : "warning"}
            label={connection.verified ? "Vérifié" : connection.enabled ? "À vérifier" : "Désactivée"}
          />
        ),
      })),
    [connections],
  );

  const serviceRows: ResourceRow[] = useMemo(() => {
    if (!status) return [];
    const rows: ResourceRow[] = [
      {
        id: "search",
        icon: "⌕",
        title: "Recherche web",
        meta: status.search?.provider ? `Fournisseur : ${status.search.provider}` : "Non configurée",
        status: status.search?.configured ? "ok" : "disabled",
        statusLabel: status.search?.configured ? "Configurée" : "Non configurée",
      },
      {
        id: "composio",
        icon: "⧉",
        title: "Catalogue Composio (1000+ apps)",
        meta: "Connecteurs applicatifs de la plateforme",
        status: status.composio ? "ok" : "disabled",
        statusLabel: status.composio ? "Opérationnel" : "Indisponible",
      },
      {
        id: "email",
        icon: "✉",
        title: "Envoi d'e-mails",
        meta: "Notifications et livrables par e-mail",
        status: status.email ? "ok" : "disabled",
        statusLabel: status.email ? "Configuré" : "Non configuré",
      },
      {
        id: "voice",
        icon: "♪",
        title: "Voix (ElevenLabs)",
        meta: "Appels et réponses audio des agents",
        status: status.voice?.elevenlabs ? "ok" : "disabled",
        statusLabel: status.voice?.elevenlabs ? "Configurée" : "Non configurée",
      },
    ];
    return rows;
  }, [status]);

  return (
    <div className="space-y-7">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL / CONNEXIONS"
        title="Connexions"
        description="Les applications connectées à vos missions, leur état vérifié et leurs permissions. Les connecteurs utilisés par une mission restent visibles dans le contexte de la mission."
        breadcrumbs={[{ label: "Missions", href: "/studio" }, { label: "Connexions" }]}
        action={
          <Link href="/integrations" className="g3-btn g3-btn-ghost text-xs">
            Ajouter une intégration
          </Link>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Applications" value={connections.length} hint="Hub de connecteurs" />
        <MetricCard label="Vérifiées" value={verifiedCount} hint="État actif confirmé" />
        <MetricCard label="Services natifs" value={serviceRows.filter((row) => row.status === "ok").length} hint="Recherche, e-mail, voix…" />
      </div>

      {error && (
        <PermissionNotice
          tone="danger"
          title="Chargement impossible"
          description={error}
          actions={
            <button type="button" onClick={() => void load()} className="rounded-full border border-[var(--g3-border-strong)] bg-[var(--g3-surface)] px-4 py-2 text-xs font-semibold">
              Réessayer
            </button>
          }
        />
      )}

      {unauthenticated && (
        <PermissionNotice
          tone="info"
          title="Connectez-vous pour gérer vos connexions"
          actions={
            <Link href="/login" className="rounded-full bg-[var(--g3-deep)] px-4 py-2 text-xs font-semibold text-white">
              Se connecter
            </Link>
          }
        />
      )}

      {loading && <LoadingState rows={4} />}

      {!loading && !unauthenticated && (
        <>
          <section aria-label="Applications connectées">
            <h2 className="mb-3 font-serif text-lg font-semibold text-[var(--g3-text)]">Applications connectées</h2>
            <ResourceList
              rows={connectionRows}
              ariaLabel="Applications connectées"
              emptyState={
                <EmptyState
                  icon="⧉"
                  title="Aucune application connectée"
                  description="Connectez vos outils (Gmail, Notion, Slack…) : vos missions pourront les utiliser en toute sécurité."
                  action={
                    <Link href="/integrations" className="g3-btn g3-btn-primary text-xs">
                      Explorer les intégrations
                    </Link>
                  }
                />
              }
            />
          </section>

          {serviceRows.length > 0 && (
            <section aria-label="Services de la plateforme">
              <h2 className="mb-3 font-serif text-lg font-semibold text-[var(--g3-text)]">Services de la plateforme</h2>
              <ResourceList rows={serviceRows} ariaLabel="Services de la plateforme" />
            </section>
          )}
        </>
      )}
    </div>
  );
}
