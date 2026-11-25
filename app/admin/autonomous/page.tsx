"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { EmptyState, LoadingState, MetricCard } from "@/components/shells/states";
import { StatusBadge } from "@/components/shells/status-badge";

/**
 * /admin/autonomous — DASHBOARD DU GEN3IA AUTONOMOUS BRAIN (Lot 08, mission
 * « finalisation opérationnelle ») : état du core, uptime, collecte, file
 * du pipeline, connaissances, apprentissage, compétences, erreurs.
 * Source : GET /api/admin/autonomous/etat (lecture seule) ; commandes via
 * POST /api/admin/autonomous/commandes (requireAdmin cryptographique).
 */

interface SourceEtat {
  id: string;
  type: string;
  licence: string;
  statut: string;
  derniereCollecteLe: string | null;
  derniereErreur: string | null;
  lotsProduits: number;
}

interface EtatAutonome {
  date: string;
  core: {
    arme: boolean;
    actif: boolean;
    cycle: number;
    demarreLe: string;
    persisteLe: string;
    statutSante: string;
    modules: Array<{ id: string; echecsConsecutifs: number; dernieresErreurs: string[] }>;
  };
  collecteur: { sources: SourceEtat[] };
  pipeline: { lots: Record<string, number>; total: number };
  memoire: {
    connaissances: number;
    competences: { total: number; validees: number; parStatut: Array<[string, number]> };
  };
  erreurs: { modulesEnDifficulte: Array<{ id: string; echecsConsecutifs: number; dernieresErreurs: string[] }> };
}

function uptime(demarreLe: string): string {
  const ms = Date.now() - Date.parse(demarreLe);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export default function AdminAutonomousPage() {
  const [etat, setEtat] = useState<EtatAutonome | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [messageCommande, setMessageCommande] = useState("");
  const [occupe, setOccupe] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const reponse = await authFetch("/api/admin/autonomous/etat", { cache: "no-store" });
      if (!reponse.ok) throw new Error(`état indisponible (${reponse.status})`);
      setEtat((await reponse.json()) as EtatAutonome);
    } catch (e) {
      setError(e instanceof Error ? e.message : "erreur de chargement");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000); // rafraîchissement 60 s
    return () => clearInterval(timer);
  }, [load]);

  const commande = useCallback(
    async (action: string, sourceId?: string) => {
      setOccupe(true);
      setMessageCommande("");
      try {
        const reponse = await authFetch("/api/admin/autonomous/commandes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, sourceId }),
        });
        const data = (await reponse.json()) as { ok?: boolean; collecte?: { message: string }; traitement?: { message: string }; erreur?: string };
        setMessageCommande(
          reponse.ok
            ? `${action} ✓ ${data.collecte ? `— collecte : ${data.collecte.message} · traitement : ${data.traitement?.message ?? ""}` : ""}`
            : `${action} ✗ ${data.erreur ?? reponse.status}`,
        );
        void load();
      } catch (e) {
        setMessageCommande(`${action} ✗ ${e instanceof Error ? e.message : "erreur réseau"}`);
      } finally {
        setOccupe(false);
      }
    },
    [load],
  );

  if (loading && !etat) return <LoadingState label="Chargement de l'état du cerveau autonome…" />;
  if (error) return <EmptyState title="Cerveau autonome indisponible" description={error} />;
  if (!etat) return <EmptyState title="Aucun état" description="Le cœur autonome n'a pas encore publié d'état." />;

  const lots = etat.pipeline.lots;

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Gen3ia Autonomous Brain</h1>
          <p className="text-sm text-muted-foreground">
            Cerveau {etat.core.arme ? "armé" : "désarmé"} · cycle {etat.core.cycle} · uptime {uptime(etat.core.demarreLe)} · persisté {new Date(etat.core.persisteLe).toLocaleTimeString("fr-FR")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={etat.core.actif ? "healthy" : "stopped"} label={etat.core.actif ? "ACTIF" : "ARRÊTÉ"} />
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe}
          >
            Rafraîchir
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Cycle" value={String(etat.core.cycle)} />
        <MetricCard label="Lots en file" value={String(lots.QUEUED ?? 0)} />
        <MetricCard label="Quarantaine" value={String(lots.QUARANTINED ?? 0)} />
        <MetricCard label="Intégrés" value={String(lots.INTEGRATED ?? 0)} />
        <MetricCard label="Connaissances" value={String(etat.memoire.connaissances)} />
        <MetricCard label="Compétences validées" value={`${etat.memoire.competences.validees}/${etat.memoire.competences.total}`} />
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-medium">Collecte (cycles 5 min)</h2>
          <button
            type="button"
            onClick={() => void commande("collecte-maintenant")}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe}
          >
            Collecte + traitement maintenant
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2">Source</th>
                <th className="p-2">Type</th>
                <th className="p-2">Statut</th>
                <th className="p-2">Lots</th>
                <th className="p-2">Dernière collecte</th>
                <th className="p-2 text-right">Commande</th>
              </tr>
            </thead>
            <tbody>
              {etat.collecteur.sources.map((s) => (
                <tr key={s.id} className="border-t">
                  <td className="p-2 font-mono text-xs">{s.id}</td>
                  <td className="p-2">{s.type}</td>
                  <td className="p-2">
                    <StatusBadge status={s.statut === "actif" ? "healthy" : "paused"} label={s.statut} />
                  </td>
                  <td className="p-2">{s.lotsProduits}</td>
                  <td className="p-2 text-xs">{s.derniereCollecteLe ? new Date(s.derniereCollecteLe).toLocaleTimeString("fr-FR") : "—"}</td>
                  <td className="p-2 text-right">
                    <button
                      type="button"
                      onClick={() => void commande(s.statut === "actif" ? "pause-source" : "activer-source", s.id)}
                      className="rounded border px-2 py-1 text-xs hover:bg-muted"
                      disabled={occupe}
                    >
                      {s.statut === "actif" ? "Pause" : "Activer"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Modules connectés</h2>
          <ul className="space-y-1 text-sm">
            {etat.core.modules.map((m) => (
              <li key={m.id} className="flex items-center justify-between rounded border p-2">
                <span className="font-mono text-xs">{m.id}</span>
                <StatusBadge status={m.echecsConsecutifs > 0 ? "degraded" : "healthy"} label={m.echecsConsecutifs > 0 ? `${m.echecsConsecutifs} échec(s)` : "ok"} />
              </li>
            ))}
          </ul>
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-medium">Apprentissage &amp; erreurs</h2>
          <p className="text-sm text-muted-foreground">
            Compétences : {etat.memoire.competences.parStatut.map(([k, v]) => `${k}=${v}`).join(" · ") || "aucune"}
          </p>
          {etat.erreurs.modulesEnDifficulte.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun module en difficulté.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {etat.erreurs.modulesEnDifficulte.map((m) => (
                <li key={m.id} className="rounded border border-red-200 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950">
                  <span className="font-mono">{m.id}</span> — {m.echecsConsecutifs} échec(s) : {m.dernieresErreurs[0] ?? ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {messageCommande && (
        <p className="rounded border p-2 text-xs" role="status">
          {messageCommande}
        </p>
      )}
    </div>
  );
}
