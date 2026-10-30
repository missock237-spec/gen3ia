"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * CONSOLE NEURONALE — AURORA OS V6 (architecture neural-first).
 *
 * La pièce maîtresse de la plateforme : le SYSTÈME NEURONAL Gen3 y est
 * visible, vivant et pilotable. Toutes les données sont RÉELLES :
 *  - la CONSTELLATION est l'échantillon synaptique du cerveau chargé
 *    (/api/neural/brain) — les nœuds, arêtes, énergies et pulsations
 *    représentent les VRAIES synapses apprises ;
 *  - la conversation parle au moteur (/api/neural/cycle) ;
 *  - l'entraînement apprend réellement le corpus (/api/neural/train) ;
 *  - la génération média produit de VRAIS fichiers (SVG/WAV/SVG animé)
 *    calculés depuis l'état du cerveau (/api/neural/media) ;
 *  - l'hippocampe compte les tours MÉMORISÉS du runtime.
 */

/* ------------------------------------------------------------------ */
/* Types (contrats des routes /api/neural/*)                          */
/* ------------------------------------------------------------------ */

interface EtatCerveau {
  modele: string;
  creeLe: string;
  stats: {
    nbNeurones: number;
    nbSynapses: number;
    poidsMoyen: number;
    poidsMin: number;
    poidsMax: number;
    histogramme: number[];
  };
  constellation: Array<[number, number, number]>;
  energies: Array<[number, number]>;
  sante: {
    cyclesTotaux: number;
    energieMoyenne: number;
    indiceHomeostasie: number;
    modeActuel: string;
  };
  /** MÉTABOLISME CÉRÉBRAL : travail réel cumulé (architecture événementielle). */
  metabolisme?: {
    pas: number;
    neuronesEvalues: number;
    neuronesReposes: number;
    spikes: number;
    transmissions: number;
    transmissionsEvitees: number;
  };
  pools: Record<string, number[]>;
  hippocampe: { toursMemorises: number; fenetreMax: number };
  langage: { paires: number; pairesPersonnalisees: number; vocabulaire: number; themes: number };
  evolution: {
    echangesObserves: number;
    echangesConsolides: number;
    cyclesConsolidation: number;
    echangesEcarts: number;
    derniereConsolidation: string | null;
  };
  dernierJobEntrainement: JobEntrainement | null;
}

interface EtatNeural {
  moteurNeuralActif: boolean;
  modele: string;
  creeLe: string;
  cerveau: { nbNeurones: number; nbSynapses: number; poids: { moyen: number; min: number; max: number } };
  sante: { cyclesTotaux: number; energieMoyenne: number; indiceHomeostasie: number; modeActuel: string };
  horlogeVirtuelle: number;
  poolsSortie: Record<string, number[]>;
  outils: Array<{ nom: string; description: string; utilisations: number; succesHistorique: number }>;
  competences: Array<{ nom: string; version: string; description: string }>;
  historiqueEntrainement: Array<{ epochs: number; samples: number; accuracyTrain: number; accuracyTest: number; startedAt: string }>;
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
  nbEchantillonsDomaines?: number;
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
  rapportDomaines?: {
    epochs: number;
    samples: number;
    accuracyTrain: number;
    accuracyTest: number;
    history: Array<{ epoch: number; accuracy: number }>;
    parDomaine: Record<string, number>;
    dureeMs: number;
  };
}

interface DomaineDataset {
  id: string;
  nomFr: string;
  nomEn: string;
  lignesDisponibles: number;
  lignesComplet: number | null;
  echantillonsCommis: boolean;
  taches: string[];
}

interface ReponseDomaines {
  datasets: DomaineDataset[];
  coucheDomaines: {
    synapses: number;
    neurones: string;
    tailleReseau: number;
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
    metabolisme?: {
      neuronesEvalues: number;
      neuronesReposes: number;
      spikes: number;
      transmissions: number;
      synapsesDenses: number;
      transmissionsEvitees: number;
      tauxActivite: number;
    };
  };
}

