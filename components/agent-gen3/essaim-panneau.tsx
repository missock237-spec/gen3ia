"use client";

import { useEffect, useState } from "react";

import { authFetch, readJsonSafely } from "@/lib/firebase/auth-client";
import { sAbonnerAgent, type ÉtatAgentGen3 } from "@/lib/essaim-media/agent-client";

interface ÉtatEssaimRéseau {
  noeudsEnLigne: number;
  top: Array<{
    noeudId: string;
    adaptateur: string;
    memoireGo: number;
    score: number;
    charge: number;
    succès: number;
    âgeBattementMs: number;
  }>;
}

interface JobRésumé {
  jobId: string;
  kind: string;
  état: string;
  fragments: number;
  terminés: number;
  relances: number;
}

/**
 * PANNEAU ESSAIM MÉDIA — l'état vivant du maillage gen3.
 *
 * Montre : l'agent local (installé à la connexion, cache navigateur),
 * les nœuds en ligne (5 meilleurs GPU à l'œuvre), les jobs en cours et
 * les relances automatiques. Honnêteté : tout ce qui s'affiche vient
 * d'une sonde réelle (/api/essaim/etat), jamais simulé.
 */
export function EssaimPanneau() {
  const [agent, setAgent] = useState<ÉtatAgentGen3 | null>(null);
  const [essaim, setEssaim] = useState<ÉtatEssaimRéseau | null>(null);
  const [mesJobs, setMesJobs] = useState<JobRésumé[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => sAbonnerAgent(setAgent), []);

  useEffect(() => {
    let annulé = false;
    const sonder = async (): Promise<void> => {
      try {
        const r = await authFetch("/api/essaim/etat", { signal: AbortSignal.timeout(8_000) });
        const data = await readJsonSafely<{
          success?: boolean;
          essaim?: ÉtatEssaimRéseau;
          mesJobs?: JobRésumé[];
          error?: string;
        }>(r);
        if (annulé) return;
        if (data?.success && data.essaim) {
          setEssaim(data.essaim);
          setMesJobs(data.mesJobs ?? []);
          setErreur(null);
        } else {
          setErreur(data?.error ?? "Sonde indisponible.");
        }
      } catch {
        if (!annulé) setErreur("IA centrale injoignable — les ondes ne passent pas.");
      }
    };
    void sonder();
    const timer = setInterval(() => void sonder(), 5_000);
    return () => {
      annulé = true;
      clearInterval(timer);
    };
  }, []);

  const badgeAgent = (): { label: string; classe: string } => {
    switch (agent?.statut) {
      case "actif":
        return { label: "agent actif", classe: "bg-emerald-500/15 text-emerald-400" };
      case "installation":
        return { label: "installation…", classe: "bg-amber-500/15 text-amber-400" };
      case "échec":
        return { label: agent.raison ?? "agent inapte", classe: "bg-rose-500/15 text-rose-400" };
      default:
        return { label: "hors session", classe: "bg-white/5 text-white/60" };
    }
  };

  const badge = badgeAgent();

  return (
    <section
      aria-labelledby="essaim-titre"
      className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-6"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="essaim-titre" className="text-base font-semibold text-white/90 sm:text-lg">
            Essaim média gen3
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-white/50 sm:text-sm">
            À chaque connexion, un petit agent gen3 se télécharge dans le cache de votre
            navigateur. L&apos;IA centrale choisit les <strong className="text-white/70">5 meilleurs
            GPU</strong> de l&apos;essaim, envoie une part de la tâche à chacun via le canal
            d&apos;ondes (WebGPU), associe les signaux retournés — et relance automatiquement la
            part de tout agent qui se déconnecte brusquement.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${badge.classe}`}>
          {badge.label}
        </span>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="text-xs uppercase tracking-wide text-white/40">Nœuds en ligne</p>
          <p className="mt-1 text-2xl font-semibold text-white/90">{essaim?.noeudsEnLigne ?? "—"}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="text-xs uppercase tracking-wide text-white/40">Parts calculées par votre GPU</p>
          <p className="mt-1 text-2xl font-semibold text-white/90">{agent?.partsTerminées ?? 0}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="text-xs uppercase tracking-wide text-white/40">Relances reçues (reprises d&apos;agents rompus)</p>
          <p className="mt-1 text-2xl font-semibold text-white/90">{agent?.relancesReçues ?? 0}</p>
        </div>
      </div>

      {agent?.partEnCours ? (
        <p className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
          Votre GPU calcule : {agent.partEnCours}…
        </p>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
            Meilleurs GPU de l&apos;essaim
          </h3>
          <div className="max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-black/20">
            {essaim && essaim.top.length > 0 ? (
              <ul className="divide-y divide-white/5">
                {essaim.top.map((n) => (
                  <li key={n.noeudId} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="truncate text-white/70">
                      {n.adaptateur}
                      <span className="text-white/30"> · {n.memoireGo.toFixed(1)} Go</span>
                    </span>
                    <span className="shrink-0 font-mono text-white/50">
                      score {n.score.toFixed(2)} · {n.charge > 0 ? "en charge" : "libre"} · {n.succès} ✓
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-4 text-xs text-white/40">
                {erreur ?? "Aucun nœud en ligne — connectez-vous depuis un navigateur WebGPU pour ouvrir l'essaim."}
              </p>
            )}
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-white/40">
            Vos jobs d&apos;essaim en cours
          </h3>
          <div className="max-h-48 overflow-y-auto rounded-xl border border-white/10 bg-black/20">
            {mesJobs.length > 0 ? (
              <ul className="divide-y divide-white/5">
                {mesJobs.map((j) => (
                  <li key={j.jobId} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                    <span className="text-white/70">
                      {j.kind} — {j.terminés}/{j.fragments} parts
                      {j.relances > 0 ? (
                        <span className="text-amber-400"> · {j.relances} relance(s)</span>
                      ) : null}
                    </span>
                    <span className="font-mono text-white/50">{j.état}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-4 text-xs text-white/40">
                Aucun job actif. Demandez une image photoréaliste, une voix humaine ou une vidéo
                dans le chat : l&apos;essaim se mettra en branle.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
