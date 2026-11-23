"use client";

import React from "react";

/**
 * PANNEAU « LIVE NEURAL GEN3 » — écran (PC) / caméra (mobile) + narration,
 * 100 % moteur Gen3 interne.
 *
 * REMPLACEMENT DU PANNEAU GEMINI LIVE (supprimé) : l'ancien panneau parlait
 * DIRECTEMENT au WebSocket Gemini de Google depuis le navigateur (clé API
 * externe, modèle expérimental) — un moteur neuronal EXTERNE, retiré du
 * projet sur demande explicite. La perception et la narration passent
 * désormais par les routes Live INTERNES :
 *   POST /api/live/sessions            → création de session (auth Firebase)
 *   POST /api/live/sessions/[id]/frames → perception structurelle réelle +
 *     décision par le moteur Gen3 (lib/live/vision-decider.ts) + actions
 *     auto ou soumises à approbation.
 * La voix est la synthèse LOCALE du navigateur (speechSynthesis — voix du
 * système de l'appareil, aucun service IA externe) : elle lit uniquement les
 * narrations réellement produites par le moteur Gen3.
 *
 * HONNÊTETÉ : aucune clé API à saisir, aucun service IA externe appelé depuis
 * ce panneau (le seul WebSocket externe restant dans la CSP est celui du
 * client Firebase d'authentification, exigé par le garde CSP du dépôt).
 * La boucle suit le rythme des garde-fous serveur (30 frames/min max —
 * une frame toutes les ~3 s).
 */

/** Intervalle entre deux frames (respecte la limite serveur 30/min). */
const INTERVALLE_FRAME_MS = 3_200;
/** Qualité JPEG d'envoi (identique à la mécanique historique). */
const QUALITE_JPEG = 0.6;

type EtapeLive = "inactif" | "capture" | "actif" | "erreur";

interface EvenementLive {
  horodatage: number;
  texte: string;
}

