"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { authFetch, useAuth } from "@/lib/firebase/auth-client";
import { FeatureAuthGate, useServerSessionUser } from "@/components/auth/feature-auth-gate";

const MODES = [
  { href: "/studio", label: "Agent", description: "Planifier et exécuter", icon: "✦" },
  { href: "/studio/interface-lab", label: "Build", description: "Créer une interface", icon: "⌘" },
  { href: "/live", label: "Live", description: "Agir sur un PC", icon: "◉" },
  { href: "/marketplace", label: "Marketplace", description: "Ajouter des capacités", icon: "◇" },
];

/** Modules métier (Task 15) — construits sur les 6 moteurs communs. */
const BUSINESS_MODULES = [
  { href: "/studio/marketing/landing", label: "Marketing", description: "Landing Pages · Webinar → Contenus", icon: "▶" },
  { href: "/studio/sales/call-intelligence", label: "Sales", description: "Call Intelligence", icon: "☎" },
  { href: "/studio/hr/leaves", label: "RH", description: "Congés · Formations", icon: "☺" },
  { href: "/studio/documents/contracts", label: "Documents", description: "Contrats · Onboarding", icon: "▤" },
  { href: "/studio/compliance/gdpr", label: "Conformité", description: "RGPD", icon: "⚖" },
  { href: "/studio/operations/maintenance", label: "Opérations", description: "Maintenance", icon: "⚒" },
  { href: "/studio/finance/cashflow", label: "Finance", description: "Cashflow · Impayés", icon: "₣" },
  { href: "/studio/automations", label: "Automatisations", description: "Workflows entre modules", icon: "⚡" },
];

const STATUS_LABELS: Record<string,string> = { draft:"Brouillon", awaiting_approval:"A valider", approved:"Approuvee", running:"En cours", completed:"Terminee", failed:"Echec", cancelled:"Annulee" };

function Arrow() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
}

