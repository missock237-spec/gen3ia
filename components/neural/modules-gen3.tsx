"use client";

import { useCallback, useEffect, useState } from "react";

import { useVisiblePolling } from "@/components/hooks/use-visible-polling";

/**
 * TABLEAU DE BORD DES 12 MODULES GEN3 (demande propriétaire : architecture
 * 12 modules orchestrés par Gen3 Core — Core, Texte, Vision, Audio, Vidéo,
 * Code, Spatial, Mémoire, Apprentissage, Agents, Raisonnement, Recherche).
 *
 * Composant CLIENT authentifié (page /neural) : consomme
 * GET /api/neural/modules (force-dynamic) et affiche CE QUE LE SERVEUR
 * DÉCLARE ET VÉRIFIE — mission de chaque module, niveau N1/N2/N3, organes
 * réels vérifiés sur disque (fs.existsSync au moment de l'appel), outils
 * réels du registre, et le routage d'une demande testée à la volée
 * (module principal, secondaires, scores, latence réelle).
 *
 * Aucun chiffre fabriqué côté client : tout ce qui s'affiche vient de la
 * réponse du serveur. Sobriété : rafraîchissement gaté par la visibilité
 * (hook useVisiblePolling) — onglet en arrière-plan = zéro requête.
 */

interface ModuleApi {
  id: string;
  label: string;
  mission: string;
  niveau: "N1" | "N2" | "N3";
  nbOrganes: number;
  organesVerifies: number;
  organesAbsents: string[];
  outils: string[];
}

interface RoutageApi {
  demande: string;
  modulePrincipal: string;
  modulesSecondaires: string[];
  decide: boolean;
  latenceMs: number;
  scores: Array<{ id: string; label: string; score: number; signauxTrouves: string[] }>;
}

interface ReponseModules {
  mission: string;
  nbModules: number;
  santeOrganes: { total: number; verifies: number; absents: string[] };
  modules: ModuleApi[];
  routage: RoutageApi | null;
}

const COULEUR_NIVEAU: Record<string, string> = {
  N1: "border-sky-500/40 text-sky-300 bg-sky-500/10",
  N2: "border-violet-500/40 text-violet-300 bg-violet-500/10",
  N3: "border-amber-500/40 text-amber-300 bg-amber-500/10",
};

const EXEMPLES_DEMANDES = [
  "Crée une vidéo avec sous-titres pour mon produit",
  "Analyse cette image et décris les objets et couleurs",
  "Écris un script TypeScript pour corriger ce bug",
  "Entraîne-toi sur ce nouveau corpus de données",
];

export default function ModulesGen3() {
  const [data, setData] = useState<ReponseModules | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [demande, setDemande] = useState(EXEMPLES_DEMANDES[0]);
  const [routage, setRoutage] = useState<RoutageApi | null>(null);
  const [routageEnCours, setRoutageEnCours] = useState(false);

  const rafraichir = useCallback(async () => {
    try {
      const res = await fetch("/api/neural/modules", { cache: "no-store" });
      if (!res.ok) {
        setErreur(`HTTP ${res.status}`);
        return;
      }
      setData((await res.json()) as ReponseModules);
      setErreur(null);
    } catch {
      setErreur("indisponible");
    }
  }, []);

  useEffect(() => {
    void rafraichir();
  }, [rafraichir]);

  useVisiblePolling(rafraichir, 30_000);

  const testerRoutage = useCallback(async () => {
    setRoutageEnCours(true);
    try {
      const res = await fetch(`/api/neural/modules?q=${encodeURIComponent(demande)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const corps = (await res.json()) as ReponseModules;
      setRoutage(corps.routage ?? null);
    } catch {
      setRoutage(null);
    } finally {
      setRoutageEnCours(false);
    }
  }, [demande]);

  if (erreur) {
    return (
      <section className="rounded-xl border border-[var(--g3-border)] p-4 text-sm text-[var(--g3-text-secondary)]">
        Modules Gen3 — état indisponible ({erreur}).
      </section>
    );
  }
  if (!data) return null;

  const santePct = data.santeOrganes.total
    ? Math.round((data.santeOrganes.verifies / data.santeOrganes.total) * 100)
    : 0;

  return (
    <section className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-panel)] p-4">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--g3-text)]">
          Les 12 modules Gen3 — orchestrés par Gen3 Core
        </h2>
        <span className="text-xs text-[var(--g3-text-secondary)]">
          organes réels vérifiés : {data.santeOrganes.verifies}/{data.santeOrganes.total}{" "}
          ({santePct}%)
        </span>
      </header>
      <p className="mb-4 text-xs leading-relaxed text-[var(--g3-text-secondary)]">{data.mission}</p>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.modules.map((m) => (
          <article
            key={m.id}
            className="rounded-lg border border-[var(--g3-border)] p-3 text-sm"
          >
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="font-medium text-[var(--g3-text)]">{m.label}</h3>
              <span
                className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${COULEUR_NIVEAU[m.niveau] ?? ""}`}
              >
                {m.niveau}
              </span>
            </div>
            <p className="mb-2 line-clamp-4 text-xs leading-relaxed text-[var(--g3-text-secondary)]">
              {m.mission}
            </p>
            <p className="text-[11px] text-[var(--g3-text-secondary)]">
              organes : {m.organesVerifies}/{m.nbOrganes} · outils réels : {m.outils.length}
            </p>
            {m.organesAbsents.length > 0 && (
              <p className="mt-1 text-[11px] text-red-400">
                organes absents : {m.organesAbsents.join(", ")}
              </p>
            )}
          </article>
        ))}
      </div>

      <div className="mt-4 rounded-lg border border-[var(--g3-border)] p-3">
        <h3 className="mb-2 text-sm font-medium text-[var(--g3-text)]">
          Routage d&apos;une demande (déterministe, scores réels)
        </h3>
        <div className="flex flex-wrap gap-2">
          <input
            value={demande}
            onChange={(e) => setDemande(e.target.value)}
            className="min-w-0 flex-1 rounded border border-[var(--g3-border)] bg-[var(--g3-bg)] px-2 py-1.5 text-sm text-[var(--g3-text)]"
            aria-label="Demande à router vers les modules"
          />
          <button
            type="button"
            onClick={() => void testerRoutage()}
            disabled={routageEnCours}
            className="rounded border border-[var(--g3-border)] px-3 py-1.5 text-sm text-[var(--g3-text)] hover:bg-[var(--g3-hover)] disabled:opacity-50"
          >
            {routageEnCours ? "…" : "Router"}
          </button>
        </div>
        {routage && (
          <div className="mt-3 text-xs text-[var(--g3-text-secondary)]">
            <p>
              Module principal :{" "}
              <span className="font-semibold text-[var(--g3-text)]">
                {routage.modulePrincipal}
              </span>{" "}
              {routage.decide ? "" : "(sous le seuil — repli honnête sur Core)"} · secondaires :{" "}
              {routage.modulesSecondaires.length > 0
                ? routage.modulesSecondaires.join(", ")
                : "aucun"}{" "}
              · décision en {routage.latenceMs} ms
            </p>
            <ul className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
              {routage.scores
                .filter((s) => s.score > 0)
                .slice(0, 6)
                .map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2">
                    <span>{s.label}</span>
                    <span>
                      {s.score} ({s.signauxTrouves.length} signaux)
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