export function LiveNeuralPanel() {
  const [etape, setEtape] = React.useState<EtapeLive>("inactif");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [evenements, setEvenements] = React.useState<EvenementLive[]>([]);
  const [objectif, setObjectif] = React.useState("");
  const [voixActivee, setVoixActivee] = React.useState(true);

  const fluxRef = React.useRef<MediaStream | null>(null);
  const sessionRef = React.useRef<string | null>(null);
  const minuteurRef = React.useRef<number | null>(null);
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const narrationPrecedenteRef = React.useRef<string>("");

  const consigner = React.useCallback((texte: string) => {
    setEvenements((suivants) => [{ horodatage: Date.now(), texte }, ...suivants].slice(0, 30));
  }, []);

  const lireVoix = React.useCallback((texte: string) => {
    if (!voixActivee || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    if (!texte.trim() || texte === narrationPrecedenteRef.current) return;
    narrationPrecedenteRef.current = texte;
    const utterance = new SpeechSynthesisUtterance(texte.slice(0, 400));
    utterance.lang = "fr-FR";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [voixActivee]);

  const arreter = React.useCallback(() => {
    if (minuteurRef.current !== null) {
      window.clearInterval(minuteurRef.current);
      minuteurRef.current = null;
    }
    fluxRef.current?.getTracks().forEach((piste) => piste.stop());
    fluxRef.current = null;
    sessionRef.current = null;
    narrationPrecedenteRef.current = "";
    if (typeof window !== "undefined" && "speechSynthesis" in window) window.speechSynthesis.cancel();
    setEtape("inactif");
    consigner("Session arrêtée — ressources locales libérées.");
  }, [consigner]);

  React.useEffect(() => () => arreter(), [arreter]);

  /** Envoi d'une frame au moteur Gen3 interne (routes /api/live). */
  const envoyerFrame = React.useCallback(async () => {
    const session = sessionRef.current;
    const video = videoRef.current;
    if (!session || !video || video.videoWidth === 0) return;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const contexte = canvas.getContext("2d");
    if (!contexte) return;
    contexte.drawImage(video, 0, 0);
    const jpegBase64 = canvas.toDataURL("image/jpeg", QUALITE_JPEG).split(",")[1] ?? "";
    try {
      const reponse = await fetch(`/api/live/sessions/${session}/frames`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deviceId: "gen3-browser",
          timestamp: Date.now(),
          width: canvas.width,
          height: canvas.height,
          jpegBase64,
        }),
      });
      if (!reponse.ok) return; // 409 action en cours / 429 rate-limit : prochaine frame.
      const data = (await reponse.json()) as {
        action?: { action?: string; reason?: string; narration?: string };
        narration?: string;
        pauseReason?: string;
        observation?: { narration?: string; note?: string };
      };
      const texte =
        data.narration ??
        data.action?.narration ??
        data.observation?.narration ??
        data.observation?.note ??
        data.pauseReason ??
        (data.action?.action ? `Action : ${data.action.action}` : "");
      if (texte) {
        consigner(texte);
        lireVoix(texte);
      }
    } catch {
      /* réseau instable : la boucle retente à la prochaine frame */
    }
  }, [consigner, lireVoix]);

  const demarrer = React.useCallback(async (sourceEcran: boolean) => {
    setErreur(null);
    if (objectif.trim().length < 10) {
      setErreur("Décrivez l'objectif de la session (au moins 10 caractères).");
      return;
    }
    try {
      // Source visuelle LOCALE : écran (PC, getDisplayMedia) ou caméra (mobile,
      // getUserMedia) — aucune donnée ne sort vers un service externe.
      const flux = sourceEcran
        ? await navigator.mediaDevices.getDisplayMedia({ video: true })
        : await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      fluxRef.current = flux;
      // Session Live INTERNE : perception + narration par le moteur Gen3.
      const creation = await fetch("/api/live/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: sourceEcran ? "Live Neural — écran" : "Live Neural — caméra",
          objective: objectif.trim(),
          permissions: ["screen.read"],
          mode: "browser",
        }),
      });
      if (!creation.ok) {
        const probleme = (await creation.json().catch(() => null)) as { error?: string } | null;
        throw new Error(probleme?.error ?? "Création de session refusée.");
      }
      const donnees = (await creation.json()) as { session?: { id?: string } };
      const id = donnees.session?.id;
      if (!id) throw new Error("Session créée sans identifiant.");
      sessionRef.current = id;
      setEtape("capture");
      if (videoRef.current) {
        videoRef.current.srcObject = flux;
        await videoRef.current.play().catch(() => undefined);
      }
      minuteurRef.current = window.setInterval(() => {
        setEtape("actif");
        void envoyerFrame();
      }, INTERVALLE_FRAME_MS);
      consigner(
        sourceEcran
          ? "Partage d'écran capté — perception par le moteur Gen3 (aucun service externe)."
          : "Caméra captée — perception par le moteur Gen3 (aucun service externe).",
      );
    } catch (attrape) {
      fluxRef.current?.getTracks().forEach((piste) => piste.stop());
      fluxRef.current = null;
      setEtape("erreur");
      setErreur(attrape instanceof Error ? attrape.message : "Démarrage impossible.");
    }
  }, [consigner, envoyerFrame, objectif]);

  const ecranDisponible =
    typeof navigator !== "undefined" && "getDisplayMedia" in navigator.mediaDevices;

  return (
    <section
      className="g3-gradient-border mt-6 p-6"
      aria-labelledby="live-neural-panel-title"
    >
      <h2 id="live-neural-panel-title" className="font-[family-name:var(--font-display)] text-xl font-semibold">
        Live Neural Gen3 — écran / caméra + narration
      </h2>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">
        Perception et narration par le moteur neural Gen3 INTERNE. Aucune clé
        API, aucun service IA externe : la capture reste sur cet appareil, les
        frames sont analysées par les routes Gen3 et la voix est la synthèse
        locale du navigateur.
      </p>

      <label className="mt-4 block text-sm font-semibold text-[var(--g3-text)]" htmlFor="live-neural-objectif">
        Objectif de la session
      </label>
      <input
        id="live-neural-objectif"
        className="mt-1.5 w-full rounded-xl border border-[var(--g3-primary-border)] bg-[var(--g3-elevated)] px-4 py-2.5 text-sm text-[var(--g3-text)] outline-none focus:border-[var(--g3-primary)]"
        value={objectif}
        onChange={(evenement) => setObjectif(evenement.target.value)}
        placeholder="Ex. : surveille mon tableau de bord et décris ce que tu observes"
        maxLength={2000}
      />

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {ecranDisponible && etape === "inactif" && (
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-[var(--g3-primary-border)] bg-[var(--g3-primary-soft)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-primary)]"
            onClick={() => void demarrer(true)}
          >
            <span aria-hidden="true">🖥️</span> Démarrer (écran)
          </button>
        )}
        {etape === "inactif" && (
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-[var(--g3-primary-border)] bg-[var(--g3-primary-soft)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-[var(--g3-primary)]"
            onClick={() => void demarrer(false)}
          >
            <span aria-hidden="true">📷</span> Démarrer (caméra)
          </button>
        )}
        {etape !== "inactif" && etape !== "erreur" && (
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-full border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-300 transition hover:border-red-400"
            onClick={arreter}
          >
            Arrêter
          </button>
        )}
        <label className="flex items-center gap-2 text-sm text-[var(--g3-muted)]">
          <input
            type="checkbox"
            checked={voixActivee}
            onChange={(evenement) => setVoixActivee(evenement.target.checked)}
          />
          Voix locale (lecture des narrations)
        </label>
      </div>

      {erreur && (
        <p className="mt-3 rounded-xl bg-red-500/10 px-4 py-2.5 text-sm text-red-300" role="alert">
          {erreur}
        </p>
      )}

      <video
        ref={videoRef}
        className="mt-4 max-h-72 w-full rounded-2xl bg-black/40 object-contain"
        muted
        playsInline
        aria-label="Aperçu de la source captée (écran ou caméra)"
      />

      <p className="mt-3 text-xs text-[var(--g3-faint)]" role="status">
        État : {etape === "inactif" ? "hors session" : etape}
      </p>

      <h3 className="mt-4 text-sm font-semibold text-[var(--g3-text)]">Narration du moteur</h3>
      <ul className="mt-2 max-h-56 space-y-2 overflow-y-auto pr-1" aria-live="polite">
        {evenements.length === 0 ? (
          <li className="text-sm text-[var(--g3-muted)]">Aucune narration pour l&apos;instant.</li>
        ) : (
          evenements.map((evenement) => (
            <li key={evenement.horodatage} className="rounded-xl bg-[var(--g3-elevated)]/60 px-3 py-2 text-sm leading-6 text-[var(--g3-muted)]">
              {evenement.texte}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