function DashboardContent() {
  const { user } = useAuth();
  const router = useRouter();
  const serverUser = useServerSessionUser();
  const [objective, setObjective] = useState("");
  const [recentTasks, setRecentTasks] = useState<Array<{ id:string; objective:string; status:string; updatedAt:number }>>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function loadRecentTasks() {
      setTasksLoading(true); setTasksError(null);
      try {
        // authFetch : fonctionne aussi avec le seul cookie de session
        // (webviews où l'état Firebase client est perdu).
        const response = await authFetch("/api/workspace/tasks?limit=8", { cache: "no-store" });
        if (!response.ok) throw new Error(response.status >= 500 ? "Le serveur n'a pas pu charger vos tâches." : "Impossible de charger vos tâches.");
        const data = await response.json() as { tasks?: Array<{ id:string; objective:string; status:string; updatedAt:number }> };
        if (!cancelled) setRecentTasks(data.tasks ?? []);
      } catch (error) {
        if (!cancelled) {
          setRecentTasks([]);
          // Une panne ne doit pas ressembler à "aucune tâche récente".
          setTasksError(error instanceof Error ? error.message : "Impossible de charger vos tâches.");
        }
      } finally {
        if (!cancelled) setTasksLoading(false);
      }
    }
    void loadRecentTasks();
    return () => { cancelled = true; };
  }, []);

  const displayName = user?.displayName?.trim() || serverUser?.name?.trim() || user?.email || serverUser?.email || "vous";
  const firstName = useMemo(() => displayName.split(/[ .@_-]/)[0] || "vous", [displayName]);

  async function openAgent(event: React.FormEvent) {
    event.preventDefault();
    const value = objective.trim();
    if (!value || starting) {
      if (!value) router.push("/studio");
      return;
    }
    setStarting(true);
    try {
      const response = await authFetch("/api/workspace/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: value }),
      });
      const data = await response.json();
      if (!response.ok || !data.task?.id) throw new Error(data.error || "Impossible de préparer la tâche.");
      router.push("/studio?taskId=" + encodeURIComponent(data.task.id));
    } catch (error) {
      setStarting(false);
      window.alert(error instanceof Error ? error.message : "Impossible de préparer la tâche.");
    }
  }

  return (
    <div className="g3-home min-h-full bg-[#f6f4ef] text-neutral-900">
      <div className="g3-home-orb" aria-hidden="true" />
      <main className="relative mx-auto w-full max-w-[1180px] px-4 pb-16 pt-10 md:px-8 md:pt-16">
        <header className="mx-auto max-w-3xl text-center">
          <div className="g3-eyebrow">GEN3IA WORKSPACE</div>
          <h1 className="mt-4 font-serif text-4xl font-semibold tracking-[-.035em] md:text-6xl">
            Bonjour, <span className="gradient-text">{firstName}</span>
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-neutral-500 md:text-base">
            Décrivez ce que vous voulez accomplir. Gen3ia transforme votre objectif
            en plan, choisit les capacités nécessaires et vous laisse contrôler les actions sensibles.
          </p>
        </header>

        <section className="mx-auto mt-9 max-w-3xl" aria-label="Nouvelle tâche">
          <form onSubmit={openAgent} className="g3-home-composer">
            <div className="flex items-start gap-3">
              <div className="g3-home-composer-mark" aria-hidden="true">✦</div>
              <textarea
                value={objective}
                onChange={(event) => setObjective(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={3}
                placeholder="Que voulez-vous créer ou accomplir ?"
                aria-label="Objectif de la tâche"
                className="min-h-[92px] flex-1 resize-none bg-transparent text-base leading-7 outline-none placeholder:text-neutral-400"
              />
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-black/[.06] pt-3">
              <div className="flex flex-wrap gap-2">
                <span className="g3-home-chip">Plan automatique</span>
                <span className="g3-home-chip">Outils sécurisés</span>
                <span className="g3-home-chip">Validation humaine</span>
              </div>
              <button type="submit" disabled={starting} className="g3-home-submit disabled:opacity-50">
                {starting ? "Préparation..." : "Commencer"} <Arrow />
              </button>
            </div>
          </form>

          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {[
              "Analyse mes fichiers et résume-les",
              "Fais une recherche web et prépare un rapport",
              "Construis une interface pour mon SaaS",
            ].map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => setObjective(suggestion)} className="g3-home-suggestion">
                {suggestion}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-14" aria-label="Modes Gen3ia">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.22em] text-neutral-400">Créer avec Gen3ia</p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">Choisissez votre espace</h2>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {MODES.map((mode) => (
              <Link key={mode.href} href={mode.href} className="g3-home-mode group">
                <span className="g3-home-mode-icon">{mode.icon}</span>
                <span className="min-w-0 flex-1">
                  <strong>{mode.label}</strong>
                  <small>{mode.description}</small>
                </span>
                <Arrow />
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-14" aria-label="Modules métier">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[.22em] text-neutral-400">Votre entreprise</p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight">Modules métier</h2>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BUSINESS_MODULES.map((module) => (
              <Link key={module.href} href={module.href} className="g3-home-mode group">
                <span className="g3-home-mode-icon">{module.icon}</span>
                <span className="min-w-0 flex-1">
                  <strong>{module.label}</strong>
                  <small>{module.description}</small>
                </span>
                <Arrow />
              </Link>
            ))}
          </div>
        </section>

        <section className="mt-12 grid gap-8 lg:grid-cols-[1.45fr_.55fr]" aria-label="Travail récent">
          <div>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[.22em] text-neutral-400">Workspace</p>
                <h2 className="mt-1 text-lg font-semibold tracking-tight">Continuer</h2>
              </div>
              <Link href="/studio" className="text-xs font-semibold text-neutral-500 hover:text-neutral-900">Voir tout</Link>
            </div>
            <div className="space-y-2">
              {tasksLoading ? (
                <div className="g3-home-recent" aria-live="polite"><span className="g3-home-recent-dot" /><span className="text-xs text-neutral-400">Chargement du workspace...</span></div>
              ) : recentTasks.length ? recentTasks.map((item) => (
                <Link key={item.id} href={"/studio?task=" + encodeURIComponent(item.objective)} className="g3-home-recent group">
                  <span className="g3-home-recent-dot" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <strong>{item.objective.length > 72 ? item.objective.slice(0, 72) + "..." : item.objective}</strong>
                      <small>{STATUS_LABELS[item.status] ?? item.status}</small>
                    </span>
                    <span className="mt-1 block truncate text-xs text-neutral-400">Tache agent - {new Date(item.updatedAt).toLocaleString()}</span>
                  </span>
                  <Arrow />
                </Link>
              )) : tasksError ? (
                <div className="g3-home-recent" aria-live="polite"><span className="g3-home-recent-dot" /><span className="min-w-0 flex-1"><strong>Impossible de charger les tâches</strong><span className="mt-1 block text-xs text-neutral-400">{tasksError}</span></span></div>
              ) : (
                <div className="g3-home-recent" aria-live="polite"><span className="g3-home-recent-dot" /><span className="min-w-0 flex-1"><strong>Aucune tache recente</strong><span className="mt-1 block text-xs text-neutral-400">Lancez votre premiere mission depuis le champ ci-dessus.</span></span></div>
              )}          </div>
          </div>

          <aside className="g3-home-sidecard">
            <p className="text-[10px] font-bold uppercase tracking-[.2em] text-neutral-400">Contrôle</p>
            <h2 className="mt-2 text-base font-semibold">Gen3ia reste sous votre contrôle</h2>
            <p className="mt-2 text-xs leading-5 text-neutral-500">
              Les permissions, politiques d’exécution et approbations protègent les actions externes, financières, destructives et de publication.
            </p>
            <div className="mt-4 space-y-2 text-[11px] text-neutral-600">
              <div className="flex items-center gap-2"><span className="g3-home-check">✓</span> Plan validé avant exécution</div>
              <div className="flex items-center gap-2"><span className="g3-home-check">✓</span> Permissions par outil</div>
              <div className="flex items-center gap-2"><span className="g3-home-check">✓</span> Approbation des effets sensibles</div>
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <FeatureAuthGate
      feature="Tableau de bord Gen3ia"
      description="Connectez-vous pour accéder à l’espace de travail Gen3ia."
    >
      <DashboardContent />
    </FeatureAuthGate>
  );
}
