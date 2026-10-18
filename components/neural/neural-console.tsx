"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * CONSOLE DE TEST DU SYSTÈME NEURONAL GEN3 — surface d'interaction complète
 * avec le cerveau à spikes : conversation (cycles réels), état du réseau
 * (santé, synapses, pools), entraînement sur le corpus du projet et reset.
 *
 * Toutes les données affichées sont RÉELLES (aucune simulation) : elles
 * proviennent de /api/neural/state, /api/neural/cycle, /api/neural/train.
 */

interface EtatNeural {
  moteurNeuralActif: boolean;
  modele: string;
  creeLe: string;
  cerveau: {
    nbNeurones: number;
    nbSynapses: number;
    poids: { moyen: number; min: number; max: number };
  };
  sante: {
    cyclesTotaux: number;
    energieMoyenne: number;
    indiceHomeostasie: number;
    modeActuel: string;
  };
  horlogeVirtuelle: number;
  poolsSortie: Record<string, number[]>;
  outils: Array<{
    nom: string;
    description: string;
    utilisations: number;
    succesHistorique: number;
  }>;
  competences: Array<{ nom: string; version: string; description: string }>;
  historiqueEntrainement: Array<{
    epochs: number;
    samples: number;
    accuracyTrain: number;
    accuracyTest: number;
    startedAt: string;
  }>;
  dernierJobEntrainement: JobEntrainement | null;
}

interface JobEntrainement {
  id: string;
  status: "en_cours" | "termine" | "echec";
  demarreLe: string;
  termineLe?: string;
  epochs: number;
  epochCourante: number;
  accuracyCourante: number;
  nbEchantillons: number;
  statsDataset: Record<string, number>;
  erreur?: string;
  rapport?: {
    epochs: number;
    samples: number;
    accuracyTrain: number;
    accuracyTest: number;
    history: Array<{ epoch: number; accuracy: number }>;
    dureeMs: number;
  };
}

interface MessageConversation {
  role: "utilisateur" | "reseaux";
  texte: string;
  meta?: {
    intention?: string;
    scoreResonance?: number;
    motsCles?: string[];
    latencyMs?: number;
  };
}

const cardNeutre: React.CSSProperties = {
  background: "var(--g3-surface)",
  borderRadius: "var(--gen3ia-radius, 20px)",
  boxShadow: "var(--gen3ia-shadow-sm)",
};

function pct(valeur: number): string {
  return `${Math.round(valeur * 100)} %`;
}

