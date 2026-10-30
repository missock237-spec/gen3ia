"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { authFetch, readJsonSafely, useSessionAvailable } from "@/lib/firebase/auth-client";
import { StudioHeader } from "@/components/studio/studio-header";
import { Callout } from "@/components/studio/callout";
import { toolLabel } from "@/lib/tools/labels";

/**
 * Usage par organisation (/observability/org — it.51, Task 43 du
 * saas-roadmap §3) : la vue d'usage AGRÉGÉ PAR ORGANISATION, jumeau
 * entreprise de la vue personnelle (/observability). La porte
 * GET /api/observability/org (requireUser + requireOrgContext — 404
 * uniforme si l'org est absente ou si l'appelant n'en est pas membre)
 * restitue les exécutions des membres de l'org, agrégées par agent /
 * outil / jour : totaux (exécutions, succès, échecs, coûts, tokens,
 * durée moyenne), adoption par agent, outils les plus appelés, activité
 * quotidienne. Les données sont AGRÉGÉES : aucun contenu conversationnel
 * n'est exposé, seules les métriques d'usage sont restituées telles
 * quelles par la porte.
 *
 * Conventions du fichier : authFetch same-origin (cookie gen3ia_session),
 * états honnêtes (401 connexion, 404 restitué tel quel, échec réseau
 * affiché role=alert), garde anti-course (la réponse d'une org ou d'une
 * fenêtre périmée n'écrase jamais la plus récente), zéro nouveau CSS
 * (variables g3 existantes).
 */

interface OrganizationOption {
  id: string;
  name: string;
  plan: string;
  myRole: string;
  memberCount: number;
}

interface OrgUsageOverview {
  orgId: string;
  windowDays: number;
  membersCovered: number;
  totals: {
    executions: number;
    completed: number;
    failed: number;
    running: number;
    waitingApproval: number;
    successRate: number;
    chargeMinor: number;
    currency: string;
    providerCostEur: number;
    inputTokens: number;
    outputTokens: number;
    avgDurationMs: number;
  };
  byAgent: Array<{
    agentId: string;
    executions: number;
    failed: number;
    chargeMinor: number;
    inputTokens: number;
    outputTokens: number;
    providerCostEur: number;
  }>;
  byTool: Array<{ name: string; count: number; failed: number }>;
  byDay: Array<{ date: string; count: number; failed: number }>;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "propriétaire",
  admin: "admin",
  member: "membre",
  viewer: "observateur",
};

