"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

/**
 * PLANIFICATIONS — tâches planifiées automatisées (restauration demandée par
 * le propriétaire, 10-2026). Surface utilisateur branchée sur
 * /api/agents/schedules (requireUser, scoping propriétaire) :
 *  - création d'une planification RÉCURRENTE (fenêtre hebdomadaire +
 *    intervalle), PONCTUELLE (one-shot runAtMs) ou TOUJOURS ACTIVE
 *    (veille RSS/Web et/ou webhook entrant) ;
 *  - exécution manuelle immédiate, pause/reprise, suppression ;
 *  - historique des courses réelles (statut, déclencheur, aperçu du
 *    résultat, livrables) ;
 *  - URL de webhook copiable pour les agents toujours actifs.
 * L'exécution réelle est assurée par le balayage indexé du scheduler
 * (cron /api/cron/agent-schedules) — cette page ne fait qu'orchestrer.
 */

/* ------------------------------------------------------------------ */
/* Types (contrats /api/agents/schedules)                              */
/* ------------------------------------------------------------------ */

interface AgentResume {
  id: string;
  name: string;
  status: string;
}

interface SourceVeille {
  id: string;
  type: "rss" | "web";
  url: string;
  label?: string;
}

interface Planification {
  id: string;
  agentId: string;
  name: string;
  objective: string;
  timezone: string;
  daysOfWeek?: number[];
  startTime?: string;
  endTime?: string;
  intervalMinutes: number;
  runAtMs?: number;
  enabled: boolean;
  lastExecutionStatus?: string;
  lastExecutionAt?: string;
  lastError?: string;
  nextRunAt?: string;
  watchSources?: SourceVeille[];
  alwaysOnWebhookToken?: string;
  createdAt?: string;
}

interface Course {
  id: string;
  status: string;
  trigger?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  outputPreview?: string;
  deliverables?: Array<Record<string, unknown>>;
}

const JOURS: Array<{ valeur: number; label: string }> = [
  { valeur: 1, label: "Lun" },
  { valeur: 2, label: "Mar" },
  { valeur: 3, label: "Mer" },
  { valeur: 4, label: "Jeu" },
  { valeur: 5, label: "Ven" },
  { valeur: 6, label: "Sam" },
  { valeur: 0, label: "Dim" },
];

/** Fuseau du navigateur — envoyé tel quel au serveur (assertTimezone). */
const FUSEAU: string =
  typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : "UTC";

function decrireRecurrence(p: Planification): string {
  if (p.runAtMs) return `Ponctuelle — le ${new Date(p.runAtMs).toLocaleString("fr-FR")}`;
  const jours = (p.daysOfWeek ?? [])
    .map((d) => JOURS.find((j) => j.valeur === d)?.label ?? String(d))
    .join(" ");
  const fenetre = p.startTime && p.endTime ? `${p.startTime} → ${p.endTime}` : "sans fenêtre horaire";
  const intervalle = p.intervalMinutes > 0 ? ` · toutes les ${p.intervalMinutes} min` : "";
  const veille = p.watchSources?.length ? ` · veille ${p.watchSources.length} source(s)` : "";
  const webhook = p.alwaysOnWebhookToken ? " · webhook actif" : "";
  return `Récurrente — ${jours || "aucun jour"} · ${fenetre}${intervalle}${veille}${webhook}`;
}

function badgeStatut(statut?: string): { texte: string; classe: string } {
  switch (statut) {
    case "succeeded":
    case "completed":
      return { texte: "réussie", classe: "text-[var(--g3-success-strong)]" };
    case "failed":
      return { texte: "échec", classe: "text-[var(--g3-danger-strong)]" };
    case "running":
      return { texte: "en cours", classe: "text-[var(--g3-primary)]" };
    case "timeout":
      return { texte: "expirée", classe: "text-[var(--g3-warning-strong)]" };
    default:
      return { texte: statut ?? "—", classe: "text-[var(--g3-muted)]" };
  }
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

async function lireErreur(response: Response, repli: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body?.error === "string" && body.error ? body.error : repli;
  } catch {
    return repli;
  }
}

/* ------------------------------------------------------------------ */
/* Composant                                                           */
/* ------------------------------------------------------------------ */

