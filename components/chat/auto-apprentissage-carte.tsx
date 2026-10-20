"use client";

/**
 * CARTE AUTO-APPRENTISSAGE — la fenêtre honnête sur le CYCLE DE VIE de l'IA
 * (hubs Hugging Face + Kaggle ↔ entraînement Gen3), montée dans la sidebar
 * du dashboard chat.
 *
 *  - GET /api/ia/auto-apprentissage : état persistant RÉEL (cycles exécutés,
 *    paires et échantillons cumulés, dernier rapport, hubs configurés) +
 *    PHASE COURANTE (absorption avec compte à rebours / autonomie) ;
 *  - POST : déclenche un cycle complet à la demande — REFUSÉ en autonomie
 *    (hubs coupés définitivement, apprentissage par les utilisateurs) ;
 *  - 401 (non connecté) : la carte le dit — aucune donnée fabriquée.
 */

import * as React from "react";
import "./auto-apprentissage.css";

interface RapportCycleAuto {
  statut: "termine" | "partiel" | "echec" | "refuse";
  message: string;
  dureeMs: number;
}

interface BilanAutonomie {
  clotureA: string;
  dureeUtiliseeMs: number;
  pairesAbsorbees: number;
  echantillonsAbsorbes: number;
  datasetsAbsorbes: number;
  axes: string[];
  message: string;
}

interface EtatAutoApprentissage {
  cyclesExecutes: number;
  enCours: boolean;
  dernierRapport: RapportCycleAuto | null;
  datasetsIngestes: string[];
  pairesCumulees: number;
  echantillonsCumules: number;
  absorptionCloturee: boolean;
  absorptionClotureeA: string | null;
  bilanAutonomie: BilanAutonomie | null;
}

interface IntegrationHub {
  provider: string;
  configured: boolean;
}

const LABELS_HUB: Record<string, string> = {
  huggingface: "Hugging Face",
  kaggle: "Kaggle",
};

/** Compte à rebours lisible (h:mm:ss) — rafraîchi chaque seconde. */
function useCompteRebours(restantMsInitial: number | null): number | null {
  const [restantMs, setRestantMs] = React.useState<number | null>(restantMsInitial);
  const echeanceRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (restantMsInitial === null) {
      echeanceRef.current = null;
      setRestantMs(null);
      return;
    }
    echeanceRef.current = Date.now() + restantMsInitial;
    setRestantMs(restantMsInitial);
  }, [restantMsInitial]);

  React.useEffect(() => {
    if (echeanceRef.current === null) return;
    const tick = () => {
      if (echeanceRef.current === null) return;
      setRestantMs(Math.max(0, echeanceRef.current - Date.now()));
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  return restantMs;
}

function formaterDuree(ms: number): string {
  const totalSecondes = Math.floor(ms / 1000);
  const h = Math.floor(totalSecondes / 3600);
  const m = Math.floor((totalSecondes % 3600) / 60);
  const s = totalSecondes % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export default function CarteAutoApprentissage() {
  const [etat, setEtat] = React.useState<EtatAutoApprentissage | null>(null);
  const [phase, setPhase] = React.useState<"absorption" | "autonomie" | null>(null);
  const [restantInitial, setRestantInitial] = React.useState<number | null>(null);
  const [integrations, setIntegrations] = React.useState<IntegrationHub[]>([]);
  const [cycleEnCours, setCycleEnCours] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [charge, setCharge] = React.useState(true);
  const [occupe, setOccupe] = React.useState(false);

  const restantMs = useCompteRebours(phase === "absorption" ? restantInitial : null);

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
        phase?: "absorption" | "autonomie";
        restantMs?: number | null;
        cycleEnCours?: boolean;
        integrations?: IntegrationHub[];
      };
      setEtat(data.etat);
      setPhase(data.phase ?? (data.etat?.absorptionCloturee ? "autonomie" : "absorption"));
      setRestantInitial(typeof data.restantMs === "number" ? data.restantMs : null);
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

  const autonomie = phase === "autonomie";

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
          <p className={`auto-carte-phase ${autonomie ? "phase-autonomie" : "phase-absorption"}`}>
            {autonomie
              ? "Phase autonomie — apprentissage par les utilisateurs"
              : `Absorption des datasets${restantMs !== null ? ` — ${formaterDuree(restantMs)}` : ""}`}
          </p>
          {!autonomie ? (
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
          ) : null}
          <p className="auto-carte-ligne">
            {etat.cyclesExecutes} cycle{etat.cyclesExecutes > 1 ? "s" : ""} exécuté
            {etat.cyclesExecutes > 1 ? "s" : ""}
            {cycleEnCours && !autonomie ? " · cycle en cours…" : ""}
          </p>
          <p className="auto-carte-ligne">
            {etat.pairesCumulees} paires · {etat.echantillonsCumules} échantillons ·{" "}
            {etat.datasetsIngestes.length} datasets
          </p>
          {autonomie && etat.bilanAutonomie ? (
            <details className="auto-carte-bilan">
              <summary>Bilan d&apos;autonomie ({etat.bilanAutonomie.axes.length} axe{etat.bilanAutonomie.axes.length > 1 ? "s" : ""})</summary>
              <p className="auto-carte-bilan-message">{etat.bilanAutonomie.message}</p>
              <ul className="auto-carte-bilan-axes">
                {etat.bilanAutonomie.axes.map((axe) => (
                  <li key={axe}>{axe}</li>
                ))}
              </ul>
            </details>
          ) : null}
          {etat.dernierRapport ? (
            <p className={`auto-carte-dernier statut-${etat.dernierRapport.statut}`}>
              Dernier cycle : {etat.dernierRapport.statut} — {etat.dernierRapport.message}
            </p>
          ) : (
            <p className="auto-carte-dernier">
              {autonomie ? "Fenêtre d'absorption clôturée avant tout cycle." : "Premier cycle au lancement du serveur."}
            </p>
          )}
          {erreur ? <p className="auto-carte-ligne auto-carte-erreur">{erreur}</p> : null}
          {autonomie ? (
            <p className="auto-carte-ligne auto-carte-note">
              Hubs coupés définitivement : Gen3ia apprend désormais uniquement de
              ses utilisateurs (chaque échange consolidé devient connaissance).
            </p>
          ) : (
            <button
              type="button"
              className="auto-carte-bouton"
              onClick={() => void lancerCycle()}
              disabled={occupe || cycleEnCours}
            >
              {occupe || cycleEnCours ? "Cycle en cours…" : "Lancer un cycle maintenant"}
            </button>
          )}
        </>
      ) : null}
    </section>
  );
}
