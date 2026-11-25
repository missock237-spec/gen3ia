"use client";

import { useCallback, useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { EmptyState, LoadingState, MetricCard } from "@/components/shells/states";
import { StatusBadge } from "@/components/shells/status-badge";

/**
 * /admin/capabilities — DASHBOARD UCE (mission §10) : les 12 indicateurs
 * réels (aucun faux indicateur d'autonomie) + commandes administratives
 * (découverte, test, autorisation, rollback, suspension des évolutions).
 * Source : GET /api/admin/capabilities/etat (lecture seule) ; commandes via
 * POST /api/admin/capabilities/commandes (requireAdmin cryptographique).
 */

interface EtatCapacites {
  date: string;
  total: number;
  parStatut: Record<string, number>;
  parKind: Record<string, number>;
  operationnels: number;
  annonces: number;
  indisponibles: number;
  enTest: number;
  decouvertesRecentes: Array<{ id: string; nom: string; source: string; creeLe: string; score: number | null }>;
  necessitantAutorisation: Array<{ id: string; nom: string; score: number | null; source: string }>;
  performances: Array<{ capabilityId: string; executions: number; tauxSucces: number; dureeP95Ms: number }>;
  incidentsOuverts: number;
  categoriesEchecs: Array<{ categorie: string; nombre: number }>;
  recommandations: string[];
  ressources: Array<{ capabilityId: string; mesures: number; dureeMoyenneMs: number; dureeMaxMs: number; memoirePicMaxMo?: number }>;
  versionsRecentes: Array<{ id: string; capabilityId: string; version: string; statut: string; creeLe: string }>;
  rollbacks: Array<{ id: string; capabilityId: string; depuisVersion: string; versVersion: string; raison: string; effectueLe: string }>;
  evolutionsSuspendues: boolean;
  tentativesBloquees: number;
  autonomie: {
    niveau: number;
    niveauPosePar: string | null;
    insuffisancesDetectees: number;
    insuffisancesRecentes: Array<{ id: string; categorie: string; description: string; priorite: string; detecteeLe: string }>;
    decisions: {
      total: number;
      parStatut: Record<string, number>;
      recentes: Array<{ decisionId: string; action: string; objective: string; statut: string; priorite: string; approbationRequise: boolean; produiteLe: string }>;
    };
    plans: {
      total: number;
      parStatut: Record<string, number>;
      recents: Array<{ id: string; action: string; objectif: string; statut: string; niveauRisque: string }>;
    };
    cycles: {
      enCours: number;
      termines: number;
      echoues: number;
      recents: Array<{ id: string; etat: string; besoin: string; tentatives: number; causeEchec: string | null; majLe: string }>;
    };
  };
  limites: string[];
}

export default function AdminCapabilitiesPage() {
  const [etat, setEtat] = useState<EtatCapacites | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [messageCommande, setMessageCommande] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [requete, setRequete] = useState("");
  const [adminId, setAdminId] = useState("");
  const [cycleId, setCycleId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const reponse = await authFetch("/api/admin/capabilities/etat", { cache: "no-store" });
      if (!reponse.ok) throw new Error(`état indisponible (${reponse.status})`);
      setEtat((await reponse.json()) as EtatCapacites);
    } catch (e) {
      setError(e instanceof Error ? e.message : "erreur de chargement");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const commande = useCallback(
    async (corps: Record<string, unknown>, etiquette: string) => {
      setOccupe(true);
      setMessageCommande("");
      try {
        const reponse = await authFetch("/api/admin/capabilities/commandes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(corps),
        });
        const data = (await reponse.json()) as { ok?: boolean; raison?: string; erreur?: string; decouverte?: { total: number; capacitesCreees: number }; verdict?: string };
        setMessageCommande(
          `${etiquette} ${reponse.ok && data.ok !== false ? "✓" : "✗"} ${
            data.decouverte
              ? `— ${data.decouverte.total} découverte(s), ${data.decouverte.capacitesCreees} capacité(s) créée(s)`
              : (data.verdict ? `— verdict : ${data.verdict}` : (data.raison ?? data.erreur ?? ""))
          }`,
        );
        void load();
      } catch (e) {
        setMessageCommande(`${etiquette} ✗ ${e instanceof Error ? e.message : "erreur réseau"}`);
      } finally {
        setOccupe(false);
      }
    },
    [load],
  );

  if (loading && !etat) return <LoadingState label="Chargement de l'état des capacités…" />;
  if (error) return <EmptyState title="UCE indisponible" description={error} />;
  if (!etat) return <EmptyState title="Aucun état" description="Le registre des capacités n'a pas encore publié d'état." />;

  const integrees = etat.parStatut.integree ?? 0;
  const validees = etat.parStatut.validee ?? 0;
  const proposees = etat.parStatut.proposee ?? 0;
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Capacités UCE</h1>
          <p className="text-sm text-muted-foreground">
            Universal Capability Engine · {etat.total} capacités · {etat.operationnels}/{etat.annonces} outils natifs enregistrés · mis à jour {new Date(etat.date).toLocaleTimeString("fr-FR")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge status={etat.evolutionsSuspendues ? "stopped" : "healthy"} label={etat.evolutionsSuspendues ? "ÉVOLUTIONS SUSPENDUES" : "ÉVOLUTIONS ACTIVES"} />
          <StatusBadge status={etat.autonomie.niveau >= 4 ? "warn" : "healthy"} label={`AUTONOMIE NIV. ${etat.autonomie.niveau}${etat.autonomie.niveauPosePar ? ` (${etat.autonomie.niveauPosePar})` : ""}`} />
          <button type="button" onClick={() => void load()} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted" disabled={occupe}>
            Rafraîchir
          </button>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricCard label="Total" value={String(etat.total)} />
        <MetricCard label="Intégrées" value={String(integrees + validees)} />
        <MetricCard label="En test" value={String(etat.enTest)} />
        <MetricCard label="Indisponibles" value={String(etat.indisponibles)} />
        <MetricCard label="À autoriser" value={String(proposees)} />
        <MetricCard label="Incidents ouverts" value={String(etat.incidentsOuverts)} />
      </section>

      {/* V1.1 Phase 13 — SUPERVISION DE L'AUTONOMIE (chiffres mesurés) */}
      <section className="space-y-3">
        <h2 className="font-medium">Autonomie du cycle d&apos;évolution</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <MetricCard label="Insuffisances détectées" value={String(etat.autonomie.insuffisancesDetectees)} />
          <MetricCard label="Décisions du cerveau" value={String(etat.autonomie.decisions.total)} />
          <MetricCard label="Plans d&apos;amélioration" value={String(etat.autonomie.plans.total)} />
          <MetricCard label="Cycles en cours" value={String(etat.autonomie.cycles.enCours)} />
          <MetricCard label="Cycles terminés" value={String(etat.autonomie.cycles.termines)} />
          <MetricCard label="Cycles échoués / annulés" value={String(etat.autonomie.cycles.echoues)} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 font-medium">Cycles persistants récents</h3>
            {etat.autonomie.cycles.recents.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun cycle d&apos;évolution enregistré.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {etat.autonomie.cycles.recents.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span className="truncate">{c.id} <span className="text-muted-foreground">« {c.besoin.slice(0, 60)} »</span></span>
                    <span className="text-muted-foreground">{c.etat} · {c.tentatives} essai(s){c.causeEchec ? ` · ${c.causeEchec.slice(0, 50)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-lg border p-4">
            <h3 className="mb-2 font-medium">Décisions récentes du cerveau central</h3>
            {etat.autonomie.decisions.recentes.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucune décision produite.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {etat.autonomie.decisions.recentes.map((d) => (
                  <li key={d.decisionId} className="flex justify-between gap-2">
                    <span className="truncate">{d.action} — {d.objective.slice(0, 70)}</span>
                    <span className="text-muted-foreground">{d.statut} · {d.priorite}{d.approbationRequise ? " · gated" : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Tentatives d&apos;exécution bloquées (refus du gateway) : {etat.tentativesBloquees} · le niveau d&apos;autonomie ne peut être posé que par un identifiant humain (le système ne modifie jamais ses propres règles de sécurité).</p>
      </section>

      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="font-medium">Commandes administratives</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={requete}
            onChange={(e) => setRequete(e.target.value)}
            placeholder="requête de découverte (ex. parser csv, tts local…)"
            className="min-w-64 flex-1 rounded-md border px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe || requete.trim().length < 3}
            onClick={() => void commande({ action: "lancer-decouverte", requete }, "découverte")}
          >
            Lancer une découverte
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe || etat.evolutionsSuspendues}
            onClick={() => void commande({ action: "suspendre-evolutions" }, "suspension")}
          >
            Suspendre les évolutions
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe || !etat.evolutionsSuspendues}
            onClick={() => void commande({ action: "reprendre-evolutions" }, "reprise")}
          >
            Reprendre
          </button>
        </div>
        {messageCommande && <p className="text-sm text-muted-foreground">{messageCommande}</p>}
        <p className="text-xs text-muted-foreground">
          Toute intégration exige une autorisation explicite (gate humain) : les capacités « proposées » ci-dessous ne sont PAS exécutables tant qu&apos;elles n&apos;ont pas été autorisées via l&apos;API de commandes.
        </p>
      </section>

      {/* V1.1 Phase 13 — CONTRÔLES DE L'AUTONOMIE (suspendre/reprendre/annuler/
          autoriser/désactiver/rollback — chaque action porte un identifiant
          humain obligatoire pour les opérations gated) */}
      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="font-medium">Contrôles de l&apos;autonomie</h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={adminId}
            onChange={(e) => setAdminId(e.target.value)}
            placeholder="votre identifiant (ex. admin-xxx) — exigé pour les opérations gated"
            className="min-w-56 flex-1 rounded-md border px-3 py-1.5 text-sm"
          />
          <input
            value={cycleId}
            onChange={(e) => setCycleId(e.target.value)}
            placeholder="id de cycle (ex. cycle_abc123)"
            className="min-w-56 flex-1 rounded-md border px-3 py-1.5 text-sm"
          />
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe || cycleId.trim().length < 6}
            onClick={() => void commande({ action: "annuler-cycle", cycleId, autorisePar: adminId, raison: "annulation depuis le dashboard" }, "annulation du cycle")}
          >
            Annuler le cycle
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe || cycleId.trim().length < 6 || adminId.trim().length < 4}
            onClick={() => void commande({ action: "reprendre-cycle", cycleId, autorisePar: adminId }, "reprise du cycle")}
          >
            Reprendre / autoriser
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe || cycleId.trim().length < 6}
            onClick={() => void commande({ action: "relancer-cycle", cycleId }, "relance du cycle")}
          >
            Relancer (retry)
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe || cycleId.trim().length < 6 || adminId.trim().length < 4}
            onClick={() => void commande({ action: "rollback-cycle", cycleId, autorisePar: adminId, raison: "rollback depuis le dashboard" }, "rollback du cycle")}
          >
            Rollback du cycle
          </button>
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            disabled={occupe}
            onClick={() => void commande({ action: "reprendre-cycles-interrompus" }, "reprise des cycles interrompus")}
          >
            Reprendre cycles interrompus
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Niveau d&apos;autonomie :</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`rounded-md border px-2.5 py-1 text-sm ${etat.autonomie.niveau === n ? "bg-muted font-medium" : "hover:bg-muted"}`}
              disabled={occupe || adminId.trim().length < 4}
              onClick={() => void commande({ action: "niveau-autonomie", niveau: n, autorisePar: adminId, raison: `passage au niveau ${n} depuis le dashboard` }, `niveau ${n}`)}
            >
              {n}
            </button>
          ))}
          <span className="text-xs text-muted-foreground">1 observation · 2 recherche · 3 expérimentation · 4 intégration contrôlée · 5 optimisation encadrée</span>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">Découvertes récentes (7 jours)</h2>
          {etat.decouvertesRecentes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune découverte récente.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {etat.decouvertesRecentes.map((d) => (
                <li key={d.id} className="flex justify-between gap-2">
                  <span className="truncate">{d.nom} <span className="text-muted-foreground">({d.source})</span></span>
                  <span className="text-muted-foreground">{d.score !== null ? `score ${d.score}` : "non mesuré"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">Nécessitant une autorisation</h2>
          {etat.necessitantAutorisation.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune proposition en attente.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {etat.necessitantAutorisation.map((c) => (
                <li key={c.id} className="flex justify-between gap-2">
                  <span className="truncate">{c.nom} <span className="text-muted-foreground">({c.source})</span></span>
                  <span className="text-muted-foreground">{c.score !== null ? `score ${c.score}` : "non mesuré"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">Performances comparées (mesurées)</h2>
          {etat.performances.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune exécution mesurée.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {etat.performances.map((p) => (
                <li key={p.capabilityId} className="flex justify-between gap-2">
                  <span className="truncate">{p.capabilityId}</span>
                  <span className="text-muted-foreground">{p.executions} exec · {Math.round(p.tauxSucces * 100)}% · p95 {p.dureeP95Ms} ms</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">Incidents & recommandations</h2>
          {etat.categoriesEchecs.length === 0 && etat.recommandations.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun échec analysé.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {etat.categoriesEchecs.map((c) => (
                <li key={c.categorie}>{c.nombre} échec(s) « {c.categorie} »</li>
              ))}
              {etat.recommandations.map((r) => (
                <li key={r} className="text-muted-foreground">→ {r}</li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">Historique des versions récentes</h2>
          {etat.versionsRecentes.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune version publiée.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {etat.versionsRecentes.map((v) => (
                <li key={v.id} className="flex justify-between gap-2">
                  <span className="truncate">{v.capabilityId} <span className="text-muted-foreground">v{v.version}</span></span>
                  <span className="text-muted-foreground">{v.statut}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-2 font-medium">Rollbacks & ressources</h2>
          {etat.rollbacks.length === 0 && etat.ressources.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun rollback ni mesure de ressource.</p>
          ) : (
            <ul className="space-y-1.5 text-sm">
              {etat.rollbacks.map((r) => (
                <li key={r.id}>{r.capabilityId} : {r.depuisVersion} → {r.versVersion} ({r.raison.slice(0, 60)})</li>
              ))}
              {etat.ressources.slice(0, 5).map((u) => (
                <li key={u.capabilityId} className="text-muted-foreground">
                  {u.capabilityId} : moy. {u.dureeMoyenneMs} ms · max {u.dureeMaxMs} ms{u.memoirePicMaxMo !== undefined ? ` · ${u.memoirePicMaxMo} Mo` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <footer className="text-xs text-muted-foreground">
        {etat.limites.join(" · ")}
      </footer>
    </div>
  );
}
