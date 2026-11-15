"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import { PlanificationsWorkspace } from "@/components/planifications/planifications-workspace";
import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";

/**
 * Espace Automatisations — console client unifiée.
 *
 * FUSION DES SURFACES (restructuration des parcours) : l'ancienne page
 * /planifications (workspace riche : fenêtres récurrentes, one-shot,
 * veille RSS/Web, webhook entrant, historique réel) devient l'onglet
 * « Planifications » de cet espace — aux côtés de l'onglet « Agents »
 * (liste, statut, création). La page /planifications redirige désormais
 * vers /automations#planifications : un seul parcours identifiable pour
 * « Création d'agents » et « Tâches planifiées », conformément à la table
 * de correspondance fonctionnalité → destination.
 *
 * Les routes d'ORCHESTRATION restent réservées au système : cette console
 * liste, crée (provisionnement standard) et organise — elle ne pilote
 * jamais l'exécution elle-même.
 */

type TabId = "agents" | "planifications";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "agents", label: "Agents" },
  { id: "planifications", label: "Planifications" },
];

interface AgentSummary {
  id: string;
  name: string;
  description: string;
  type: string;
  typeLabel?: string;
  status: string;
  autonomous: boolean;
  tools: string[];
  createdAt?: string;
  updatedAt?: string;
}