function formatCharge(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1_000)} s`;
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">{label}</p>
      <p className="mt-1 font-serif text-2xl font-semibold text-[var(--g3-text)]">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-[var(--g3-faint)]">{hint}</p> : null}
    </div>
  );
}

export function OrgUsageConsole() {
  const sessionDisponible = useSessionAvailable();

  // Sélecteur d'organisation (GET /api/organizations — orgs du compte).
  const [orgs, setOrgs] = useState<OrganizationOption[]>([]);
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [orgsError, setOrgsError] = useState<string | null>(null);
  const [orgId, setOrgId] = useState("");

  // Vue d'usage (GET /api/observability/org?orgId=…&days=…).
  const [days, setDays] = useState(14);
  const [usage, setUsage] = useState<OrgUsageOverview | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);

  // Garde anti-désordre : si l'utilisateur change d'org ou de fenêtre
  // pendant qu'une requête est en vol, la réponse périmée ne doit pas
  // écraser la plus récente (ni réafficher une erreur obsolète).
  const loadTokenRef = useRef(0);

  const chargerOrganisations = useCallback(async () => {
    setOrgsError(null);
    try {
      const response = await authFetch("/api/organizations", { cache: "no-store" });
      const data = await readJsonSafely<{ organizations?: OrganizationOption[]; error?: string }>(response);
      if (response.status === 401) {
        setOrgsError("Connectez-vous pour consulter l'usage de votre organisation.");
        return;
      }
      if (!response.ok || !data?.organizations) {
        throw new Error(data?.error ?? "Organisations indisponibles.");
      }
      setOrgs(data.organizations);
      // Sélection immédiate de la première org : la page n'existe que pour
      // cette vue — l'usage part dès qu'une org est sélectionnée (effect
      // conditionné, zéro requête tant qu'aucune org n'est disponible).
      setOrgId(data.organizations[0]?.id ?? "");
    } catch (error) {
      setOrgsError(error instanceof Error ? error.message : "Organisations indisponibles (réseau).");
    } finally {
      setOrgsLoaded(true);
    }
  }, []);

  const chargerUsage = useCallback(async (nextOrg: string, nextDays: number) => {
    if (!nextOrg) return;
    const token = ++loadTokenRef.current;
    setUsageLoading(true);
    setUsageError(null);
    try {
      const params = new URLSearchParams({ orgId: nextOrg, days: String(nextDays) });
      const response = await authFetch(`/api/observability/org?${params.toString()}`, { cache: "no-store" });
      const data = await readJsonSafely<OrgUsageOverview & { error?: string }>(response);
      if (token !== loadTokenRef.current) return;
      if (response.status === 401) {
        setUsageError("Connectez-vous pour consulter l'usage de votre organisation.");
        return;
      }
      if (!response.ok || !data || "error" in data) {
        // 404 uniforme de la porte (org absente OU non-membre) restitué tel
        // quel — jamais maquillé en état vide.
        throw new Error(data?.error ?? "Usage organisation indisponible.");
      }
      setUsage(data);
    } catch (error) {
      if (token !== loadTokenRef.current) return;
      setUsage(null);
      setUsageError(error instanceof Error ? error.message : "Usage organisation indisponible (réseau).");
    } finally {
      if (token === loadTokenRef.current) setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    if (sessionDisponible === null) return;
    void chargerOrganisations();
  }, [sessionDisponible, chargerOrganisations]);

  useEffect(() => {
    if (sessionDisponible === false) return;
    if (sessionDisponible === null) return;
    if (!orgId) return;
    void chargerUsage(orgId, days);
  }, [sessionDisponible, orgId, days, chargerUsage]);

  const orgsActives = orgs.length > 0;
  const maxDaily = Math.max(1, ...(usage?.byDay ?? []).map((bucket) => bucket.count));
  const maxTool = Math.max(1, ...(usage?.byTool ?? []).map((tool) => tool.count));

  return (
    <div className="pb-4">
      <StudioHeader
        eyebrow="GEN3IA · OBSERVABILITÉ · ORGANISATION"
        title="Usage par organisation"
        description="Exécutions, coûts, tokens et adoption des agents pour TOUTE votre organisation, agrégés par agent, outil et jour. Données agrégées : aucun contenu conversationnel n'est exposé — et vous ne voyez que les organisations dont vous êtes membre."
        actions={
          <Link href="/observability" className="g3-btn g3-btn-ghost text-xs">← Vue personnelle</Link>
        }
      />

      {sessionDisponible === false ? (
        <div className="g3-card p-10 text-center">
          <h2 className="font-serif text-xl font-semibold">Connectez-vous pour consulter l&apos;usage de votre organisation</h2>
          <p className="mt-2 text-sm text-[var(--g3-muted)]">La vue organisation est réservée aux membres : la porte vérifie votre appartenance avant de restituer la moindre métrique.</p>
          <Link href="/login?next=/observability/org" className="g3-btn g3-btn-primary mt-5 inline-flex">Se connecter</Link>
        </div>
      ) : (
        <>
          {/* Sélecteur : organisation + fenêtre */}
          <div className="mb-5 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--g3-muted)]">
              Organisation
              <select
                value={orgId}
                onChange={(event) => setOrgId(event.target.value)}
                disabled={!orgsActives}
                aria-label="Organisation consultée"
                className="min-w-56 rounded-xl border border-[var(--g3-border-strong)] bg-[var(--g3-surface)] px-3 py-2 text-sm font-normal text-[var(--g3-text)]"
              >
                {!orgsActives ? <option value="">Aucune organisation</option> : null}
                {orgs.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name} · plan {org.plan} · {ROLE_LABELS[org.myRole] ?? org.myRole} · {org.memberCount} membre{org.memberCount > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {[7, 14, 30].map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={days === option}
                  onClick={() => setDays(option)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${days === option ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"}`}
                >
                  {option} jours
                </button>
              ))}
              <button
                type="button"
                onClick={() => void chargerUsage(orgId, days)}
                disabled={!orgId || usageLoading}
                className="rounded-full border border-[var(--g3-border-strong)] px-3.5 py-1.5 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)] disabled:opacity-50"
              >
                {usageLoading ? "Chargement…" : "Rafraîchir"}
              </button>
            </div>
          </div>

          {orgsError ? <Callout tone="error" className="mb-5 rounded-2xl">{orgsError}</Callout> : null}

          {orgsLoaded && !orgsActives && !orgsError ? (
            <div className="g3-card p-10 text-center">
              <h2 className="font-serif text-xl font-semibold">Vous n&apos;êtes membre d&apos;aucune organisation</h2>
              <p className="mt-2 text-sm text-[var(--g3-muted)]">Créez une organisation ou rejoignez-en une par invitation depuis l&apos;espace Équipe — la vue d&apos;usage apparaîtra ici dès que vous serez membre.</p>
              <Link href="/team" className="g3-btn g3-btn-primary mt-5 inline-flex">Ouvrir l&apos;espace Équipe</Link>
            </div>
          ) : null}

          {usageError ? <div role="alert" className="mb-5"><Callout tone="error" className="rounded-2xl">{usageError}</Callout></div> : null}

          {usageLoading ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
              {[0, 1, 2, 3, 4].map((index) => (
                <div key={index} className="h-24 animate-pulse rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)]" />
              ))}
              <div className="col-span-2 h-48 animate-pulse rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] lg:col-span-4" />
            </div>
          ) : usage && orgId === usage.orgId ? (
            <div role="status" className="space-y-5">
              {/* KPI organisation */}
              <section aria-label="Indicateurs clés de l'organisation" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Kpi label="Exécutions (org)" value={String(usage.totals.executions)} hint={`${usage.totals.running} en cours · ${usage.totals.waitingApproval} à approuver`} />
                <Kpi label="Taux de succès" value={`${usage.totals.successRate}%`} hint={`${usage.totals.completed} terminées · ${usage.totals.failed} échouées`} />
                <Kpi label="Coût facturé" value={formatCharge(usage.totals.chargeMinor, usage.totals.currency)} hint={`coût fournisseurs : €${usage.totals.providerCostEur.toFixed(4)}`} />
                <Kpi label="Tokens LLM (org)" value={`${((usage.totals.inputTokens + usage.totals.outputTokens) / 1000).toFixed(1)}k`} hint={`entrée ${usage.totals.inputTokens} · sortie ${usage.totals.outputTokens}`} />
                <div className="col-span-2 lg:col-span-2">
                  <Kpi label="Durée moyenne" value={formatDuration(usage.totals.avgDurationMs)} hint="moyenne sur la fenêtre, tous membres confondus" />
                </div>
                <div className="col-span-2 lg:col-span-2">
                  <Kpi label="Membres couverts" value={String(usage.membersCovered)} hint="membres de l'org dont les exécutions alimentent cette vue" />
                </div>
              </section>

              {/* Activité quotidienne */}
              <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-sm">
                <h2 className="text-sm font-semibold sm:text-base">Activité quotidienne de l&apos;organisation ({usage.windowDays} jours)</h2>
                {usage.byDay.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucune exécution des membres sur la fenêtre. Les missions lancées depuis le Studio alimenteront cette vue.</p>
                ) : (
                  <div className="mt-4 flex items-end gap-1.5" aria-hidden="true">
                    {usage.byDay.map((bucket) => (
                      <div key={bucket.date} className="group relative flex-1">
                        <div className="flex h-24 items-end">
                          <div
                            className={`w-full rounded-t-md ${bucket.failed > 0 ? "bg-[var(--g3-danger)]" : "bg-neutral-300"} transition-colors group-hover:bg-[var(--g3-deep)]`}
                            style={{ height: `${Math.max(6, (bucket.count / maxDaily) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 truncate text-center text-[9px] text-[var(--g3-faint)]">{bucket.date.slice(5)}</p>
                        <span className="pointer-events-none absolute -top-7 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--g3-deep)] px-2 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                          {bucket.count} exéc. · {bucket.failed} échec(s)
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Adoption par agent */}
              <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-sm">
                <h2 className="text-sm font-semibold sm:text-base">Agents les plus sollicités</h2>
                <p className="mt-1 text-xs text-[var(--g3-faint)]">Adoption réelle par agent : exécutions, échecs, coût facturé et tokens — la base pour piloter quotas et budgets de l&apos;org.</p>
                {usage.byAgent.length === 0 ? (
                  <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucune exécution rattachée à un agent sur la fenêtre (les missions ad-hoc sans agent restent hors dimension).</p>
                ) : (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="border-b border-[var(--g3-border)] text-[10px] uppercase tracking-wide text-[var(--g3-faint)]">
                          <th scope="col" className="py-2 pr-3">Agent</th>
                          <th scope="col" className="py-2 pr-3">Exécutions</th>
                          <th scope="col" className="py-2 pr-3">Échecs</th>
                          <th scope="col" className="py-2 pr-3">Coût facturé</th>
                          <th scope="col" className="py-2 pr-3">Tokens</th>
                          <th scope="col" className="py-2">Coût fournisseurs</th>
                        </tr>
                      </thead>
                      <tbody>
                        {usage.byAgent.map((agent) => (
                          <tr key={agent.agentId} className="border-b border-[var(--g3-border)] last:border-0">
                            <td className="max-w-48 truncate py-2 pr-3 font-semibold text-[var(--g3-text-secondary)]" title={agent.agentId}>{agent.agentId}</td>
                            <td className="py-2 pr-3">{agent.executions}</td>
                            <td className={`py-2 pr-3 ${agent.failed > 0 ? "font-semibold text-[var(--g3-danger-strong)]" : ""}`}>{agent.failed}</td>
                            <td className="py-2 pr-3">{formatCharge(agent.chargeMinor, usage.totals.currency)}</td>
                            <td className="py-2 pr-3">{agent.inputTokens} → {agent.outputTokens}</td>
                            <td className="py-2">€{agent.providerCostEur.toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* Outils les plus appelés (org) */}
              {usage.byTool.length > 0 ? (
                <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 shadow-sm">
                  <h2 className="text-sm font-semibold sm:text-base">Outils les plus appelés (organisation)</h2>
                  <ul className="mt-4 space-y-2.5">
                    {usage.byTool.map((tool) => (
                      <li key={tool.name} className="flex items-center gap-3">
                        <span className="w-40 shrink-0 truncate text-xs font-semibold text-[var(--g3-text-secondary)]" title={toolLabel(tool.name)}>{toolLabel(tool.name)}</span>
                        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--g3-elevated)]">
                          <div className={`h-full rounded-full ${tool.failed > 0 ? "bg-[var(--g3-warning)]" : "bg-[var(--g3-deep)]"}`} style={{ width: `${Math.max(4, (tool.count / maxTool) * 100)}%` }} />
                        </div>
                        <span className="w-24 shrink-0 text-right text-xs text-[var(--g3-muted)]">
                          {tool.count} appel{tool.count > 1 ? "s" : ""}{tool.failed > 0 ? ` · ${tool.failed} échec(s)` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <p className="text-[11px] text-[var(--g3-faint)]">
                Fenêtre de {usage.windowDays} jours · {usage.membersCovered} membre{usage.membersCovered > 1 ? "s" : ""} couvert{usage.membersCovered > 1 ? "s" : ""} · instantané restitué tel quel par la porte /api/observability/org (requireOrgContext) — données agrégées, aucun contenu conversationnel n&apos;est exposé.
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
