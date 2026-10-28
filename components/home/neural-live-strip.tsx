"use client";

import { useEffect, useState } from "react";

/**
 * BANDEAU NEURONAL TEMPS RÉEL (vitrine publique) — AURORA OS V6.
 *
 * Affiche les MÉTRIQUES RÉELLES du moteur interne de la plateforme
 * (/api/neural/public-stats — compteurs anonymes : neurones, synapses,
 * poids moyen, cycles) : la vitrine prouve que l'IA de Gen3ia vit et
 * apprend, sans exposer aucune donnée utilisateur.
 */

interface StatsPubliques {
  moteur: string;
  cerveau: {
    nbNeurones: number;
    nbSynapses: number;
    poidsMoyen: number;
    histogramme: number[];
  } | null;
  sante: {
    cyclesTotaux: number;
    energieMoyenne: number;
    indiceHomeostasie: number;
    mode: string;
  } | null;
  iaExterne: string;
}

export function NeuralLiveStrip() {
  const [stats, setStats] = useState<StatsPubliques | null>(null);

  useEffect(() => {
    let annule = false;
    const charger = async () => {
      try {
        const reponse = await fetch("/api/neural/public-stats", { cache: "no-store" });
        if (reponse.ok && !annule) setStats(await reponse.json());
      } catch {
        /* vitrine : silencieux, le bandeau affiche la version sobre */
      }
    };
    void charger();
    const interval = setInterval(() => void charger(), 30_000);
    return () => {
      annule = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <div
      className="g3v6-card mx-auto mt-10 flex max-w-2xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-5 py-3"
      aria-label="État en direct du moteur neuronal Gen3"
    >
      <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[var(--g3v6-track)] text-[var(--g3v6-spike-text)]">
        <span className="g3v6-resonance-bar h-2 w-2" aria-hidden />
        Moteur en direct
      </span>
      {stats?.cerveau ? (
        <>
          <span className="g3v6-metric text-xs text-[var(--g3-text-secondary)]">
            {stats.cerveau.nbNeurones} neurones
          </span>
          <span className="g3v6-metric text-xs text-[var(--g3-text-secondary)]">
            {stats.cerveau.nbSynapses.toLocaleString("fr-FR")} synapses
          </span>
          <span className="g3v6-metric text-xs text-[var(--g3-text-secondary)]">
            poids moyen {stats.cerveau.poidsMoyen.toFixed(3)}
          </span>
          {stats.sante ? (
            <span className="g3v6-metric text-xs text-[var(--g3-text-secondary)]">
              {stats.sante.cyclesTotaux.toLocaleString("fr-FR")} cycles
            </span>
          ) : null}
        </>
      ) : (
        <span className="g3v6-metric text-xs text-[var(--g3-faint)]">
          système à spikes · plasticité hebbienne · 100 % local
        </span>
      )}
    </div>
  );
}
