"use client";

import { useCallback, useState } from "react";
import Link from "next/link";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import type { Permission } from "@/lib/live/types";
import { PERMISSION_LABELS } from "@/lib/live/types";

import { LiveExecuteur } from "@/components/live/live-executeur";
import type { CameraFacing, SourceCapture } from "@/components/live/live-executeur";

/**
 * AGENT LIVE — CARTE D'ACTIVATION DU CHAT IA (it.52, demande
 * propriétaire : « le live doit être activé depuis le Chat IA et
 * fonctionner en interne avec gen3 »).
 *
 * it.53 (« un seul exécuteur, deux surfaces ») : ce panneau ne garde que
 * son rôle propre — la CRÉATION de la session (POST /api/live/sessions,
 * mode navigateur, permissions, consentement explicite) et le choix de
 * la source de capture. Dès la session créée, l'EXÉCUTION est déléguée
 * à l'exécuteur navigateur UNIQUE components/live/live-executeur (le
 * même que l'espace /live) : armement, boucle d'images 3 s, décisions du
 * moteur de vision INTERNE lib/live/vision-decider, HITL inline, arrêt.
 * Avant it.53, la boucle vivait ici en double copie avec le dashboard —
 * déjà divergentes ; la duplication est supprimée.
 *
 * Honnêteté : 401 → connexion, 429/403 → message de la porte, aucun
 * canal externe (l'ancien « Gemini Live » est retiré depuis it.52) —
 * aucune clé API, aucun service tiers : tout passe par les portes
 * maison (authFetch same-origin, cookie gen3ia_session).
 */

const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as Permission[];

export function LiveInternePanel() {
  const sessionDisponible = useSessionAvailable();

  // Formulaire d'activation (carte « Activer »).
  const [nom, setNom] = useState("Live — chat IA");
  const [objectif, setObjectif] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>(["screen.read"]);
  const [source, setSource] = useState<SourceCapture>("screen");
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>("environment");
  const [consentement, setConsentement] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);

  // Session active : le rendu passe la main à l'exécuteur unique.
  const [sessionIdActif, setSessionIdActif] = useState<string | null>(null);

  const togglePermission = (permission: Permission) => {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  };

  const activerLive = useCallback(async () => {
    if (sessionDisponible === false) {
      setActivationError("Session expirée. Reconnectez-vous.");
      return;
    }
    if (!nom.trim() || objectif.trim().length < 10 || permissions.length === 0 || !consentement || busy) return;
    setBusy(true);
    setActivationError(null);
    try {
      const response = await authFetch("/api/live/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: nom.trim(), objective: objectif.trim(), permissions, mode: "browser" }),
      });
      const data = (await response.json().catch(() => ({}))) as { session?: { id: string }; error?: string };
      if (response.status === 401) {
        throw new Error("Connectez-vous pour activer l'agent live.");
      }
      if (response.status === 429) {
        throw new Error(data.error ?? "Trop de sessions créées rapprochées. Réessayez dans quelques minutes.");
      }
      if (!response.ok || !data.session) {
        throw new Error(data.error ?? "Création de la session live impossible.");
      }
      setSessionIdActif(data.session.id);
    } catch (error) {
      setActivationError(error instanceof Error ? error.message : "Activation impossible (réseau).");
    } finally {
      setBusy(false);
    }
  }, [busy, consentement, nom, objectif, permissions, sessionDisponible]);

  if (sessionDisponible === false) {
    return (
      <div className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-5 text-center">
        <p className="text-sm text-[var(--g3-muted)]">Connectez-vous pour activer l&apos;agent live ici, dans le chat.</p>
        <Link href="/login?next=/chat" className="g3-btn g3-btn-primary mt-3 inline-flex text-xs">Se connecter</Link>
      </div>
    );
  }

  if (sessionIdActif) {
    return (
      <LiveExecuteur
        sessionId={sessionIdActif}
        sourceInitiale={source}
        cameraFacingInitiale={cameraFacing}
        onFermer={() => setSessionIdActif(null)}
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Carte d'activation — le moteur interne, aucune clé externe. */}
      <section className="rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-4">
        <h3 className="text-sm font-semibold">Activer l&apos;agent live (moteur interne gen3)</h3>
        <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
          L&apos;agent observe votre écran (PC) ou votre caméra (mobile) depuis le navigateur et vous guide
          étape par étape — décision par le moteur IA INTERNE de gen3, aucune clé API, aucun service externe.
        </p>
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Nom de la session</label>
        <input
          value={nom}
          onChange={(event) => setNom(event.target.value)}
          maxLength={120}
          className="g3-input mt-1 text-sm"
          aria-label="Nom de la session live"
        />
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Objectif de la mission</label>
        <textarea
          value={objectif}
          onChange={(event) => setObjectif(event.target.value)}
          placeholder="Ex. Vérifie l&apos;avancement de ma présentation ouverte à l&apos;écran et dis-moi ce qu&apos;il reste à faire…"
          maxLength={20000}
          className="g3-textarea mt-1 min-h-20 text-sm"
          aria-label="Objectif de la mission live"
        />
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Source de capture</div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={source === "screen"}
              onClick={() => setSource("screen")}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${source === "screen" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
            >
              Écran (PC)
            </button>
            <button
              type="button"
              aria-pressed={source === "camera"}
              onClick={() => setSource("camera")}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ${source === "camera" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
            >
              Caméra (mobile)
            </button>
            {source === "camera" ? (
              <button
                type="button"
                onClick={() => setCameraFacing((facing) => (facing === "environment" ? "user" : "environment"))}
                className="rounded-full border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)]"
              >
                Caméra {cameraFacing === "environment" ? "arrière" : "avant"} ⇄
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Permissions accordées</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {PERMISSION_KEYS.map((permission) => (
              <button
                key={permission}
                type="button"
                aria-pressed={permissions.includes(permission)}
                onClick={() => togglePermission(permission)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${permissions.includes(permission) ? "border-[var(--g3-secondary-soft)] bg-[var(--g3-secondary-soft)] text-[var(--g3-info)]" : "border-[var(--g3-border)] text-[var(--g3-muted)]"}`}
              >
                {PERMISSION_LABELS[permission]}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-[var(--g3-faint)]">
            En navigateur, l&apos;agent observe et décrit ; le contrôle souris/clavier reste réservé à un client PC.
          </p>
        </div>
        <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-[var(--g3-muted)]">
          <input
            type="checkbox"
            checked={consentement}
            onChange={(event) => setConsentement(event.target.checked)}
            className="mt-0.5"
          />
          <span>J&apos;ai compris : les images capturées alimentent le moteur de vision interne de ma session, et je peux arrêter à tout moment.</span>
        </label>
        {activationError ? (
          <p role="alert" className="mt-2 rounded-lg bg-[var(--g3-danger-soft)] px-3 py-2 text-xs text-[var(--g3-danger-strong)]">{activationError}</p>
        ) : null}
        <button
          type="button"
          onClick={() => void activerLive()}
          disabled={busy || !nom.trim() || objectif.trim().length < 10 || permissions.length === 0 || !consentement}
          className="g3-btn g3-btn-primary mt-3 w-full text-sm disabled:opacity-50"
        >
          {busy ? "Activation…" : "Activer l'agent live"}
        </button>
      </section>
    </div>
  );
}
