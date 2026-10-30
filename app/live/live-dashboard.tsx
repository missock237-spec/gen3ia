"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { type User } from "firebase/auth";

import { watchAuth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { PERMISSION_LABELS } from "@/lib/live/types";
import type { Permission } from "@/lib/live/types";
import { useVisiblePolling } from "@/components/hooks/use-visible-polling";

import { LiveExecuteur } from "@/components/live/live-executeur";
import type { CameraFacing, SourceCapture } from "@/components/live/live-executeur";

// it.52 (demande propriétaire : « le live doit fonctionner en interne avec
// gen3 ») : l'ancien canal externe « Gemini Live » (clé opérateur +
// service tiers) est RETIRÉ. L'activation du mode live vit
// désormais DANS LE CHAT IA (bouton « Agent Live » → panneau interne
// components/live/live-interne-panel) ; cet espace reste la surface de
// suivi HITL (sessions, décisions, approbations, arrêt) sur le même
// pipeline interne.
//
// it.53 (« un seul exécuteur, deux surfaces ») : la COPIE locale de la
// boucle de capture (armement, partage d'écran/caméra natifs, envoi des
// frames, journal, HITL, arrêt) est SUPPRIMÉE — ~250 lignes qui avaient
// déjà divergé de celle du chat (pas de caméra, pas de carte
// d'approbation inline, statuts incohérents). L'exécution navigateur
// passe par l'exécuteur UNIQUE
// components/live/live-executeur, le même que le chat : le dashboard
// gagne la caméra mobile et la carte HITL inline, et toute évolution de
// la boucle profite aux deux surfaces en même temps.

interface LivePendingActionInfo {
  actionId: string;
  action?: { type?: string; description?: string } | string;
  createdAt?: number;
}

interface LiveInFlightInfo {
  actionId: string;
  action?: { type?: string; description?: string } | string;
}

interface LiveSessionPublic {
  id: string;
  name: string;
  objective: string;
  status: string;
  permissions: Permission[];
  createdAt: number;
  expiresAt?: number;
  deviceId?: string;
  mode?: "browser" | "desktop";
  pendingAction?: LivePendingActionInfo | null;
  inFlightAction?: LiveInFlightInfo | null;
}

interface CreatedSession {
  session: LiveSessionPublic;
  pairingToken: string;
  viewerToken: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)] border-[var(--g3-warning-soft)]",
  connected: "bg-[var(--g3-secondary-soft)] text-[var(--g3-info)] border-[var(--g3-secondary-soft)]",
  running: "bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)] border-[var(--g3-success-soft)]",
  paused: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
  disconnected: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
  stopped: "bg-[var(--g3-elevated)] text-[var(--g3-muted)] border-[var(--g3-border)]",
  failed: "bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)] border-[var(--g3-danger-soft)]",
};

const PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as Permission[];

function formatDate(ts: number) {
  return new Date(ts).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" });
}

function actionLabel(action: LivePendingActionInfo["action"] | LiveInFlightInfo["action"]): string {
  if (!action) return "action inconnue";
  if (typeof action === "string") return action;
  const parts = [action.type, action.description].filter(Boolean);
  return parts.length > 0 ? parts.join(" — ") : "action inconnue";
}