export function PlanificationsWorkspace({ embedded = false }: { embedded?: boolean } = {}) {
  const session = useSessionAvailable();

  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState("");
  const [notice, setNotice] = useState("");

  // Données
  const [agents, setAgents] = useState<AgentResume[]>([]);
  const [planifications, setPlanifications] = useState<Planification[]>([]);

  // Formulaire de création
  const [mode, setMode] = useState<"recurrente" | "ponctuelle">("recurrente");
  const [nom, setNom] = useState("");
  const [objectif, setObjectif] = useState("");
  const [agentId, setAgentId] = useState("");
  const [jours, setJours] = useState<number[]>([1, 2, 3, 4, 5]);
  const [heureDebut, setHeureDebut] = useState("08:00");
  const [heureFin, setHeureFin] = useState("18:00");
  const [intervalle, setIntervalle] = useState(60);
  const [datePonctuelle, setDatePonctuelle] = useState("");
  const [veilleActive, setVeilleActive] = useState(false);
  const [veilleType, setVeilleType] = useState<"rss" | "web">("rss");
  const [veilleUrl, setVeilleUrl] = useState("");
  const [creationEnCours, setCreationEnCours] = useState(false);

  // Création rapide d'agent (obligatoire : une planification cible UN agent)
  const [nomAgent, setNomAgent] = useState("");
  const [agentEnCours, setAgentEnCours] = useState(false);

  // Historique des courses
  const [historiqueOuvert, setHistoriqueOuvert] = useState<string | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [coursesEnCours, setCoursesEnCours] = useState(false);

  // Occupations ponctuelles (une action par planification à la fois)
  const [occupe, setOccupe] = useState<string>("");

  const chargerTout = useCallback(async () => {
    try {
      const [reponseAgents, reponsePlans] = await Promise.all([
        authFetch("/api/agents", { cache: "no-store" }),
        authFetch("/api/agents/schedules", { cache: "no-store" }),
      ]);
      if (reponseAgents.ok) {
        const body = (await reponseAgents.json()) as { agents?: AgentResume[] };
        setAgents(Array.isArray(body.agents) ? body.agents : []);
      }
      if (reponsePlans.ok) {
        const body = (await reponsePlans.json()) as { schedules?: Planification[] };
        setPlanifications(Array.isArray(body.schedules) ? body.schedules : []);
      } else {
        setErreur(await lireErreur(reponsePlans, "Impossible de charger vos planifications."));
      }
    } catch {
      setErreur("Réseau indisponible — réessayez dans un instant.");
    } finally {
      setChargement(false);
    }
  }, []);

  useEffect(() => {
    if (session) void chargerTout();
  }, [session, chargerTout]);

  /* ---------------- Actions ---------------- */

  const creerAgentRapide = useCallback(async () => {
    const nomPropre = nomAgent.trim();
    if (nomPropre.length < 2 || agentEnCours) return;
    setAgentEnCours(true);
    setErreur("");
    try {
      const response = await authFetch("/api/agents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nomPropre, description: "Agent créé depuis les planifications" }),
      });
      if (!response.ok) {
        setErreur(await lireErreur(response, "Création de l'agent impossible."));
        return;
      }
      const body = (await response.json()) as { agent?: AgentResume };
      if (body.agent) {
        setAgents((liste) => [...liste, body.agent as AgentResume]);
        setAgentId(body.agent.id);
        setNomAgent("");
        setNotice(`Agent « ${body.agent.name} » créé — sélectionnez-le ci-dessous.`);
      }
    } catch {
      setErreur("Réseau indisponible — réessayez dans un instant.");
    } finally {
      setAgentEnCours(false);
    }
  }, [nomAgent, agentEnCours]);

  const creerPlanification = useCallback(async () => {
    if (creationEnCours) return;
    setErreur("");
    setNotice("");
    const runAtMs = mode === "ponctuelle" && datePonctuelle ? new Date(datePonctuelle).getTime() : undefined;
    const payload: Record<string, unknown> = {
      agentId,
      name: nom.trim(),
      objective: objectif.trim(),
      timezone: FUSEAU,
      enabled: true,
      intervalMinutes: mode === "recurrente" ? Math.max(0, Math.min(1440, intervalle || 0)) : 0,
    };
    if (mode === "recurrente") {
      payload.daysOfWeek = jours;
      payload.startTime = heureDebut;
      payload.endTime = heureFin;
    }
    if (runAtMs && Number.isFinite(runAtMs)) payload.runAtMs = runAtMs;
    if (veilleActive && veilleUrl.trim()) {
      payload.watchSourceInputs = [{ type: veilleType, url: veilleUrl.trim() }];
    }

    setCreationEnCours(true);
    try {
      const response = await authFetch("/api/agents/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        setErreur(await lireErreur(response, "Création de la planification impossible."));
        return;
      }
      const body = (await response.json()) as { schedule?: Planification };
      if (body.schedule) setPlanifications((liste) => [...liste, body.schedule as Planification]);
      setNom("");
      setObjectif("");
      setDatePonctuelle("");
      setVeilleUrl("");
      setVeilleActive(false);
      setNotice("Planification créée — votre agent s'exécutera automatiquement.");
    } catch {
      setErreur("Réseau indisponible — réessayez dans un instant.");
    } finally {
      setCreationEnCours(false);
    }
  }, [agentId, creationEnCours, datePonctuelle, heureDebut, heureFin, intervalle, jours, mode, nom, objectif, veilleActive, veilleType, veilleUrl]);

  const executerMaintenant = useCallback(async (p: Planification) => {
    if (occupe) return;
    setOccupe(p.id);
    setErreur("");
    setNotice("");
    try {
      const response = await authFetch(`/api/agents/schedules/${p.id}/run`, { method: "POST" });
      if (!response.ok) {
        setErreur(await lireErreur(response, "Exécution immédiate impossible."));
        return;
      }
      setNotice(`« ${p.name} » est en cours d'exécution — le résultat apparaîtra dans l'historique.`);
      setTimeout(() => void chargerTout(), 2500);
    } catch {
      setErreur("Réseau indisponible — réessayez dans un instant.");
    } finally {
      setOccupe("");
    }
  }, [chargerTout, occupe]);

  const basculerActive = useCallback(async (p: Planification) => {
    if (occupe) return;
    setOccupe(p.id);
    setErreur("");
    try {
      const response = await authFetch(`/api/agents/schedules/${p.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !p.enabled }),
      });
      if (!response.ok) {
        setErreur(await lireErreur(response, "Mise à jour impossible."));
        return;
      }
      const body = (await response.json()) as { schedule?: Planification };
      if (body.schedule) {
        setPlanifications((liste) => liste.map((item) => (item.id === p.id ? (body.schedule as Planification) : item)));
      }
      setNotice(body.schedule?.enabled ? "Planification reprise." : "Planification en pause.");
    } catch {
      setErreur("Réseau indisponible — réessayez dans un instant.");
    } finally {
      setOccupe("");
    }
  }, [occupe]);

  const supprimer = useCallback(async (p: Planification) => {
    if (occupe) return;
    if (!window.confirm(`Supprimer définitivement « ${p.name} » ?`)) return;
    setOccupe(p.id);
    setErreur("");
    try {
      const response = await authFetch(`/api/agents/schedules/${p.id}`, { method: "DELETE" });
      if (!response.ok) {
        setErreur(await lireErreur(response, "Suppression impossible."));
        return;
      }
      setPlanifications((liste) => liste.filter((item) => item.id !== p.id));
      setNotice("Planification supprimée.");
    } catch {
      setErreur("Réseau indisponible — réessayez dans un instant.");
    } finally {
      setOccupe("");
    }
  }, [occupe]);

  const voirHistorique = useCallback(async (p: Planification) => {
    if (historiqueOuvert === p.id) {
      setHistoriqueOuvert(null);
      return;
    }
    setHistoriqueOuvert(p.id);
    setCourses([]);
    setCoursesEnCours(true);
    try {
      const response = await authFetch(`/api/agents/schedules/${p.id}/runs?limit=25`, { cache: "no-store" });
      if (response.ok) {
        const body = (await response.json()) as { runs?: Course[] };
        setCourses(Array.isArray(body.runs) ? body.runs : []);
      }
    } catch {
      /* silencieux : historique vide */
    } finally {
      setCoursesEnCours(false);
    }
  }, [historiqueOuvert]);

  const verifierVeille = useCallback(async (p: Planification) => {
    if (occupe) return;
    setOccupe(p.id);
    setErreur("");
    setNotice("");
    try {
      const response = await authFetch(`/api/agents/schedules/${p.id}/watch`, { method: "POST" });
      if (!response.ok) {
        setErreur(await lireErreur(response, "Sonde de veille impossible."));
        return;
      }
      setNotice("Sources de veille sondées — l'agent démarre si un contenu surveillé a changé.");
      setTimeout(() => void chargerTout(), 2000);
    } catch {
      setErreur("Réseau indisponible — réessayez dans un instant.");
    } finally {
      setOccupe("");
    }
  }, [chargerTout, occupe]);

  /* ---------------- Rendu ---------------- */

  if (session === null || session === false) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">Connectez-vous pour gérer vos planifications</h1>
        <a href="/login" className="mt-4 inline-block rounded-xl bg-[var(--g3-deep)] px-5 py-3 text-sm font-semibold text-white">Se connecter</a>
      </div>
    );
  }

  const formulaireValide =
    nom.trim().length >= 1 &&
    objectif.trim().length >= 3 &&
    Boolean(agentId) &&
    (mode === "recurrente"
      ? jours.length > 0 && heureDebut !== "" && heureFin !== ""
      : datePonctuelle !== "" && new Date(datePonctuelle).getTime() > Date.now());

  return (
    <div className={embedded ? "" : "mx-auto w-full max-w-6xl px-4 pb-20 pt-6 sm:px-6 sm:pt-10"}>
      {embedded ? null : (
      <header>
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--g3-muted)]">Automatisations</p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">Planifications</h1>
        <p className="mt-2 max-w-2xl text-sm text-[var(--g3-muted)]">
          Vos agents s&apos;exécutent seuls, au moment choisi : fenêtre hebdomadaire, date ponctuelle, veille d&apos;un flux
          RSS/Web ou webhook entrant. Chaque exécution produit un compte rendu et, le cas échéant, des livrables.
        </p>
      </header>
      )}

      {erreur ? <div className="mt-4 rounded-xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]">{erreur}</div> : null}
      {notice ? <div className="mt-4 rounded-xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]">{notice}</div> : null}

      {chargement ? (
        <p className="mt-10 text-sm text-[var(--g3-muted)]">Chargement de vos planifications…</p>
      ) : (
        <div className="mt-6 grid gap-5">
          {/* Agent requis — création rapide si nécessaire */}
          {agents.length === 0 ? (
            <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface, transparent)] p-5">
              <h2 className="text-base font-semibold">Créez d&apos;abord un agent</h2>
              <p className="mt-1 text-sm text-[var(--g3-muted)]">
                Une planification exécute toujours UN agent précis. Donnez-lui un nom — la charte professionnelle est
                générée automatiquement côté serveur.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <input
                  value={nomAgent}
                  onChange={(event) => setNomAgent(event.target.value)}
                  placeholder="Nom de l'agent (ex. Assistant veille concurrentielle)"
                  className="min-w-0 flex-1 rounded-xl border border-[var(--g3-border-strong)] px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  onClick={() => void creerAgentRapide()}
                  disabled={nomAgent.trim().length < 2 || agentEnCours}
                  className="rounded-xl bg-[var(--g3-deep)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--g3-elevated)] disabled:opacity-50"
                >
                  {agentEnCours ? "Création…" : "Créer l'agent"}
                </button>
              </div>
            </section>
          ) : null}

          {/* Nouvelle planification */}
          <section className="rounded-2xl border border-[var(--g3-border)] p-5">
            <h2 className="text-base font-semibold">Nouvelle planification</h2>
            <div className="mt-4 grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Agent à exécuter</span>
                  <select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2">
                    <option value="">— Choisir un agent —</option>
                    {agents.filter((a) => a.status === "active").map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  <span className="mb-1 block font-medium">Nom de la tâche</span>
                  <input value={nom} onChange={(event) => setNom(event.target.value)} placeholder="ex. Rapport de veille chaque matin" className="w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2" />
                </label>
              </div>

              <label className="text-sm">
                <span className="mb-1 block font-medium">Objectif donné à l&apos;agent</span>
                <textarea
                  value={objectif}
                  onChange={(event) => setObjectif(event.target.value)}
                  rows={3}
                  placeholder="ex. Parcours les sources surveillées, résume les nouveautés en 10 points et enregistre le rapport."
                  className="w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2"
                />
              </label>

              <div className="flex flex-wrap gap-2" role="tablist" aria-label="Type de planification">
                {([
                  ["recurrente", "Récurrente (fenêtre hebdomadaire)"],
                  ["ponctuelle", "Ponctuelle (date et heure)"],
                ] as const).map(([valeur, label]) => (
                  <button
                    key={valeur}
                    type="button"
                    onClick={() => setMode(valeur)}
                    aria-pressed={mode === valeur}
                    className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${mode === valeur
                      ? "bg-[var(--g3-primary)] text-white"
                      : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)] hover:bg-[var(--g3-hover)]"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {mode === "recurrente" ? (
                <div className="grid gap-4 rounded-xl border border-[var(--g3-border)] p-4">
                  <div className="text-sm">
                    <span className="mb-2 block font-medium">Jours d&apos;exécution</span>
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {JOURS.map((jour) => (
                        <label key={jour.valeur} className="flex items-center gap-1.5 text-xs">
                          <input
                            type="checkbox"
                            checked={jours.includes(jour.valeur)}
                            onChange={(event) =>
                              setJours((precedent) =>
                                event.target.checked
                                  ? [...precedent, jour.valeur]
                                  : precedent.filter((j) => j !== jour.valeur),
                              )
                            }
                            className="h-3.5 w-3.5"
                          />
                          {jour.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <label className="text-sm">
                      <span className="mb-1 block font-medium">Heure de début</span>
                      <input type="time" value={heureDebut} onChange={(event) => setHeureDebut(event.target.value)} className="w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2" />
                    </label>
                    <label className="text-sm">
                      <span className="mb-1 block font-medium">Heure de fin</span>
                      <input type="time" value={heureFin} onChange={(event) => setHeureFin(event.target.value)} className="w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2" />
                    </label>
                    <label className="text-sm">
                      <span className="mb-1 block font-medium">Intervalle (minutes)</span>
                      <input
                        type="number"
                        min={0}
                        max={1440}
                        value={intervalle}
                        onChange={(event) => setIntervalle(Number(event.target.value))}
                        className="w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2"
                      />
                      <span className="mt-1 block text-[11px] text-[var(--g3-faint)]">0 = une seule exécution au début de la fenêtre.</span>
                    </label>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--g3-border)] p-4">
                  <label className="text-sm">
                    <span className="mb-1 block font-medium">Date et heure d&apos;exécution</span>
                    <input type="datetime-local" value={datePonctuelle} onChange={(event) => setDatePonctuelle(event.target.value)} className="w-full rounded-xl border border-[var(--g3-border-strong)] px-3 py-2" />
                    <span className="mt-1 block text-[11px] text-[var(--g3-faint)]">Fuseau détecté : {FUSEAU}. La tâche se désarme après son exécution unique.</span>
                  </label>
                </div>
              )}

              <div className="rounded-xl border border-[var(--g3-border)] p-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={veilleActive} onChange={(event) => setVeilleActive(event.target.checked)} className="h-4 w-4" />
                  <span className="font-medium">Toujours active — surveiller un contenu (RSS ou page web)</span>
                </label>
                {veilleActive ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[120px_1fr]">
                    <select value={veilleType} onChange={(event) => setVeilleType(event.target.value as "rss" | "web")} className="rounded-xl border border-[var(--g3-border-strong)] px-3 py-2 text-sm">
                      <option value="rss">Flux RSS</option>
                      <option value="web">Page web</option>
                    </select>
                    <input value={veilleUrl} onChange={(event) => setVeilleUrl(event.target.value)} placeholder="https://exemple.com/flux" className="rounded-xl border border-[var(--g3-border-strong)] px-3 py-2 text-sm" />
                  </div>
                ) : null}
                <p className="mt-2 text-[11px] text-[var(--g3-faint)]">
                  L&apos;agent démarre automatiquement quand le contenu surveillé change — la fenêtre horaire devient optionnelle.
                </p>
              </div>

              <div>
                <button
                  type="button"
                  onClick={() => void creerPlanification()}
                  disabled={!formulaireValide || creationEnCours}
                  className="rounded-xl bg-[var(--g3-deep)] px-5 py-2.5 text-sm font-semibold text-white hover:bg-[var(--g3-elevated)] disabled:opacity-50"
                >
                  {creationEnCours ? "Création…" : "Créer la planification"}
                </button>
              </div>
            </div>
          </section>

          {/* Liste des planifications */}
          <section className="grid gap-3">
            <h2 className="text-base font-semibold">Vos planifications ({planifications.length})</h2>
            {planifications.length === 0 ? (
              <p className="rounded-xl border border-[var(--g3-border)] px-4 py-6 text-center text-sm text-[var(--g3-muted)]">
                Aucune planification pour le moment — créez la première ci-dessus pour automatiser vos agents.
              </p>
            ) : (
              planifications.map((p) => {
                const badge = badgeStatut(p.lastExecutionStatus);
                return (
                  <article key={p.id} className="rounded-xl border border-[var(--g3-border)] px-4 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {p.name}
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${p.enabled ? "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]" : "bg-[var(--g3-elevated)] text-[var(--g3-muted)]"}`}>
                            {p.enabled ? "active" : "en pause"}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-[var(--g3-muted)]">{decrireRecurrence(p)}</p>
                        <p className="mt-0.5 text-xs text-[var(--g3-faint)]">
                          Agent : {agents.find((a) => a.id === p.agentId)?.name ?? p.agentId}
                          {" · "}Dernière exécution : {badge.texte} ({formatDate(p.lastExecutionAt)})
                          {p.nextRunAt ? ` · Prochaine : ${formatDate(p.nextRunAt)}` : ""}
                        </p>
                        {p.lastError ? <p className="mt-1 text-xs text-[var(--g3-danger-strong)]">Dernier échec : {p.lastError}</p> : null}
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void executerMaintenant(p)}
                          disabled={occupe === p.id || !p.enabled}
                          className="rounded-lg bg-[var(--g3-deep)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--g3-elevated)] disabled:opacity-50"
                        >
                          Exécuter maintenant
                        </button>
                        {p.watchSources?.length ? (
                          <button
                            type="button"
                            onClick={() => void verifierVeille(p)}
                            disabled={occupe === p.id}
                            className="rounded-lg border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--g3-elevated)] disabled:opacity-50"
                          >
                            Sondes de veille
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void voirHistorique(p)}
                          aria-expanded={historiqueOuvert === p.id}
                          className="rounded-lg border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--g3-elevated)]"
                        >
                          {historiqueOuvert === p.id ? "Masquer l'historique" : "Historique"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void basculerActive(p)}
                          disabled={occupe === p.id}
                          className="rounded-lg border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold hover:bg-[var(--g3-elevated)] disabled:opacity-50"
                        >
                          {p.enabled ? "Mettre en pause" : "Reprendre"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void supprimer(p)}
                          disabled={occupe === p.id}
                          className="rounded-lg border border-[var(--g3-danger-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-danger-strong)] hover:bg-[var(--g3-danger-soft)] disabled:opacity-50"
                        >
                          Supprimer
                        </button>
                      </div>
                    </div>

                    {p.alwaysOnWebhookToken ? (
                      <p className="mt-2 break-all rounded-lg bg-[var(--g3-elevated)] px-3 py-2 text-[11px] text-[var(--g3-muted)]">
                        Webhook entrant : <code>{typeof window !== "undefined" ? window.location.origin : "https://gen3ia.online"}/api/webhooks/agent-triggers/{p.alwaysOnWebhookToken}</code>
                      </p>
                    ) : null}

                    {historiqueOuvert === p.id ? (
                      <div className="mt-3 border-t border-[var(--g3-border)] pt-3">
                        {coursesEnCours ? (
                          <p className="text-xs text-[var(--g3-muted)]">Chargement de l&apos;historique…</p>
                        ) : courses.length === 0 ? (
                          <p className="text-xs text-[var(--g3-muted)]">Aucune exécution enregistrée pour l&apos;instant.</p>
                        ) : (
                          <ul className="grid gap-2">
                            {courses.map((course) => {
                              const badgeCourse = badgeStatut(course.status);
                              return (
                                <li key={course.id} className="rounded-lg bg-[var(--g3-elevated)] px-3 py-2 text-xs">
                                  <p className="flex flex-wrap items-center gap-2">
                                    <span className={badgeCourse.classe}>{badgeCourse.texte}</span>
                                    <span className="text-[var(--g3-faint)]">{course.trigger ?? "scheduled"}</span>
                                    <span className="text-[var(--g3-faint)]">{formatDate(course.startedAt)}</span>
                                    {course.deliverables?.length ? (
                                      <span className="text-[var(--g3-faint)]">{course.deliverables.length} livrable(s)</span>
                                    ) : null}
                                  </p>
                                  {course.outputPreview ? (
                                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[var(--g3-muted)]">{course.outputPreview}</p>
                                  ) : null}
                                  {course.error ? <p className="mt-1 text-[var(--g3-danger-strong)]">{course.error}</p> : null}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })
            )}
          </section>
        </div>
      )}
    </div>
  );
}