interface MediaGenere {
  url: string;
  storage: "r3" | "inline" | "r2";
  mime: "image/png" | "image/svg+xml" | "audio/wav";
  meta: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

const PCT = (v: number) => `${Math.round(v * 100)} %`;

function useTelechargement<T>(url: string, intervalMs: number | null) {
  const [donnees, setDonnees] = useState<T | null>(null);
  const [erreurAuth, setErreurAuth] = useState(false);

  const rafraichir = useCallback(async () => {
    if (!url) return;
    try {
      const reponse = await fetch(url, { cache: "no-store" });
      if (reponse.status === 401 || reponse.status === 403) {
        setErreurAuth(true);
        return;
      }
      if (reponse.ok) setDonnees(await reponse.json());
    } catch {
      /* silencieux : la prochaine interrogation retentera */
    }
  }, [url]);

  useEffect(() => {
    if (!url) return;
    void rafraichir();
    if (intervalMs === null) return;
    const interval = setInterval(() => void rafraichir(), intervalMs);
    return () => clearInterval(interval);
  }, [rafraichir, intervalMs, url]);

  return { donnees, erreurAuth, rafraichir };
}

/* ------------------------------------------------------------------ */
/* Constellation — la carte RÉELLE du cerveau                          */
/* ------------------------------------------------------------------ */

/**
 * Visualisation de l'échantillon synaptique réel : chaque nœud est un
 * neurone (position par spirale d'or dérivée de son ID), chaque arête
 * une synapse APPRISE (opacité ∝ poids). Les pools de sortie connus
 * (média, outils, intention) sont sur-lignés en cyan.
 */
function ConstellationNeuronale({ cerveau }: { cerveau: EtatCerveau | null }) {
  const noeuds = useMemo(() => {
    if (!cerveau || cerveau.constellation.length === 0) return [];
    const parNid = new Map<number, { id: number; poidsMax: number }>();
    for (const [src, , poids] of cerveau.constellation) {
      const existant = parNid.get(src);
      if (!existant || poids > existant.poidsMax) parNid.set(src, { id: src, poidsMax: poids });
    }
    const liste = Array.from(parNid.values()).slice(0, 64);
    const angleOr = Math.PI * (3 - Math.sqrt(5));
    return liste.map((n, i) => {
      const t = (i + (n.id % 7) / 7) / Math.max(1, liste.length);
      const angle = t * Math.PI * 2 * 1.2 + angleOr;
      const r = 42 * Math.sqrt(t) * (0.72 + ((n.id % 11) / 11) * 0.26);
      return {
        id: n.id,
        cx: 50 + r * Math.cos(angle),
        cy: 50 + r * Math.sin(angle),
        rayon: 0.55 + n.poidsMax * 2.1,
        poids: n.poidsMax,
      };
    });
  }, [cerveau]);

  const aretes = useMemo(() => {
    if (!cerveau) return [];
    const visibles: Array<{ a: (typeof noeuds)[number]; b: (typeof noeuds)[number]; poids: number }> = [];
    for (const [source, cible, poids] of cerveau.constellation) {
      if (visibles.length >= 96) break;
      const a = noeuds.find((n) => n.id === source);
      const b = noeuds.find((n) => n.id === cible);
      if (a && b && a !== b) visibles.push({ a, b, poids });
    }
    return visibles;
  }, [cerveau, noeuds]);

  if (!cerveau) {
    return (
      <div className="g3v6-brainfield flex h-full min-h-[280px] items-center justify-center rounded-[22px]" aria-busy="true" aria-label="Connexion au cerveau">
        <p className="text-xs tracking-[.22em] text-[var(--g3-faint)] uppercase">Synchronisation du cerveau…</p>
      </div>
    );
  }

  return (
    <div className="g3v6-brainfield g3v6-halo relative h-full min-h-[280px] overflow-hidden rounded-[22px]" aria-label="Constellation synaptique réelle du cerveau Gen3">
      <svg viewBox="0 0 100 100" className="h-full w-full" preserveAspectRatio="xMidYMid slice" role="img">
        <defs>
          <radialGradient id="v6-foyer" cx="50%" cy="46%" r="60%">
            <stop offset="0%" stopColor="rgba(124,92,255,0.30)" />
            <stop offset="100%" stopColor="transparent" />
          </radialGradient>
        </defs>
        <rect width="100" height="100" fill="url(#v6-foyer)" />
        {aretes.map(({ a, b, poids }, i) => (
          <line
            key={`ar-${i}`}
            x1={a.cx} y1={a.cy} x2={b.cx} y2={b.cy}
            stroke={poids > 0.55 ? "var(--g3v6-spike)" : "var(--g3v6-neural)"}
            strokeWidth={0.12 + poids * 0.42}
            strokeOpacity={0.14 + poids * 0.5}
            className="g3v6-synapse"
            style={{ animationDelay: `${(i % 7) * 0.32}s` }}
          />
        ))}
        {noeuds.map((n, i) => (
          <circle
            key={`nd-${n.id}`}
            cx={n.cx} cy={n.cy} r={n.rayon}
            fill={n.poids > 0.6 ? "var(--g3v6-spike)" : "var(--g3v6-neural-strong)"}
            fillOpacity={0.5 + n.poids * 0.45}
            style={{ animation: `var(--g3v6-pulse)`, animationDelay: `${(i % 9) * 0.28}s` }}
          />
        ))}
      </svg>
      <div className="pointer-events-none absolute bottom-3 left-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] tracking-[.14em] text-[var(--g3-faint)] uppercase">
        <span><span className="mr-1 inline-block size-1.5 rounded-full bg-[var(--g3v6-neural-strong)]" />neurone ({cerveau.stats.nbNeurones})</span>
        <span><span className="mr-1 inline-block size-1.5 rounded-full bg-[var(--g3v6-spike)]" />synapse forte</span>
        <span className="g3v6-metric">{cerveau.stats.nbSynapses.toLocaleString("fr-FR")} synapses · poids moyen {cerveau.stats.poidsMoyen.toFixed(3)}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Métrique V6                                                         */
/* ------------------------------------------------------------------ */

function Metrique({ label, valeur, sous = null }: { label: string; valeur: string; sous?: string | null }) {
  return (
    <div className="g3v6-card px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">{label}</p>
      <p className="g3v6-metric mt-1.5 text-xl text-[var(--g3-text)]">{valeur}</p>
      {sous ? <p className="mt-0.5 text-[11px] text-[var(--g3-muted)]">{sous}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Console principale                                                  */
/* ------------------------------------------------------------------ */

type OngletV6 = "cerveau" | "conversation" | "atelier" | "entrainement";

const ONGLETS: Array<{ id: OngletV6; label: string }> = [
  { id: "cerveau", label: "Cerveau" },
  { id: "conversation", label: "Conversation" },
  { id: "atelier", label: "Atelier média" },
  { id: "entrainement", label: "Entraînement" },
];

export function NeuralConsole() {
  const [onglet, setOnglet] = useState<OngletV6>("cerveau");

  // Rôle plateforme : les actions à privilège (lancement d'un job
  // d'entraînement global, reset du cerveau) sont réservées aux opérateurs
  // (requireAdmin côté routes) — masquées ici pour un compte standard, qui
  // OBSERVE le cerveau, conversse et génère des médias.
  const [estOperateur, setEstOperateur] = useState(false);
  useEffect(() => {
    let annule = false;
    void (async () => {
      try {
        const reponse = await fetch("/api/auth/access", { cache: "no-store" });
        if (!reponse.ok) return;
        const donnees = (await reponse.json()) as { role?: string };
        if (!annule && donnees?.role === "admin") setEstOperateur(true);
      } catch {
        /* défaut : compte standard */
      }
    })();
    return () => {
      annule = true;
    };
  }, []);

  const { donnees: cerveau, rafraichir: rafraichirCerveau } = useTelechargement<EtatCerveau>("/api/neural/brain", 6000);
  const { donnees: etat } = useTelechargement<EtatNeural>("/api/neural/state", 8000);

  // Conversation
  const [message, setMessage] = useState("");
  const [envoiEnCours, setEnvoiEnCours] = useState(false);
  const [conversation, setConversation] = useState<MessageConversation[]>([]);
  const finFil = useRef<HTMLDivElement>(null);

  // Atelier média
  const [typeMedia, setTypeMedia] = useState<"visuel" | "audio" | "video">("visuel");
  const [promptMedia, setPromptMedia] = useState("");
  const [mediaEnCours, setMediaEnCours] = useState(false);
  const [media, setMedia] = useState<MediaGenere | null>(null);
  const [erreurMedia, setErreurMedia] = useState("");

  // Entraînement
  const [lancement, setLancement] = useState<string | null>(null);
  // Couche des 18 domaines (datasets + état appris)
  const { donnees: domaines, rafraichir: rafraichirDomaines } = useTelechargement<ReponseDomaines>(
    onglet === "entrainement" ? "/api/neural/domaines" : "",
    15000,
  );

  const jobEnCours = etat?.dernierJobEntrainement?.status === "en_cours";
  useEffect(() => {
    if (!jobEnCours) return;
    const interval = setInterval(() => void rafraichirCerveau(), 1500);
    return () => clearInterval(interval);
  }, [jobEnCours, rafraichirCerveau]);

  useEffect(() => {
    finFil.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation.length]);

  /* ---------------- Conversation ---------------- */

  const envoyer = useCallback(async () => {
    const texte = message.trim();
    if (!texte || envoiEnCours) return;
    setEnvoiEnCours(true);
    setConversation((f) => [...f, { role: "utilisateur", texte }]);
    setMessage("");
    try {
      const reponse = await fetch("/api/neural/cycle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: texte }),
      });
      const data = await reponse.json();
      setConversation((f) => [
        ...f,
        {
          role: "reseaux",
          texte: typeof data.reponse?.texte === "string" ? data.reponse.texte : data.error ?? "Aucune réponse.",
          meta: {
            intention: data.reponse?.intention,
            scoreResonance: data.reponse?.scoreResonance,
            motsCles: data.reponse?.motsCles,
            latencyMs: data.reponse?.latencyMs,
            metabolisme: data.reponse?.metabolisme ?? undefined,
          },
        },
      ]);
      void rafraichirCerveau();
    } catch (error) {
      setConversation((f) => [
        ...f,
        { role: "reseaux", texte: `Le cerveau est momentanément injoignable (${error instanceof Error ? error.message : "erreur"}).` },
      ]);
    } finally {
      setEnvoiEnCours(false);
    }
  }, [message, envoiEnCours, rafraichirCerveau]);

  /* ---------------- Atelier média ---------------- */

  const genererMedia = useCallback(async () => {
    const prompt = promptMedia.trim();
    if (!prompt || mediaEnCours) return;
    setMediaEnCours(true);
    setErreurMedia("");
    setMedia(null);
    try {
      const reponse = await fetch("/api/neural/media", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: typeMedia,
          prompt,
          ...(typeMedia === "audio" ? { dureeSecondes: 4 } : {}),
          ...(typeMedia === "video" ? { dureeSecondes: 6 } : {}),
        }),
      });
      const data = await reponse.json();
      if (!reponse.ok) throw new Error(data.error ?? "Génération impossible.");
      setMedia(data.media as MediaGenere);
    } catch (error) {
      setErreurMedia(error instanceof Error ? error.message : "Génération impossible.");
    } finally {
      setMediaEnCours(false);
    }
  }, [promptMedia, typeMedia, mediaEnCours]);

  /* ---------------- Entraînement ---------------- */

  const lancerEntrainement = useCallback(async (source: "corpus" | "domaines" | "complet" = "corpus") => {
    if (lancement) return;
    setLancement(source === "corpus" ? "démarrage…" : `démarrage (${source})…`);
    try {
      const reponse = await fetch("/api/neural/train", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(source === "corpus" ? {} : { source }),
      });
      const data = await reponse.json();
      setLancement(reponse.ok ? (data.job?.status === "en_cours" ? "en cours — la courbe se met à jour en direct." : "terminé.") : `échec : ${String(data.error ?? "")}`);
      void rafraichirCerveau();
      void rafraichirDomaines();
    } catch (error) {
      setLancement(`échec : ${error instanceof Error ? error.message : "erreur"}`);
    }
  }, [lancement, rafraichirCerveau, rafraichirDomaines]);

  const reinitialiser = useCallback(async () => {
    if (lancement) return;
    setLancement("réinitialisation…");
    try {
      const reponse = await fetch("/api/neural/reset", { method: "POST" });
      setLancement(reponse.ok ? "cerveau réinitialisé (nouveau réseau seedé)." : "échec de la réinitialisation.");
      void rafraichirCerveau();
    } catch {
      setLancement("échec de la réinitialisation.");
    }
  }, [lancement, rafraichirCerveau]);

  /* ---------------- Rendu ---------------- */

  const sante = etat?.sante ?? cerveau?.sante;
  const historique = etat?.historiqueEntrainement ?? [];
  const job = etat?.dernierJobEntrainement ?? null;

  return (
    <div className="space-y-6">
      {/* En-tête V6 : identité neural-first */}
      <header className="g3v6-card g3v6-sweep relative overflow-hidden px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3v6-spike-text)]">Aurora OS · V6 · Moteur interne</p>
            <h1 className="mt-1 text-2xl font-bold text-[var(--g3-text)]">Système Neuronal Gen3</h1>
            <p className="mt-1 max-w-xl text-sm text-[var(--g3-muted)]">
              Réseau de neurones à spikes, plasticité hebbienne et corps sémantique — 100 % local, aucune IA externe.
            </p>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="g3v6-resonance-bar h-2.5 w-2.5" aria-hidden />
            <p className="g3v6-metric text-xs text-[var(--g3-text-secondary)]">
              {sante ? `${sante.cyclesTotaux.toLocaleString("fr-FR")} cycles` : "—"}
            </p>
          </div>
        </div>
        <nav className="mt-4 flex flex-wrap gap-1.5" aria-label="Sections de la console neuronale">
          {ONGLETS.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => setOnglet(o.id)}
              aria-current={onglet === o.id ? "page" : undefined}
              className={`rounded-full px-4 py-1.5 text-xs font-semibold transition ${onglet === o.id
                ? "bg-[var(--g3-primary)] text-white shadow-[var(--gen3ia-shadow-glow)]"
                : "text-[var(--g3-muted)] hover:bg-[var(--g3-hover)] hover:text-[var(--g3-text)]"}`}
            >
              {o.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Onglet CERVEAU : constellation + métriques + hippocampe */}
      {onglet === "cerveau" && (
        <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <ConstellationNeuronale cerveau={cerveau} />
          <div className="space-y-3">
            <Metrique label="Neurones" valeur={cerveau ? String(cerveau.stats.nbNeurones) : "—"} sous={cerveau ? `${cerveau.stats.nbSynapses.toLocaleString("fr-FR")} synapses câblées` : undefined} />
            <Metrique label="Poids synaptique moyen" valeur={cerveau ? cerveau.stats.poidsMoyen.toFixed(3) : "—"} sous={cerveau ? `min ${cerveau.stats.poidsMin.toFixed(2)} · max ${cerveau.stats.poidsMax.toFixed(2)}` : undefined} />
            <Metrique label="Homéostasie" valeur={sante ? PCT(sante.indiceHomeostasie) : "—"} sous={sante ? `énergie moyenne ${sante.energieMoyenne.toFixed(3)} · ${sante.modeActuel}` : undefined} />
            <Metrique
              label="Métabolisme cérébral"
              valeur={cerveau?.metabolisme ? `${PCT(cerveau.metabolisme.transmissionsEvitees / Math.max(1, cerveau.metabolisme.transmissions + cerveau.metabolisme.transmissionsEvitees))} d'économie` : "—"}
              sous={cerveau?.metabolisme ? `propagation événementielle : ${cerveau.metabolisme.transmissions.toLocaleString("fr-FR")} transmissions réelles, ${cerveau.metabolisme.transmissionsEvitees.toLocaleString("fr-FR")} évitées · ${cerveau.metabolisme.neuronesReposes.toLocaleString("fr-FR")} neurones au repos sur ${cerveau.metabolisme.pas.toLocaleString("fr-FR")} pas` : undefined}
            />
            <Metrique
              label="Hippocampe (mémoire court terme)"
              valeur={cerveau ? `${cerveau.hippocampe.toursMemorises}/${cerveau.hippocampe.fenetreMax}` : "—"}
              sous="Fenêtre de discussion du superviseur central"
            />
            <Metrique
              label="Évolution continue"
              valeur={cerveau ? `${cerveau.evolution.echangesConsolides} consolidés` : "—"}
              sous={cerveau ? `${cerveau.evolution.cyclesConsolidation} cycle(s) · ${cerveau.evolution.echangesObserves} échange(s) observé(s) · ${cerveau.langage.pairesPersonnalisees} paires personnelles` : undefined}
            />
            <div className="g3v6-card px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">Pools résonants</p>
              <ul className="mt-2 space-y-1.5">
                {Object.entries(cerveau?.pools ?? {}).slice(0, 6).map(([canal, neurones]) => (
                  <li key={canal} className="flex items-center justify-between text-[11px]">
                    <span className="text-[var(--g3-text-secondary)]">{canal}</span>
                    <span className="g3v6-metric text-[var(--g3v6-spike-text)]">#{neurones.join(" #")}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Onglet CONVERSATION : parler au cerveau */}
      {onglet === "conversation" && (
        <div className="g3v6-card flex h-[520px] flex-col">
          <div className="border-b border-[var(--g3v6-glass-border)] px-5 py-3">
            <p className="text-sm font-semibold text-[var(--g3-text)]">Parlez au cerveau</p>
            <p className="text-[11px] text-[var(--g3-muted)]">Chaque message stimule la zone lexicale réelle — la réponse est décodée des résonances apprises.</p>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {conversation.length === 0 ? (
              <p className="pt-16 text-center text-sm text-[var(--g3-faint)]">Le réseau écoute. Écrivez le premier message…</p>
            ) : (
              conversation.map((m, i) => (
                <div key={i} className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${m.role === "utilisateur"
                  ? "ml-auto bg-[var(--g3-primary)] text-white"
                  : "bg-[var(--g3-elevated)] text-[var(--g3-text)]"}`}>
                  <p className="whitespace-pre-wrap">{m.texte}</p>
                  {m.meta?.intention ? (
                    <p className="g3v6-metric mt-2 text-[10px] text-[var(--g3v6-spike-text)]">
                      intention {m.meta.intention} · résonance {m.meta.scoreResonance !== undefined ? PCT(m.meta.scoreResonance) : "—"}
                      {m.meta.latencyMs !== undefined ? ` · ${m.meta.latencyMs} ms` : ""}
                      {m.meta.metabolisme
                        ? ` · métabolisme : ${m.meta.metabolisme.spikes.toLocaleString("fr-FR")} spikes, ${m.meta.metabolisme.transmissions.toLocaleString("fr-FR")}/${m.meta.metabolisme.synapsesDenses.toLocaleString("fr-FR")} transmissions (événementiel)`
                        : ""}
                    </p>
                  ) : null}
                </div>
              ))
            )}
            {envoiEnCours ? <p className="text-xs text-[var(--g3-faint)]">Propagation synaptique en cours…</p> : null}
            <div ref={finFil} />
          </div>
          <form
            className="flex gap-2 border-t border-[var(--g3v6-glass-border)] p-4"
            onSubmit={(e) => { e.preventDefault(); void envoyer(); }}
          >
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Stimulez le réseau…"
              maxLength={4000}
              className="flex-1 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-bg)] px-4 py-2.5 text-sm text-[var(--g3-text)] outline-none placeholder:text-[var(--g3-faint)] focus:border-[var(--g3-primary-border)]"
              aria-label="Message au système neuronal"
            />
            <button
              type="submit"
              disabled={envoiEnCours || message.trim().length === 0}
              className="rounded-xl bg-[var(--g3-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--g3-primary-strong)] disabled:opacity-50"
            >
              {envoiEnCours ? "…" : "Stimuler"}
            </button>
          </form>
        </div>
      )}

      {/* Onglet ATELIER MÉDIA : effecteurs locaux */}
      {onglet === "atelier" && (
        <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          <div className="g3v6-card space-y-4 p-5">
            <div>
              <p className="text-sm font-semibold text-[var(--g3-text)]">Effecteurs du corps sémantique</p>
              <p className="mt-1 text-[11px] leading-5 text-[var(--g3-muted)]">
                Décrivez une scène (sujet, cadre, moment, météo) : les moteurs v2 la dessinent, la sonorisent et l&apos;animent localement — déterministe, sans GPU ni IA externe. Hors vocabulaire connu, repli sur les compositions abstraites v1.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-1.5" role="tablist" aria-label="Type de média">
              {( ["visuel", "audio", "video"] as const ).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={typeMedia === t}
                  onClick={() => { setTypeMedia(t); setMedia(null); setErreurMedia(""); }}
                  className={`rounded-xl px-3 py-2 text-xs font-semibold capitalize transition ${typeMedia === t
                    ? "bg-[var(--g3v6-spike-soft)] text-[var(--g3v6-spike-text)] ring-1 ring-[var(--g3v6-spike)]"
                    : "text-[var(--g3-muted)] hover:bg-[var(--g3-hover)]"}`}
                >
                  {t === "video" ? "vidéo" : t}
                </button>
              ))}
            </div>
            <textarea
              value={promptMedia}
              onChange={(e) => setPromptMedia(e.target.value)}
              placeholder={typeMedia === "visuel" ? "Un chat noir au bord de la mer au coucher du soleil…" : typeMedia === "audio" ? "Pluie sur les vitres, ambiance calme, pas dans la rue…" : "Un phare dans la tempête. Puis la ville s'endort sous la neige…"}
              rows={3}
              maxLength={2000}
              className="w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-bg)] px-4 py-3 text-sm text-[var(--g3-text)] outline-none placeholder:text-[var(--g3-faint)] focus:border-[var(--g3-primary-border)]"
              aria-label="Prompt de génération"
            />
            <button
              type="button"
              onClick={() => void genererMedia()}
              disabled={mediaEnCours || promptMedia.trim().length === 0}
              className="w-full rounded-xl bg-[var(--g3-gradient)] px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
            >
              {mediaEnCours ? "Le cerveau compose…" : "Générer (moteur local)"}
            </button>
            {erreurMedia ? <p className="text-xs text-[var(--g3-danger-strong)]">{erreurMedia}</p> : null}
          </div>
          <div className="g3v6-card flex items-center justify-center overflow-hidden p-4">
            {media ? (
              media.mime === "audio/wav" ? (
                <div className="w-full space-y-3 text-center">
                  <p className="text-xs text-[var(--g3-muted)]">Signal WAV synthétisé — {String(media.meta.octets ?? "?")} octets réels.</p>
                  <audio controls src={media.url} className="mx-auto w-full" />
                </div>
              ) : (
                <div className="w-full space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={media.url} alt={`Création neuronale : ${String(media.meta.prompt ?? "")}`} className="mx-auto max-h-[420px] w-auto rounded-xl" />
                  <p className="text-center text-[11px] text-[var(--g3-muted)]">
                    {media.mime === "image/svg+xml" ? "Animation vectorielle SMIL — votre navigateur l'anime." : "Composition rastérisée en PNG."}
                  </p>
                </div>
              )
            ) : (
              <p className="max-w-xs text-center text-sm text-[var(--g3-faint)]">
                L&apos;œuvre générée apparaîtra ici — directement issue des synapses apprises de votre cerveau.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Onglet ENTRAÎNEMENT */}
      {onglet === "entrainement" && (
        <div className="space-y-6">
          {/* LES 18 DOMAINES — couche d'expertise v3 (neurones 100-135) */}
          <div className="g3v6-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--g3-text)]">
                  Les 18 domaines de gen3 — datasets bilingues FR/EN
                </p>
                <p className="mt-1 text-[11px] text-[var(--g3-muted)]">
                  18 datasets JSONL de 100 000 lignes chacun (générateur reproductible), 120 échantillons/domaine commis.
                  La couche des domaines (neurones {domaines?.coucheDomaines.neurones ?? "100-135"}, réseau {domaines?.coucheDomaines.tailleReseau ?? 140}) apprend à RECONNAÎTRE le domaine de chaque prompt.
                </p>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => void lancerEntrainement("domaines")} disabled={Boolean(lancement) || jobEnCours} className="rounded-xl bg-[var(--g3-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--g3-primary-strong)] disabled:opacity-50">
                  Entraîner sur mes 18 domaines
                </button>
                <button type="button" onClick={() => void lancerEntrainement("complet")} disabled={Boolean(lancement) || jobEnCours} className="rounded-xl border border-[var(--g3-border)] px-4 py-2.5 text-sm text-[var(--g3-muted)] transition hover:bg-[var(--g3-hover)] disabled:opacity-50">
                  Corpus + domaines
                </button>
              </div>
            </div>

            {domaines ? (
              <div className="mt-4 space-y-3">
                <div className="flex flex-wrap gap-2 text-[11px] text-[var(--g3-muted)]">
                  <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">
                    Synapses domaine apprises : <strong className="text-[var(--g3v6-spike-text)]">{domaines.coucheDomaines.synapses}</strong>
                  </span>
                  {domaines.datasets.some((d) => d.lignesComplet !== null) ? (
                    <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">Datasets complets détectés sur disque</span>
                  ) : (
                    <span className="rounded-full border border-[var(--g3-border)] px-3 py-1">Entraînement sur les échantillons commis (datasets complets générables localement)</span>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {domaines.datasets.map((d) => (
                    <div key={d.id} className="rounded-xl border border-[var(--g3-border)] p-3">
                      <p className="text-xs font-semibold text-[var(--g3-text)]">
                        {d.nomFr}
                        <span className="ml-1 text-[10px] font-normal text-[var(--g3-faint)]">/ {d.nomEn}</span>
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--g3-muted)]">
                        {d.lignesComplet !== null
                          ? `${d.lignesComplet.toLocaleString("fr-FR")} lignes complètes disponibles`
                          : d.echantillonsCommis
                            ? `${d.lignesDisponibles} échantillons commis · dataset complet générable`
                            : "dataset non trouvé sur disque"}
                      </p>
                      <p className="mt-1 text-[10px] text-[var(--g3-faint)]">{d.taches.join(" · ")}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="mt-3 text-xs text-[var(--g3-faint)]">Chargement de l&apos;inventaire des domaines…</p>
            )}

            {job?.rapportDomaines ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Metrique label="Domaines · accuracy train" valeur={PCT(job.rapportDomaines.accuracyTrain)} sous={`${job.rapportDomaines.epochs} epochs · ${job.rapportDomaines.samples} échantillons`} />
                <Metrique label="Domaines · accuracy test" valeur={PCT(job.rapportDomaines.accuracyTest)} sous="Reconnaissance jamais vue" />
                <Metrique label="Domaines · durée" valeur={`${(job.rapportDomaines.dureeMs / 1000).toFixed(1)} s`} sous={`${Object.keys(job.rapportDomaines.parDomaine ?? {}).length} domaines entraînés`} />
              </div>
            ) : null}
          </div>

          <div className="g3v6-card p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--g3-text)]">Apprentissage hebbien sur le corpus du projet</p>
                <p className="mt-1 text-[11px] text-[var(--g3-muted)]">
                  Le réseau APPREND réellement : plasticité guidée par label, accuracy train/test mesurée, cerveau persisté.
                </p>
              </div>
              <div className="flex gap-2">
                {estOperateur ? (
                  <>
                    <button type="button" onClick={() => void lancerEntrainement()} disabled={Boolean(lancement) || jobEnCours} className="rounded-xl bg-[var(--g3-primary)] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[var(--g3-primary-strong)] disabled:opacity-50">
                      {jobEnCours ? `Epoch ${job?.epochCourante ?? 0}/${job?.epochs ?? "?"}…` : "Lancer un entraînement"}
                    </button>
                    <button type="button" onClick={() => void reinitialiser()} disabled={Boolean(lancement) || jobEnCours} className="rounded-xl border border-[var(--g3-border)] px-4 py-2.5 text-sm text-[var(--g3-muted)] transition hover:bg-[var(--g3-hover)] disabled:opacity-50">
                      Réinitialiser
                    </button>
                  </>
                ) : (
                  <p className="max-w-xs rounded-xl border border-[var(--g3-border)] px-4 py-2.5 text-[11px] text-[var(--g3-muted)]">
                    Le lancement d&apos;un entraînement global et la réinitialisation sont réservés aux opérateurs — vous suivez ici l&apos;apprentissage du cerveau en temps réel.
                  </p>
                )}
              </div>
            </div>
            {lancement ? <p className="mt-3 text-xs text-[var(--g3v6-spike-text)]">{lancement}</p> : null}
            {job?.rapport ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Metrique label="Accuracy train" valeur={PCT(job.rapport.accuracyTrain)} sous={`${job.rapport.epochs} epochs · ${job.rapport.samples} échantillons`} />
                <Metrique label="Accuracy test" valeur={PCT(job.rapport.accuracyTest)} sous="Généralisation mesurée" />
                <Metrique label="Durée réelle" valeur={`${(job.rapport.dureeMs / 1000).toFixed(1)} s`} sous="Apprentissage exécuté" />
              </div>
            ) : null}
          </div>

          {/* Courbe d'apprentissage (données réelles du dernier rapport) */}
          {job?.rapport && job.rapport.history.length > 1 ? (
            <div className="g3v6-card p-5">
              <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">Courbe d&apos;apprentissage (dernier job)</p>
              <svg viewBox="0 0 100 40" className="mt-3 h-32 w-full" role="img" aria-label="Précision par epoch">
                <polyline
                  fill="none"
                  stroke="var(--g3v6-spike)"
                  strokeWidth="0.8"
                  strokeDasharray="0.4 0.4"
                  points={job.rapport.history
                    .map((p, i) => `${(i / Math.max(1, job.rapport!.history.length - 1)) * 96 + 2},${38 - p.accuracy * 34}`)
                    .join(" ")}
                />
              </svg>
            </div>
          ) : null}

          {/* Historique persisté */}
          <div className="g3v6-card p-5">
            <p className="text-[10px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">Historique d&apos;entraînement (cerveau persisté)</p>
            {historique.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--g3-faint)]">Aucun entraînement encore enregistré — lancez le premier.</p>
            ) : (
              <table className="mt-3 w-full text-left text-xs">
                <thead>
                  <tr className="text-[var(--g3-faint)]">
                    <th className="pb-2 pr-4 font-semibold">Date</th>
                    <th className="pb-2 pr-4 font-semibold">Epochs</th>
                    <th className="pb-2 pr-4 font-semibold">Échantillons</th>
                    <th className="pb-2 pr-4 font-semibold">Train</th>
                    <th className="pb-2 font-semibold">Test</th>
                  </tr>
                </thead>
                <tbody className="g3v6-metric text-[var(--g3-text-secondary)]">
                  {historique.slice().reverse().slice(0, 8).map((h, i) => (
                    <tr key={i} className="border-t border-[var(--g3-border)]">
                      <td className="py-2 pr-4">{new Date(h.startedAt).toLocaleString("fr-FR")}</td>
                      <td className="py-2 pr-4">{h.epochs}</td>
                      <td className="py-2 pr-4">{h.samples}</td>
                      <td className="py-2 pr-4 text-[var(--g3v6-spike-text)]">{PCT(h.accuracyTrain)}</td>
                      <td className="py-2 text-[var(--g3v6-neural-strong-text)]">{PCT(h.accuracyTest)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
