"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";

import { useToast } from "@/components/ui/toast";
import { formatXAF } from "@/lib/ui/money";
import { useLiveVoice } from "@/lib/live/voice/use-live-voice";

/**
 * Console « Live Voix » (Task 110-b) — composant client de /live/voix.
 *
 * Interface bithème (Task 108) : TOUTES les couleurs passent par les tokens
 * --g3-* (surfaces, textes, bordures, boutons g3-btn) — les seules couleurs
 * nommées sont les ambres déjà utilisés par components/pc-only-notice.tsx
 * (badge PC, alerte < 2 min, chip « Avancé », état muet).
 */

/** Durée d'une epoch affichée par l'anneau (10:00, contrat 110-0). */
const EPOCH_TOTAL_MS = 600_000;
/** Seuil d'alerte ambre : moins de 2 minutes restantes. */
const ALERTE_RESTANT_MS = 120_000;

const DIFFICULTE_LABELS: Record<string, string> = {
  simple: "Simple",
  standard: "Standard",
  avance: "Avancé",
};

const STATUT_LABELS: Record<string, string> = {
  listening: "À l'écoute — parlez naturellement",
  thinking: "L'agent réfléchit…",
  speaking: "L'agent parle — parlez pour l'interrompre",
};

/** Compte à rebours circulaire SVG de l'epoch courante (10:00 → 0:00). */
function AnneauEpoch({ remainingMs }: { remainingMs: number }) {
  const rayon = 26;
  const circonference = 2 * Math.PI * rayon;
  const fraction = Math.max(0, Math.min(1, remainingMs / EPOCH_TOTAL_MS));
  const alerte = remainingMs < ALERTE_RESTANT_MS;
  const secondesTotal = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(secondesTotal / 60);
  const secondes = secondesTotal % 60;

  return (
    <div className="relative h-16 w-16 shrink-0">
      <svg
        viewBox="0 0 64 64"
        className={`h-16 w-16 ${alerte ? "text-amber-700" : "text-[var(--g3-primary)]"}`}
        role="img"
        aria-label={`Temps restant avant renouvellement : ${minutes} minutes ${secondes} secondes`}
      >
        <circle cx="32" cy="32" r={rayon} fill="none" stroke="var(--g3-border)" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={rayon}
          fill="none"
          stroke="currentColor"
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circonference}
          strokeDashoffset={circonference * (1 - fraction)}
          transform="rotate(-90 32 32)"
        />
      </svg>
      <span
        className={`absolute inset-0 grid place-items-center text-[11px] font-semibold tabular-nums ${
          alerte ? "text-amber-700" : "text-[var(--g3-text)]"
        }`}
      >
        {minutes}:{String(secondes).padStart(2, "0")}
      </span>
    </div>
  );
}

/** Pastille micro (accueil) — SVG minimal, couleur portée par le parent. */
function IconeMicro({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18.5V22" />
      <path d="M8.5 22h7" />
    </svg>
  );
}

/** Indicateur d'onde (pulse CSS) affiché pendant l'écoute. */
function OndeEcoute() {
  return (
    <div className="flex h-6 items-end justify-center gap-1.5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-1.5 animate-pulse rounded-full bg-[var(--g3-primary)]"
          style={{ height: `${10 + ((i * 7) % 14)}px`, animationDelay: `${i * 130}ms` }}
        />
      ))}
    </div>
  );
}