function Badge({ label, className }: { label: string; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${className ?? "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
      {label}
    </span>
  );
}

export function AutomationsConsole() {
  const sessionDisponible = useSessionAvailable();

  const [tab, setTab] = useState<TabId>("agents");
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Formulaire agent
  const [agentFormOpen, setAgentFormOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");

  // Liens profonds (#planifications depuis la page d'accueil) : ouvrent
  // directement l'onglet demandé.
  useEffect(() => {
    const appliquer = () => {
      const hash = window.location.hash.replace("#", "") as TabId;
      if (TABS.some((item) => item.id === hash)) setTab(hash);
    };
    appliquer();
    window.addEventListener("hashchange", appliquer);
    return () => window.removeEventListener("hashchange", appliquer);
  }, []);

  const chargerAgents = useCallback(async () => {
    setLoadError(null);
    try {
      const response = await authFetch("/api/agents", { cache: "no-store" });
      if (response.ok) {
        const data = await readJsonSafely<{ agents?: AgentSummary[] }>(response);
        setAgents(data?.agents ?? []);
      } else if (response.status !== 401) {
        setLoadError("Impossible de charger vos agents.");
      }
    } catch {
      setLoadError("Connexion au serveur impossible. Vérifiez votre réseau puis réessayez.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    void chargerAgents();
  }, [sessionDisponible, chargerAgents]);

  const creerAgent = async () => {
    if (agentName.trim().length < 2) return;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const response = await authFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: agentName.trim(),
          description: agentDescription.trim() || `Agent Gen3ia dédié : ${agentName.trim()}.`,
          type: "universal",
          status: "active",
        }),
      });
      const data = await readJsonSafely<{ agent?: AgentSummary; error?: string }>(response);
      const agentCree = data?.agent;
      if (!response.ok || !agentCree) {
        throw new Error(data?.error ?? `La création a échoué (erreur ${response.status}).`);
      }
      setAgents((prev) => [agentCree, ...prev]);
      setAgentName("");
      setAgentDescription("");
      setAgentFormOpen(false);
      setNotice(`Agent « ${agentCree.name} » créé — planifiez ses tâches dans l'onglet Planifications.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "La création de l'agent a échoué.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6">
      <SectionHeader
        eyebrow="GEN3IA · AUTOMATISATIONS"
        title="Espace"
        highlight="automatisations"
        description="Vos agents exécutent l'opérationnel pendant que vous avancez : créez un agent, planifiez ses tâches récurrentes, consultez chaque exécution. Les actions sensibles attendent toujours votre validation."
        action={
          tab === "agents" ? (
            <button
              type="button"
              onClick={() => setAgentFormOpen((open) => !open)}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_30px_-12px_var(--g3-primary)] transition hover:brightness-110"
            >
              <span aria-hidden="true">{agentFormOpen ? "×" : "+"}</span>
              {agentFormOpen ? "Fermer" : "Nouvel agent"}
            </button>
          ) : undefined
        }
      />

      {notice && (
        <p className="mb-4 rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]" role="status">
          {notice}
        </p>
      )}
      {actionError && (
        <div className="mb-4 rounded-2xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]" role="alert">
          {actionError}
          <button type="button" onClick={() => void chargerAgents()} className="ml-3 underline underline-offset-2">
            Réessayer
          </button>
        </div>
      )}

      {/* Onglets */}
      <div className="mb-5 flex gap-1.5 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-1.5" role="tablist" aria-label="Sections des automatisations">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => { setTab(item.id); window.history.replaceState(null, "", `#${item.id}`); }}
            className={`min-h-11 flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition sm:flex-none sm:px-8 ${tab === item.id ? "bg-[var(--g3-elevated)] text-[var(--g3-text)] shadow-sm" : "text-[var(--g3-muted)] hover:text-[var(--g3-text)]"}`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {sessionDisponible === false ? (
        <EmptyState
          icon="◷"
          title="Connectez-vous pour automatiser"
          description="Vos agents et planifications restent rattachés à votre compte : ils tournent sur les serveurs Gen3ia, 24h/24."
          action={
            <a href="/login" className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white">
              Se connecter
            </a>
          }
        />
      ) : tab === "planifications" ? (
        // Workspace complet (restauration 10-2026) embarqué comme onglet :
        // fenêtres récurrentes, one-shot, veille RSS/Web, webhook entrant,
        // exécution manuelle, pause/reprise, historique réel.
        <PlanificationsWorkspace embedded />
      ) : !loaded ? (
        <LoadingState label="Chargement des automatisations…" rows={3} />
      ) : loadError && agents.length === 0 ? (
        <EmptyState
          icon="⚠"
          title="Automatisations indisponibles"
          description={loadError}
          action={
            <button type="button" onClick={() => void chargerAgents()} className="inline-flex min-h-11 items-center rounded-full border border-[var(--g3-border)] px-5 py-2.5 text-sm font-semibold">
              Réessayer
            </button>
          }
        />
      ) : (
        <AgentsTab
          agents={agents}
          formOpen={agentFormOpen}
          name={agentName}
          description={agentDescription}
          busy={busy}
          onName={setAgentName}
          onDescription={setAgentDescription}
          onSubmit={() => void creerAgent()}
        />
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* Onglet Agents                                                       */
/* ------------------------------------------------------------------ */

function AgentsTab({
  agents,
  formOpen,
  name,
  description,
  busy,
  onName,
  onDescription,
  onSubmit,
}: {
  agents: AgentSummary[];
  formOpen: boolean;
  name: string;
  description: string;
  busy: boolean;
  onName: (value: string) => void;
  onDescription: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-5">
      {formOpen && (
        <form
          className="grid gap-4 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 sm:grid-cols-2"
          onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
        >
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Nom de l&apos;agent
            <input
              value={name}
              onChange={(event) => onName(event.target.value)}
              required
              minLength={2}
              maxLength={80}
              placeholder="ex. Veille concurrentielle"
              className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
            />
          </label>
          <label className="text-sm font-medium text-[var(--g3-text-secondary)]">
            Mission (facultatif)
            <input
              value={description}
              onChange={(event) => onDescription(event.target.value)}
              maxLength={500}
              placeholder="ex. Surveiller les prix et nouveautés du secteur"
              className="mt-1.5 w-full min-h-11 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3.5 py-2.5 text-sm text-[var(--g3-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--g3-primary)]"
            />
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy || name.trim().length < 2}
              className="inline-flex min-h-11 items-center rounded-full bg-[var(--g3-primary)] px-6 py-2.5 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "Création…" : "Créer l'agent"}
            </button>
          </div>
        </form>
      )}

      {agents.length === 0 ? (
        <EmptyState
          icon="◷"
          title="Aucun agent"
          description="Créez votre premier agent : donnez-lui un nom et une mission, puis planifiez ses tâches dans l'onglet Planifications. Vous pouvez aussi tout demander en langage naturel depuis le Chat IA."
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {agents.map((agent) => (
            <li key={agent.id} className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-[var(--g3-text)]">{agent.name}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-[var(--g3-muted)]">{agent.description || "Sans mission décrite."}</p>
                </div>
                <Badge
                  label={agent.status === "active" ? "Actif" : agent.status === "paused" ? "En pause" : agent.status}
                  className={agent.status === "active" ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : undefined}
                />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--g3-faint)]">
                <Badge label={agent.typeLabel || agent.type} />
                {agent.autonomous && <Badge label="Autonome" className="bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]" />}
                <span>{agent.tools?.length ?? 0} outil(s)</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