export function NeuralConsole() {
  const [etat, setEtat] = useState<EtatNeural | null>(null);
  const [erreurAuth, setErreurAuth] = useState(false);
  const [message, setMessage] = useState("");
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [conversation, setConversation] = useState<MessageConversation[]>([]);
  const [lancement, setLancement] = useState<string | null>(null);
  const finConversation = useRef<HTMLDivElement>(null);

  const rafraichirEtat = useCallback(async () => {
    try {
      const reponse = await fetch("/api/neural/state", { cache: "no-store" });
      if (reponse.status === 401 || reponse.status === 403) {
        setErreurAuth(true);
        return;
      }
      if (reponse.ok) setEtat(await reponse.json());
    } catch {
      /* silencieux : la console retentera au prochain cycle */
    }
  }, []);

  useEffect(() => {
    void rafraichirEtat();
    const interval = setInterval(() => void rafraichirEtat(), 5000);
    return () => clearInterval(interval);
  }, [rafraichirEtat]);

  // Progression du job d'entraînement : interrogation rapprochée.
  const jobEnCours = etat?.dernierJobEntrainement?.status === "en_cours";
  useEffect(() => {
    if (!jobEnCours) return;
    const interval = setInterval(() => void rafraichirEtat(), 1500);
    return () => clearInterval(interval);
  }, [jobEnCours, rafraichirEtat]);

  useEffect(() => {
    finConversation.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation]);

  async function envoyerMessage(evenement: React.FormEvent) {
    evenement.preventDefault();
    const texte = message.trim();
    if (!texte || envoiEnCours) return;

    setConversation((precedent) => [
      ...precedent,
      { role: "utilisateur", texte },
    ]);
    setMessage("");
    setEnvoiEnCours(true);
    try {
      const reponse = await fetch("/api/neural/cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: texte }),
      });
      const donnees = await reponse.json();
      if (!reponse.ok) throw new Error(donnees.error ?? "Cycle impossible.");
      setConversation((precedent) => [
        ...precedent,
        {
          role: "reseaux",
          texte: donnees.reponse.texte,
          meta: {
            intention: donnees.reponse.intention,
            scoreResonance: donnees.reponse.scoreResonance,
            motsCles: donnees.reponse.motsCles,
            latencyMs: donnees.reponse.latencyMs,
          },
        },
      ]);
      void rafraichirEtat();
    } catch (erreur) {
      setConversation((precedent) => [
        ...precedent,
        {
          role: "reseaux",
          texte: `Erreur : ${erreur instanceof Error ? erreur.message : "inconnue"}`,
        },
      ]);
    } finally {
      setEnvoiEnCours(false);
    }
  }

  async function lancerEntrainement() {
    if (jobEnCours) return;
    setLancement(null);
    try {
      const reponse = await fetch("/api/neural/train", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ epochs: 4 }),
      });
      const donnees = await reponse.json();
      if (!reponse.ok) throw new Error(donnees.error ?? "Lancement impossible.");
      setLancement("Entraînement lancé — progression en direct ci-dessous.");
      void rafraichirEtat();
    } catch (erreur) {
      setLancement(
        `Échec du lancement : ${erreur instanceof Error ? erreur.message : "inconnue"}`,
      );
    }
  }

  async function reinitialiserCerveau() {
    setLancement(null);
    try {
      const reponse = await fetch("/api/neural/reset", { method: "POST" });
      const donnees = await reponse.json();
      if (!reponse.ok) throw new Error(donnees.error ?? "Reset impossible.");
      setLancement("Cerveau réinitialisé à l'état initial (seed 42).");
      setConversation([]);
      void rafraichirEtat();
    } catch (erreur) {
      setLancement(
        `Échec du reset : ${erreur instanceof Error ? erreur.message : "inconnue"}`,
      );
    }
  }

  if (erreurAuth) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24 text-center">
        <h1 className="text-2xl font-semibold">Console neuronale Gen3</h1>
        <p className="mt-4 text-[var(--g3-muted)]">
          Connectez-vous pour interagir avec le système neuronal.
        </p>
      </div>
    );
  }

  const job = etat?.dernierJobEntrainement ?? null;
  const dernierRapport = job?.rapport ?? null;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      {/* En-tête */}
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-[var(--g3-faint)]">
            Système neuronal Gen3
          </p>
          <h1 className="mt-2 text-3xl font-semibold">
            Console{" "}
            <span
              style={{
                background: "var(--g3-gradient)",
                WebkitBackgroundClip: "text",
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              cerveau à spikes
            </span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--g3-muted)]">
            Réseau à impulsions de 100 neurones, plasticité synaptique,
            corps sémantique à 6 effecteurs. Réponses honnêtes : ce réseau
            détecte des intentions, il ne génère pas de prose — moteur de
            rendu externe déconnecté en mode neuronal.
          </p>
        </div>
        <div
          className="flex items-center gap-2 px-4 py-2 text-sm"
          style={{
            ...cardNeutre,
            color: etat?.moteurNeuralActif
              ? "var(--g3-success-strong)"
              : "var(--g3-muted)",
          }}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background: etat?.moteurNeuralActif
                ? "var(--g3-success)"
                : "var(--g3-faint)",
              boxShadow: etat?.moteurNeuralActif
                ? "0 0 12px var(--g3-success)"
                : undefined,
            }}
          />
          {etat?.moteurNeuralActif
            ? "Mode neuronal actif"
            : "Mode externe (flag GEN3IA_AI_ENGINE)"}
        </div>
      </header>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        {/* Colonne conversation */}
        <section className="flex flex-col" style={{ ...cardNeutre, padding: 24 }}>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--g3-muted)]">
            Conversation (cycles réels)
          </h2>

          <div className="mt-4 flex-1 space-y-3 overflow-y-auto" style={{ maxHeight: 420 }}>
            {conversation.length === 0 && (
              <p className="text-sm text-[var(--g3-faint)]">
                Parlez au réseau : « génère une image de chat », « appelle le
                support », « joue un son »… Chaque message est encodé en
                stimulations neuronales, le cerveau propage ses spikes et la
                résonance des pools décide de l&apos;intention.
              </p>
            )}
            {conversation.map((tour, index) => (
              <div
                key={index}
                className="leading-relaxed"
                style={{
                  borderRadius: 16,
                  padding: "12px 16px",
                  background:
                    tour.role === "utilisateur"
                      ? "var(--g3-primary-soft)"
                      : "var(--g3-elevated)",
                }}
              >
                <p className="whitespace-pre-wrap text-sm">{tour.texte}</p>
                {tour.meta?.intention && (
                  <p className="mt-2 flex flex-wrap gap-x-4 text-xs text-[var(--g3-faint)]">
                    <span>
                      intention :{" "}
                      <b className="text-[var(--g3-secondary)]">
                        {tour.meta.intention}
                      </b>
                    </span>
                    {typeof tour.meta.scoreResonance === "number" && (
                      <span>résonance : {tour.meta.scoreResonance.toFixed(2)}</span>
                    )}
                    {typeof tour.meta.latencyMs === "number" && (
                      <span>{tour.meta.latencyMs} ms</span>
                    )}
                  </p>
                )}
              </div>
            ))}
            <div ref={finConversation} />
          </div>

          <form onSubmit={envoyerMessage} className="mt-4 flex gap-3">
            <input
              value={message}
              onChange={(evenement) => setMessage(evenement.target.value)}
              placeholder="Votre message au cerveau…"
              maxLength={4000}
              className="flex-1 px-4 py-3 text-sm outline-none"
              style={{
                borderRadius: 14,
                background: "var(--g3-elevated)",
                color: "var(--g3-text)",
              }}
            />
            <button
              type="submit"
              disabled={envoiEnCours || message.trim().length === 0}
              className="px-5 py-3 text-sm font-semibold disabled:opacity-40"
              style={{
                borderRadius: 14,
                background: "var(--g3-gradient)",
                color: "var(--g3-on-primary)",
              }}
            >
              {envoiEnCours ? "Cycles…" : "Envoyer"}
            </button>
          </form>
        </section>

        {/* Colonne état + entraînement */}
        <div className="space-y-6">
          <section style={{ ...cardNeutre, padding: 24 }}>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--g3-muted)]">
              État du cerveau
            </h2>
            {etat ? (
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <dt className="text-[var(--g3-faint)]">Neurones</dt>
                  <dd className="text-lg font-semibold">
                    {etat.cerveau.nbNeurones}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--g3-faint)]">Synapses</dt>
                  <dd className="text-lg font-semibold">
                    {etat.cerveau.nbSynapses}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--g3-faint)]">Poids moyen</dt>
                  <dd className="text-lg font-semibold">
                    {etat.cerveau.poids.moyen.toFixed(3)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--g3-faint)]">Cycles totaux</dt>
                  <dd className="text-lg font-semibold">
                    {etat.sante.cyclesTotaux}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--g3-faint)]">Énergie moyenne</dt>
                  <dd className="text-lg font-semibold">
                    {etat.sante.energieMoyenne.toFixed(3)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--g3-faint)]">Homéostasie</dt>
                  <dd className="text-lg font-semibold">
                    {etat.sante.indiceHomeostasie.toFixed(2)}
                  </dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[var(--g3-faint)]">Mode</dt>
                  <dd>{etat.sante.modeActuel}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-[var(--g3-faint)]">
                    Pools de sortie ({Object.keys(etat.poolsSortie).length})
                  </dt>
                  <dd className="mt-1 flex flex-wrap gap-1.5">
                    {Object.keys(etat.poolsSortie).map((pool) => (
                      <span
                        key={pool}
                        className="px-2 py-1 text-xs"
                        style={{
                          borderRadius: 8,
                          background: "var(--g3-elevated)",
                          color: "var(--g3-secondary)",
                        }}
                      >
                        {pool}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="mt-4 text-sm text-[var(--g3-faint)]">Chargement…</p>
            )}
          </section>

          <section style={{ ...cardNeutre, padding: 24 }}>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--g3-muted)]">
              Entraînement (corpus du projet)
            </h2>
            <p className="mt-2 text-xs text-[var(--g3-faint)]">
              Boucle supervisée réelle sur public/llms*.txt + amorçage
              canonique — plasticité synaptique guidée, accuracy mesurée,
              cerveau persisté après chaque run.
            </p>

            {job && (
              <div className="mt-4 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--g3-faint)]">Statut</span>
                  <span
                    style={{
                      color:
                        job.status === "termine"
                          ? "var(--g3-success-strong)"
                          : job.status === "echec"
                            ? "var(--g3-danger-strong)"
                            : "var(--g3-warning-strong)",
                    }}
                  >
                    {job.status === "en_cours"
                      ? `Époque ${job.epochCourante}/${job.epochs}`
                      : job.status}
                  </span>
                </div>
                {job.status === "en_cours" && (
                  <div>
                    <div
                      className="h-1.5 w-full overflow-hidden"
                      style={{ borderRadius: 4, background: "var(--g3-elevated)" }}
                    >
                      <div
                        className="h-full transition-all"
                        style={{
                          width: `${(job.epochCourante / job.epochs) * 100}%`,
                          background: "var(--g3-gradient)",
                        }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-[var(--g3-faint)]">
                      accuracy courante : {pct(job.accuracyCourante)} ·{" "}
                      {job.nbEchantillons} échantillons
                    </p>
                  </div>
                )}
                {dernierRapport && (
                  <div className="text-xs text-[var(--g3-muted)]">
                    <p>
                      Accuracy train :{" "}
                      <b className="text-[var(--g3-text)]">
                        {pct(dernierRapport.accuracyTrain)}
                      </b>{" "}
                      · test :{" "}
                      <b className="text-[var(--g3-text)]">
                        {pct(dernierRapport.accuracyTest)}
                      </b>{" "}
                      · {dernierRapport.dureeMs} ms
                    </p>
                  </div>
                )}
                {job.erreur && (
                  <p className="text-xs" style={{ color: "var(--g3-danger-strong)" }}>
                    {job.erreur}
                  </p>
                )}
              </div>
            )}

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                onClick={() => void lancerEntrainement()}
                disabled={jobEnCours}
                className="px-4 py-2.5 text-sm font-semibold disabled:opacity-40"
                style={{
                  borderRadius: 12,
                  background: "var(--g3-gradient)",
                  color: "var(--g3-on-primary)",
                }}
              >
                {jobEnCours ? "Entraînement…" : "Lancer l'entraînement"}
              </button>
              <button
                onClick={() => void reinitialiserCerveau()}
                disabled={jobEnCours}
                className="px-4 py-2.5 text-sm disabled:opacity-40"
                style={{
                  borderRadius: 12,
                  background: "var(--g3-elevated)",
                  color: "var(--g3-muted)",
                }}
              >
                Réinitialiser le cerveau
              </button>
            </div>
            {lancement && (
              <p className="mt-3 text-xs text-[var(--g3-secondary)]">{lancement}</p>
            )}
          </section>

          {etat && etat.historiqueEntrainement.length > 0 && (
            <section style={{ ...cardNeutre, padding: 24 }}>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--g3-muted)]">
                Historique ({etat.historiqueEntrainement.length})
              </h2>
              <ul className="mt-3 space-y-1.5 text-xs text-[var(--g3-muted)]">
                {etat.historiqueEntrainement
                  .slice(-5)
                  .reverse()
                  .map((rapport, index) => (
                    <li key={index} className="flex justify-between gap-2">
                      <span>{new Date(rapport.startedAt).toLocaleString("fr-FR")}</span>
                      <span>
                        {rapport.samples} éch. · test {pct(rapport.accuracyTest)}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
