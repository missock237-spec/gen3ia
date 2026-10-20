"use client";

/**
 * CARTE AUTO-APPRENTISSAGE — la fenêtre honnête sur la boucle autonome
 * (hubs Hugging Face + Kaggle ↔ entraînement Gen3), montée dans la sidebar
 * du dashboard chat.
 *
 *  - GET /api/ia/auto-apprentissage : état persistant RÉEL (cycles exécutés,
 *    paires et échantillons cumulés, dernier rapport, hubs configurés) ;
 *  - POST : déclenche un cycle complet à la demande (quota utilisateur) ;
 *  - 401 (non connecté) : la carte le dit — aucune donnée fabriquée.
 *
 * La boucle se déclenche déjà SEULE au lancement du serveur : cette carte
 * ne pilote rien d'obligatoire, elle rend l'autonomie visible.
 */

import * as React from "react";
import "./auto-apprentissage.css";

interface RapportCycleAuto {
  statut: "termine" | "partiel" | "echec";
  message: string;
  dureeMs: number;
}

interface EtatAutoApprentissage {
  cyclesExecutes: number;
  enCours: boolean;
  dernierRapport: RapportCycleAuto | null;
  datasetsIngestes: string[];
  pairesCumulees: number;
  echantillonsCumules: number;
}

interface IntegrationHub {
  provider: string;
  configured: boolean;
}

const LABELS_HUB: Record<string, string> = {
  huggingface: "Hugging Face",
  kaggle: "Kaggle",
};

export default function CarteAutoApprentissage() {
  const [etat, setEtat] = React.useState<EtatAutoApprentissage | null>(null);
  const [integrations, setIntegrations] = React.useState<IntegrationHub[]>([]);
  const [cycleEnCours, setCycleEnCours] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [charge, setCharge] = React.useState(true);
  const [occupe, setOccupe] = React.useState(false);

  const charger = React.useCallback(async () => {
    try {
      const res = await fetch("/api/ia/auto-apprentissage", { cache: "no-store" });
      if (res.status === 401) {
        setEtat(null);
        setErreur("Connectez-vous pour consulter l'auto-apprentissage.");
        return;
      }
      if (!res.ok) {
        setErreur(`Statut indisponible (${res.status}).`);
        return;
      }
      const data = (await res.json()) as {
        etat: EtatAutoApprentissage;
        cycleEnCours?: boolean;
        integrations?: IntegrationHub[];
      };
      setEtat(data.etat);
      setIntegrations(data.integrations ?? []);
      setCycleEnCours(Boolean(data.cycleEnCours) || Boolean(data.etat?.enCours));
      setErreur(null);
    } catch {
      setErreur("Statut indisponible (réseau).");
    } finally {
      setCharge(false);
    }
  }, []);

  React.useEffect(() => {
    void charger();
  }, [charger]);

  const lancerCycle = async () => {
    setOccupe(true);
    try {
      const res = await fetch("/api/ia/auto-apprentissage", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setErreur(data?.error ?? `Cycle impossible (${res.status}).`);
      } else {
        setErreur(null);
      }
    } catch {
      setErreur("Cycle impossible (réseau).");
    } finally {
      setOccupe(false);
      void charger();
    }
  };

  return (
    <section className="auto-carte" aria-label="Auto-apprentissage de l'IA">
      <header className="auto-carte-tete">
        <span className="auto-carte-titre">Auto-apprentissage</span>
        <button
          type="button"
          className="auto-carte-refresh"
          aria-label="Rafraîchir le statut"
          title="Rafraîchir"
          onClick={() => void charger()}
          disabled={charge}
        >
          ↻
        </button>
      </header>

      {charge ? (
        <p className="auto-carte-ligne">Chargement…</p>
      ) : erreur && !etat ? (
        <p className="auto-carte-ligne auto-carte-erreur">{erreur}</p>
      ) : etat ? (
        <>
          <div className="auto-carte-hubs">
            {integrations.map((h) => (
              <span
                key={h.provider}
                className={`auto-carte-hub${h.configured ? " actif" : ""}`}
                title={h.configured ? "Connecteur configuré" : "Jeton absent — ignoré honnêtement"}
              >
                {LABELS_HUB[h.provider] ?? h.provider} {h.configured ? "✓" : "·"}
              </span>
            ))}
          </div>
          <p className="auto-carte-ligne">
            {etat.cyclesExecutes} cycle{etat.cyclesExecutes > 1 ? "s" : ""} exécuté
            {etat.cyclesExecutes > 1 ? "s" : ""}
            {cycleEnCours ? " · cycle en cours…" : ""}
          </p>
          <p className="auto-carte-ligne">
            {etat.pairesCumulees} paires · {etat.echantillonsCumules} échantillons ·{" "}
            {etat.datasetsIngestes.length} datasets
          </p>
          {etat.dernierRapport ? (
            <p className={`auto-carte-dernier statut-${etat.dernierRapport.statut}`}>
              Dernier cycle : {etat.dernierRapport.statut} — {etat.dernierRapport.message}
            </p>
          ) : (
            <p className="auto-carte-dernier">Premier cycle au lancement du serveur.</p>
          )}
          {erreur ? <p className="auto-carte-ligne auto-carte-erreur">{erreur}</p> : null}
          <button
            type="button"
            className="auto-carte-bouton"
            onClick={() => void lancerCycle()}
            disabled={occupe || cycleEnCours}
          >
            {occupe || cycleEnCours ? "Cycle en cours…" : "Lancer un cycle maintenant"}
          </button>
        </>
      ) : null}
    </section>
  );
}