export function VoiceLiveDashboard() {
  const { success } = useToast();

  const voix = useLiveVoice({
    onRenewed: (epochCourante, maxEpoques) =>
      success(`Session renouvelée (${epochCourante}/${maxEpoques})`, { id: "live-voice-renew", durationMs: 4000 }),
  });

  const filRef = useRef<HTMLDivElement | null>(null);

  // Le fil suit la dernière entrée (transcript + partiel en cours).
  useEffect(() => {
    const fil = filRef.current;
    if (fil) fil.scrollTop = fil.scrollHeight;
  }, [voix.transcript, voix.partialTranscript]);

  const enSession =
    voix.status === "listening" || voix.status === "thinking" || voix.status === "speaking";
  const enAttente = voix.status === "requesting";
  const termine = voix.status === "stopped" || voix.status === "exhausted";
  const enErreur = voix.status === "error";
  const statutLabel = STATUT_LABELS[voix.status];

  const aideMicro = voix.errorCode === "MICRO_REFUSE";
  const manqueCredits = voix.errorCode === "LIVE_INSUFFICIENT_FUNDS";

  return (
    <div className="flex flex-col gap-6">
      {/* ------------------------------------------------ En-tête --------- */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Live Voix</h1>
          <p className="mt-1 text-sm text-[var(--g3-muted)]">
            Conversez à voix haute avec votre agent — transcription et réponse vocales en direct.
          </p>
        </div>
        <Link
          href="/live"
          className="text-xs text-[var(--g3-muted)] underline-offset-4 transition-colors hover:text-[var(--g3-text)] hover:underline"
        >
          Agent Live — partage d&apos;écran →
        </Link>
      </header>

      {/* ------------------------------------------------ Bannière erreur - */}
      {voix.lastError && (
        <div
          role="alert"
          className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm"
        >
          <p className="font-medium">{voix.lastError}</p>
          {aideMicro && (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-[var(--g3-muted)]">
              <li>Cliquez sur l&apos;icône cadenassée dans la barre d&apos;adresse du navigateur.</li>
              <li>Ouvrez « Autorisations » puis passez le Microphone sur « Autoriser ».</li>
              <li>Rechargez la page et redémarrez la conversation.</li>
            </ul>
          )}
        </div>
      )}

      {/* ------------------------------------------------ Accueil --------- */}
      {(voix.status === "idle" || enAttente) && (
        <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8 text-center">
          <button
            type="button"
            onClick={() => void voix.start()}
            disabled={enAttente}
            aria-label="Démarrer la conversation vocale"
            className="g3-btn g3-btn-primary mx-auto grid h-32 w-32 place-items-center disabled:cursor-wait"
            style={{ borderRadius: 9999 }}
          >
            <IconeMicro className="h-12 w-12" />
          </button>
          <h2 className="mt-6 font-serif text-xl font-semibold">Démarrer la conversation</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--g3-muted)]">
            {enAttente
              ? "Préparation du micro et de la session…"
              : "Appuyez sur la pastille puis parlez : l'agent écoute, transcrit et répond à voix haute."}
          </p>
          <ul className="mx-auto mt-5 max-w-md space-y-2 text-left text-sm text-[var(--g3-muted)]">
            <li className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-2.5">
              Sessions de 10 minutes, renouvelées automatiquement jusqu&apos;à 6 époques (60 minutes au total).
            </li>
            <li className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-2.5">
              L&apos;agent répond phrase par phrase : parlez pendant sa réponse pour l&apos;interrompre (barge-in).
            </li>
            <li className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-2.5">
              Réservé aux ordinateurs (PC) : Chrome ou Edge — autorisez le micro quand le navigateur le demande.
            </li>
          </ul>
          <button
            type="button"
            onClick={() => void voix.start()}
            disabled={enAttente}
            className="g3-btn g3-btn-primary rounded-full"
          >
            Démarrer la conversation
          </button>
        </section>
      )}

      {/* ------------------------------------------------ Console live ---- */}
      {(enSession || termine) && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5">
            <div className="flex items-center gap-4">
              <AnneauEpoch remainingMs={voix.remainingMs} />
              <div className="text-sm">
                <p className="font-medium">{statutLabel ?? "Session vocale"}</p>
                <p className="mt-0.5 text-xs text-[var(--g3-muted)]">
                  {voix.muted ? "Micro muet — l'agent ne vous entend pas" : "Session en cours"}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-1 text-xs font-medium text-[var(--g3-muted)]">
                Epoch {voix.epoch}/{voix.maxEpochs}
              </span>
              <span className="rounded-full border border-[var(--g3-border)] bg-[var(--g3-elevated)] px-3 py-1 text-xs font-medium text-[var(--g3-muted)]">
                Coût : {formatXAF(voix.totalCostMinor)}
              </span>
              {voix.lastDifficulty && (
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-medium ${
                    voix.lastDifficulty === "avance"
                      ? "border-amber-200 bg-amber-100 text-amber-700"
                      : "border-[var(--g3-border)] bg-[var(--g3-elevated)] text-[var(--g3-muted)]"
                  }`}
                >
                  {DIFFICULTE_LABELS[voix.lastDifficulty] ?? voix.lastDifficulty}
                </span>
              )}
            </div>
          </div>

          {voix.status === "exhausted" && (
            <p className="rounded-2xl border border-[var(--g3-border)] bg-amber-100 px-4 py-3 text-sm text-amber-700">
              Durée maximale atteinte : la conversation s&apos;est terminée après 60 minutes.
            </p>
          )}
          {voix.status === "stopped" && (
            <p className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm text-[var(--g3-muted)]">
              Conversation terminée. Vos échanges restent affichés ci-dessous.
            </p>
          )}

          {/* Fil de transcript */}
          <div
            ref={filRef}
            className="flex max-h-[52vh] min-h-48 flex-col gap-3 overflow-y-auto rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5"
            aria-live="polite"
          >
            {voix.transcript.length === 0 && !voix.partialTranscript && (
              <p className="my-auto text-center text-sm text-[var(--g3-muted)]">
                Parlez : votre voix est transcrite ici en direct.
              </p>
            )}
            {voix.transcript.map((entree, index) => (
              <div
                key={index}
                className={`flex ${entree.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                    entree.role === "user"
                      ? "bg-[var(--g3-elevated)]"
                      : "border border-[var(--g3-border)] bg-[var(--g3-surface)]"
                  }`}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-muted)]">
                    {entree.role === "user" ? "Vous" : "Agent"}
                  </span>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6">{entree.text}</p>
                </div>
              </div>
            ))}
            {voix.partialTranscript && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--g3-muted)]">
                    Agent
                  </span>
                  <p className="mt-1 text-sm italic leading-6 text-[var(--g3-muted)]">
                    {voix.partialTranscript}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Onde + commandes */}
          {enSession && (
            <div className="flex flex-col items-center gap-4">
              {voix.status === "listening" && !voix.muted && <OndeEcoute />}
              <div className="flex flex-wrap items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={voix.toggleMute}
                  className={
                    voix.muted
                      ? "g3-btn rounded-full border border-amber-200 bg-amber-100 text-amber-700"
                      : "g3-btn g3-btn-ghost rounded-full"
                  }
                >
                  {voix.muted ? "Réactiver le micro" : "Muet"}
                </button>
                <button type="button" onClick={voix.stop} className="g3-btn g3-btn-danger rounded-full">
                  Arrêter
                </button>
              </div>
            </div>
          )}

          {termine && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void voix.start()}
                className="g3-btn g3-btn-primary rounded-full"
              >
                Nouvelle conversation
              </button>
            </div>
          )}
        </section>
      )}

      {/* ------------------------------------------------ Erreur fatale --- */}
      {enErreur && (
        <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8 text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-100 text-xs font-bold uppercase tracking-widest text-amber-700">
            Live
          </div>
          <h2 className="mt-5 font-serif text-xl font-semibold">La conversation vocale s&apos;est arrêtée</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--g3-muted)]">
            {manqueCredits
              ? "Votre portefeuille ne permet pas de poursuivre la conversation vocale. Rechargez vos crédits puis relancez une session."
              : "Une erreur a interrompu la session. Vous pouvez relancer une conversation."}
          </p>
          <div className="mt-6 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {manqueCredits && (
              <Link href="/billing" className="g3-btn g3-btn-primary rounded-full">
                Recharger mes crédits
              </Link>
            )}
            <button
              type="button"
              onClick={() => void voix.start()}
              className="g3-btn g3-btn-ghost rounded-full"
            >
              Réessayer
            </button>
          </div>
          {voix.transcript.length > 0 && (
            <p className="mt-5 text-xs text-[var(--g3-muted)]">
              Vos {voix.transcript.length} échange{voix.transcript.length > 1 ? "s" : ""} sont
              enregistrés dans la conversation « Session Live Voix ».
            </p>
          )}
        </section>
      )}
    </div>
  );
}