export function LiveDashboard() {
  const [_user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [sessions, setSessions] = useState<LiveSessionPublic[]>([]);
  const [created, setCreated] = useState<CreatedSession | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [liveConsent, setLiveConsent] = useState(false);
  const [permissions, setPermissions] = useState<Permission[]>([
    "screen.read",
    "input.mouse",
    "input.keyboard",
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Session exécutée dans CE navigateur via l'exécuteur partagé
  // (components/live/live-executeur — le même que le chat).
  const [sessionActive, setSessionActive] = useState<string | null>(null);
  const [sourceLocale, setSourceLocale] = useState<SourceCapture>("screen");
  const [facingLocale, setFacingLocale] = useState<CameraFacing>("environment");

  const sessionDisponible = useSessionAvailable();

  const loadSessions = useCallback(async () => {
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    // Une panne réseau est isolée : elle ne provoque ni rejet non géré dans
    // le callback watchAuth, ni écran vide silencieux.
    try {
      const response = await authFetch("/api/live/sessions", { cache: "no-store" });
      if (response.ok) setSessions((await response.json()).sessions ?? []);
      else if (response.status >= 500) setError("Impossible de charger vos sessions Live (serveur momentanément indisponible).");
    } catch {
      setError("Connexion au serveur impossible pour charger vos sessions Live.");
    }
  }, []);

  useEffect(
    () =>
      watchAuth(async (current) => {
        setUser(current);
        setAuthReady(true);
        await loadSessions();
      }),
    [loadSessions],
  );

  const togglePermission = (permission: Permission) => {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((item) => item !== permission)
        : [...current, permission],
    );
  };

  /* ------------------------------------------------------------------ */
  /* Sessions : création, arrêt, approbations                            */
  /* ------------------------------------------------------------------ */

  const createSession = async () => {
    if (sessionDisponible === false) { setError("Session expirée. Reconnectez-vous."); return; }
    if (name.trim().length === 0 || objective.trim().length < 10 || permissions.length === 0 || !liveConsent) return;
    setBusy(true);
    setError("");
    setCreated(null);
    try {
      const response = await authFetch("/api/live/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), objective: objective.trim(), permissions, mode: "browser" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Création impossible");
      setCreated(data);
      await loadSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible");
    } finally {
      setBusy(false);
    }
  };

  const stopSession = async (id: string) => {
    if (sessionDisponible === false) return;
    await authFetch(`/api/live/sessions/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    await loadSessions();
  };

  const approveAction = async (sessionId: string, actionId: string) => {
    if (sessionDisponible === false) { setError("Session expirée. Reconnectez-vous."); return; }
    setError("");
    try {
      const response = await authFetch(`/api/live/sessions/${sessionId}/actions/${actionId}/approve`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Approbation impossible");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approbation impossible");
    } finally {
      await loadSessions();
    }
  };

  const retryAction = async (sessionId: string, actionId: string) => {
    if (sessionDisponible === false) { setError("Session expirée. Reconnectez-vous."); return; }
    if (!window.confirm("Le résultat de l'action précédente est inconnu : réessayer peut l'exécuter deux fois. Continuer ?")) return;
    setError("");
    try {
      const response = await authFetch(`/api/live/sessions/${sessionId}/actions/${actionId}/retry`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Réessai impossible");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Réessai impossible");
    } finally {
      await loadSessions();
    }
  };

  // Rafraîchit les sessions pour afficher les actions en attente de validation
  // (uniquement onglet visible — lot C2) ; le premier chargement est assuré
  // par watchAuth. Intervalle ADAPTATIF (Task 101, audit quota) : 6 s tant
  // qu'au moins une session est en cours (les approbations HITL doivent
  // remonter vite), 15 s sinon — sans session active, un poll de 6 s ne sert
  // qu'à consommer du quota Firestore. useVisiblePolling ne redémarre
  // l'intervalle que lorsque `ms` change : l'alternance 6 s ↔ 15 s suit
  // proprement le dernier statut connu des sessions.
  const uneSessionEnCours = sessions.some((session) => session.status === "running");
  useVisiblePolling(loadSessions, authReady ? (uneSessionEnCours ? 6_000 : 15_000) : null);

  if (!authReady || sessionDisponible === null) {
    return <div className="p-10 text-center text-[var(--g3-muted)]">Chargement…</div>;
  }

  if (sessionDisponible === false) {
    return (
      <div className="mx-auto max-w-md rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        <h2 className="font-serif text-xl font-semibold">Connexion requise</h2>
        <p className="mt-2 text-sm text-[var(--g3-muted)]">
          Connectez-vous pour créer et piloter des sessions d’agent Live.
        </p>
        <Link href="/login" className="g3-btn g3-btn-primary mt-6">
          Se connecter
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <h2 className="font-serif text-xl font-semibold">Créer une session d’agent Live</h2>
        <p className="mt-2 text-sm text-[var(--g3-muted)]">
          Décrivez la mission : l’agent observe votre écran depuis le navigateur
          et vous guide étape par étape avec le moteur IA interne. Aucun
          téléchargement requis.
        </p>
        <label className="mt-5 block text-xs uppercase tracking-widest text-[var(--g3-muted)]">Nom de la session</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex. Préparer la présentation client"
          maxLength={120}
          className="g3-input mt-2"
        />
        <label className="mt-4 block text-xs uppercase tracking-widest text-[var(--g3-muted)]">Objectif</label>
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Ex. Vérifie l’avancement de ma présentation ouverte à l’écran et dis-moi ce qu’il reste à faire…"
          className="g3-textarea mt-2 min-h-32"
        />
        <div className="mt-4">
          <div className="text-xs uppercase tracking-widest text-[var(--g3-muted)]">Permissions accordées</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {PERMISSION_KEYS.map((permission) => (
              <button
                key={permission}
                onClick={() => togglePermission(permission)}
                className={`rounded-xl border px-4 py-2.5 text-left text-sm transition ${
                  permissions.includes(permission)
                    ? "border-[var(--g3-secondary-soft)] bg-[var(--g3-secondary-soft)] text-[var(--g3-info)]"
                    : "border-[var(--g3-border)] bg-[var(--g3-elevated)] text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
                }`}
              >
                {PERMISSION_LABELS[permission]}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs leading-5 text-[var(--g3-faint)]">
            En mode navigateur, l’agent observe l’écran et décrit les étapes ; le
            contrôle clavier/souris reste réservé à un client PC.
          </p>
        </div>
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3 text-sm leading-6 text-[var(--g3-text-secondary)]">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-neutral-900"
            checked={liveConsent}
            onChange={(e) => setLiveConsent(e.target.checked)}
          />
          <span>
            J’ai compris que cet agent va <strong>observer l’écran de cet ordinateur</strong> selon les permissions
            sélectionnées. Je donne mon consentement explicite avant chaque session.
          </span>
        </label>
        <button
          disabled={busy || name.trim().length === 0 || objective.trim().length < 10 || permissions.length === 0 || !liveConsent}
          onClick={createSession}
          className="g3-btn g3-btn-primary mt-4"
        >
          {busy ? "Création…" : "Créer la session Live"}
        </button>
        {error && (
          <div className="mt-4 rounded-xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] p-4 text-sm text-[var(--g3-danger-strong)]">{error}</div>
        )}

        {created && (
          <div className="mt-5 rounded-2xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] p-5">
            <div className="text-sm font-semibold text-[var(--g3-success-strong)]">Session créée — {created.session.name}</div>
            <div className="mt-1 text-xs text-[var(--g3-muted)]">ID : {created.session.id}</div>
            <button
              onClick={() => setSessionActive(created.session.id)}
              className="g3-btn g3-btn-primary mt-4"
            >
              Tester dans ce navigateur
            </button>
            <p className="mt-3 text-xs leading-5 text-[var(--g3-muted)]">
              L’exécuteur partagé démarre ci-contre (le même que le chat). La session
              expire au bout de 24 h si elle reste inactive.
            </p>
          </div>
        )}
        </section>

        <div className="space-y-5">
          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <h2 className="font-serif text-lg font-semibold">Exécuteur navigateur — moteur interne gen3</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--g3-muted)]">
              it.53 : le MÊME exécuteur que le chat (une seule boucle, un seul composant) —
              écran PC ou caméra mobile, décisions du moteur de vision interne, HITL inline.
            </p>

            {sessionActive ? (
              <div className="mt-4">
                <LiveExecuteur
                  key={sessionActive}
                  sessionId={sessionActive}
                  sourceInitiale={sourceLocale}
                  cameraFacingInitiale={facingLocale}
                  onFermer={() => { setSessionActive(null); void loadSessions(); }}
                />
              </div>
            ) : (
              <div className="mt-4">
                <p className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-3 text-xs leading-5 text-[var(--g3-muted)]">
                  Aucune session exécutée dans ce navigateur. Créez une session ci-contre puis
                  « Tester dans ce navigateur », reprenez une session récente, ou activez le live
                  directement depuis le Chat IA (bouton « Agent Live »).
                </p>
                <div className="mt-3">
                  <div className="text-xs uppercase tracking-widest text-[var(--g3-muted)]">Source de capture de l’exécuteur</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      aria-pressed={sourceLocale === "screen"}
                      onClick={() => setSourceLocale("screen")}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold ${sourceLocale === "screen" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
                    >
                      Écran (PC)
                    </button>
                    <button
                      type="button"
                      aria-pressed={sourceLocale === "camera"}
                      onClick={() => setSourceLocale("camera")}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold ${sourceLocale === "camera" ? "bg-[var(--g3-deep)] text-white" : "border border-[var(--g3-border-strong)] text-[var(--g3-muted)]"}`}
                    >
                      Caméra (mobile)
                    </button>
                    {sourceLocale === "camera" ? (
                      <button
                        type="button"
                        onClick={() => setFacingLocale((facing) => (facing === "environment" ? "user" : "environment"))}
                        className="rounded-full border border-[var(--g3-border-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)]"
                      >
                        Caméra {facingLocale === "environment" ? "arrière" : "avant"} ⇄
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            <p className="mt-4 rounded-xl border border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] p-3 text-xs leading-5 text-[var(--g3-warning-strong)]">
              En mode navigateur, l’agent observe, analyse et vous guide action par
              action — il ne contrôle pas votre clavier ni votre souris. Chaque
              action sensible exige de toute façon votre validation.
            </p>
          </section>

          <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <h2 className="font-serif text-lg font-semibold">Sessions récentes</h2>
            {sessions.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--g3-muted)]">Aucune session pour le moment.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {sessions.map((session) => (
                  <li key={session.id} className="rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate text-sm font-semibold">{session.name}</div>
                      <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[session.status] ?? STATUS_STYLES.paused}`}>
                        {session.status}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-[var(--g3-faint)]">{formatDate(session.createdAt)}</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {session.permissions.map((permission) => (
                        <span key={permission} className="rounded-md border border-[var(--g3-border)] bg-[var(--g3-surface)] px-2 py-0.5 text-[10px] text-[var(--g3-muted)]">
                          {permission}
                        </span>
                      ))}
                    </div>
                    {session.pendingAction?.actionId && (
                      <div className="mt-3 rounded-xl border border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] p-3">
                        <div className="text-xs font-semibold text-[var(--g3-warning-strong)]">Action sensible en attente de votre validation</div>
                        <div className="mt-1 truncate font-mono text-[10px] text-[var(--g3-warning-strong)]">{actionLabel(session.pendingAction.action)}</div>
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => approveAction(session.id, session.pendingAction!.actionId)}
                            className="rounded-lg border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-success-strong)] hover:bg-[var(--g3-success-soft)]"
                          >
                            Approuver
                          </button>
                          <button
                            onClick={() => stopSession(session.id)}
                            className="rounded-lg border border-[var(--g3-border)] bg-[var(--g3-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
                          >
                            Refuser et arrêter
                          </button>
                        </div>
                      </div>
                    )}
                    {session.inFlightAction?.actionId && (
                      <div className="mt-3 rounded-xl border border-[var(--g3-secondary-soft)] bg-[var(--g3-secondary-soft)] p-3">
                        <div className="text-xs font-semibold text-[var(--g3-info)]">Action en cours dont le résultat est inconnu</div>
                        <div className="mt-1 truncate font-mono text-[10px] text-[var(--g3-info)]">{actionLabel(session.inFlightAction.action)}</div>
                        <button
                          onClick={() => retryAction(session.id, session.inFlightAction!.actionId)}
                          className="mt-2 rounded-lg border border-[var(--g3-secondary-soft)] bg-[var(--g3-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-info)] hover:bg-[var(--g3-secondary-soft)]"
                        >
                          Réessayer
                        </button>
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {["pending", "connected", "running", "paused"].includes(session.status) && (
                        <>
                          {sessionActive !== session.id && (
                            <button
                              onClick={() => setSessionActive(session.id)}
                              className="rounded-lg border border-[var(--g3-secondary-soft)] bg-[var(--g3-secondary-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-info)] hover:bg-[var(--g3-secondary-soft)]"
                            >
                              Tester dans le navigateur
                            </button>
                          )}
                          <button
                            onClick={() => stopSession(session.id)}
                            className="rounded-lg border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--g3-danger-strong)] hover:bg-[var(--g3-danger-soft)]"
                          >
                            Stop
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      <section className="rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-warning-soft)] p-6">
        <h2 className="font-serif text-xl font-semibold text-[var(--g3-warning-strong)]">Le mode Live s&apos;active depuis le Chat IA</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--g3-text-secondary)]">
          it.52 (demande propriétaire) : l&apos;agent live s&apos;active désormais directement dans la conversation
          (bouton « Agent Live » sous le chat) — moteur de vision INTERNE gen3, écran PC ou caméra mobile,
          aucune clé externe. Cet espace reste votre tableau de bord : sessions, décisions, approbations et arrêt,
          avec le MÊME exécuteur que le chat (it.53).
        </p>
        <Link href="/chat" className="g3-btn g3-btn-primary mt-4 inline-flex text-xs">Ouvrir le Chat IA pour activer le live</Link>
      </section>
    </div>
  );
}
