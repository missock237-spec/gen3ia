"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { type User } from "firebase/auth";

import { watchAuth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

type Permission =
  | "screen.read"
  | "input.mouse"
  | "input.keyboard"
  | "files.read"
  | "files.write"
  | "browser.control";

const PERMISSION_LABELS: Record<Permission, string> = {
  "screen.read": "Observer l'écran",
  "input.mouse": "Contrôler la souris",
  "input.keyboard": "Contrôler le clavier",
  "files.read": "Lire les fichiers",
  "files.write": "Écrire des fichiers",
  "browser.control": "Contrôler le navigateur",
};

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
  pendingAction?: LivePendingActionInfo | null;
  inFlightAction?: LiveInFlightInfo | null;
}

interface CreatedSession {
  session: LiveSessionPublic;
  pairingToken: string;
  viewerToken: string;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 border-amber-200",
  connected: "bg-sky-100 text-sky-700 border-sky-200",
  running: "bg-emerald-100 text-emerald-600 border-emerald-200",
  paused: "bg-neutral-100 text-neutral-600 border-neutral-200",
  disconnected: "bg-neutral-100 text-neutral-600 border-neutral-200",
  stopped: "bg-neutral-100 text-neutral-600 border-neutral-200",
  failed: "bg-red-50 text-red-600 border-red-200",
};

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
  const [user, setUser] = useState<User | null>(null);
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
  const [copied, setCopied] = useState(false);
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  const [viewerStatus, setViewerStatus] = useState<"offline" | "connecting" | "live">("offline");
  const sessionDisponible = useSessionAvailable();

  const loadSessions = useCallback(async () => {
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    const response = await authFetch("/api/live/sessions", { cache: "no-store" });
    if (response.ok) setSessions((await response.json()).sessions ?? []);
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
        body: JSON.stringify({ name: name.trim(), objective: objective.trim(), permissions }),
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

  // Rafraîchit les sessions pour afficher les actions en attente de validation.
  useEffect(() => {
    if (!authReady) return;
    const interval = setInterval(() => { void loadSessions(); }, 6_000);
    return () => clearInterval(interval);
  }, [authReady, loadSessions]);

  useEffect(() => {
    if (!created?.viewerToken) return;
    const gateway = process.env.NEXT_PUBLIC_LIVE_GATEWAY_URL;
    if (!gateway) return;
    setViewerStatus("connecting");
    const socket = new WebSocket(gateway);
    socket.onopen = () => socket.send(JSON.stringify({ type: "viewer.hello", sessionId: created.session.id, viewerToken: created.viewerToken }));
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type?: string; jpegBase64?: string };
        if (message.type === "viewer.ack") setViewerStatus("live");
        if (message.type === "frame" && message.jpegBase64) setLiveFrame("data:image/jpeg;base64," + message.jpegBase64);
      } catch {}
    };
    socket.onerror = () => setViewerStatus("offline");
    socket.onclose = () => setViewerStatus("offline");
    return () => socket.close();
  }, [created]);

  const copyPairing = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.pairingToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!authReady || sessionDisponible === null) {
    return <div className="p-10 text-center text-neutral-500">Chargement…</div>;
  }

  if (sessionDisponible === false) {
    return (
      <div className="mx-auto max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        <h2 className="font-serif text-xl font-semibold">Connexion requise</h2>
        <p className="mt-2 text-sm text-neutral-600">
          Connectez-vous pour créer et piloter des sessions d’agent Live.
        </p>
        <Link href="/login" className="g3-btn g3-btn-primary mt-6">
          Se connecter
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
      <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        <h2 className="font-serif text-xl font-semibold">Créer une session d’agent Live</h2>
        <p className="mt-2 text-sm text-neutral-500">
          Décrivez la mission. Le client PC se connectera à cette session avec
          le jeton d’appairage, partagera l’écran et exécutera les actions
          approuvées.
        </p>
        <label className="mt-5 block text-xs uppercase tracking-widest text-neutral-500">Nom de la session</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex. Préparer la présentation client"
          maxLength={120}
          className="g3-input mt-2"
        />
        <label className="mt-4 block text-xs uppercase tracking-widest text-neutral-500">Objectif</label>
        <textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          placeholder="Ex. Ouvre le dossier du projet, vérifie les derniers chiffres et prépare le résumé dans le tableur…"
          className="g3-textarea mt-2 min-h-32"
        />
        <div className="mt-4">
          <div className="text-xs uppercase tracking-widest text-neutral-500">Permissions accordées</div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {(Object.keys(PERMISSION_LABELS) as Permission[]).map((permission) => (
              <button
                key={permission}
                onClick={() => togglePermission(permission)}
                className={`rounded-xl border px-4 py-2.5 text-left text-sm transition ${
                  permissions.includes(permission)
                    ? "border-sky-200 bg-sky-100 text-sky-700"
                    : "border-[rgba(23,23,20,0.09)] bg-neutral-50 text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                {PERMISSION_LABELS[permission]}
              </button>
            ))}
          </div>
        </div>
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-[rgba(23,23,20,0.09)] bg-white px-4 py-3 text-sm leading-6 text-neutral-700">
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 accent-neutral-900"
            checked={liveConsent}
            onChange={(e) => setLiveConsent(e.target.checked)}
          />
          <span>
            J’ai compris que cet agent va <strong>agir sur cet ordinateur</strong> selon les permissions
            sélectionnées (clavier, souris, écran). Je donne mon consentement explicite avant chaque session.
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
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
        )}

        {created && (
          <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="text-sm font-semibold text-emerald-600">Session créée — {created.session.name}</div>
            <div className="mt-1 text-xs text-neutral-500">ID : {created.session.id}</div>
            <div className="mt-4 text-xs uppercase tracking-widest text-neutral-500">Jeton d’appairage (affiché une seule fois)</div>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3 font-mono text-sm text-emerald-300">
                {created.pairingToken}
              </code>
              <button onClick={copyPairing} className="rounded-xl border border-[rgba(23,23,20,0.09)] bg-white px-4 py-3 text-xs font-semibold hover:bg-neutral-100">
                {copied ? "Copié" : "Copier"}
              </button>
            </div>
            <p className="mt-3 text-xs leading-5 text-neutral-500">
              Configurez le client PC puis lancez-le sur l’ordinateur à piloter
              (voir les instructions à droite). La session expire au bout de 24 h
              si elle reste inactive.
            </p>
          </div>
        )}
      </section>

      <div className="space-y-5">        {created && (
          <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-serif text-lg font-semibold">Écran en temps réel</h2>
                <p className="mt-1 text-xs text-neutral-500">Flux privé de la session active.</p>
              </div>
              <span className="rounded-full border border-[rgba(23,23,20,0.09)] bg-white px-2.5 py-1 text-[11px] text-neutral-600">{viewerStatus === "live" ? "LIVE" : viewerStatus}</span>
            </div>
            <div className="mt-4 overflow-hidden rounded-2xl border border-[rgba(23,23,20,0.09)] bg-black aspect-video flex items-center justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element -- flux data-URL temps reel, next/image inapplicable */}
              {liveFrame ? <img src={liveFrame} alt="Écran du PC contrôlé par Gen3ia Live" className="h-full w-full object-contain" /> : <span className="text-sm text-neutral-300">En attente du flux écran…</span>}
            </div>
            <p className="mt-3 text-xs leading-5 text-neutral-500">Le flux est accessible uniquement avec le jeton de visualisation de cette session. Il ne permet pas de prendre le contrôle du PC.</p>
          </section>
        )}

        <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <h2 className="font-serif text-lg font-semibold">Connecter un PC (client Live)</h2>
          <ol className="mt-4 space-y-3 text-sm leading-6 text-neutral-600">
            <li className="rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-4 py-3">
              1. Téléchargez l’app Gen3ia Desktop (Windows / Linux) ou
              installez le client : <code className="font-mono text-xs text-sky-700">live-agent/</code>
            </li>
            <li className="rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-4 py-3">
              2. Définissez les variables :
              <code className="mt-1 block overflow-x-auto whitespace-pre rounded-lg bg-neutral-900 p-2 font-mono text-[11px] text-emerald-300">
{`GEN3IA_LIVE_GATEWAY_URL=wss://votre-gateway
GEN3IA_LIVE_SESSION_ID=<id session>
GEN3IA_LIVE_PAIRING_TOKEN=<jeton>
GEN3IA_LIVE_DEVICE_ID=<nom du PC>`}
              </code>
            </li>
            <li className="rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-4 py-3">
              3. Lancez le client : il partage l’écran et attend les actions
              approuvées.
            </li>
          </ol>
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-100 p-3 text-xs leading-5 text-amber-700">
            Chaque action sensible exige une validation humaine depuis cette
            page. Revoquez la session à tout moment avec « Stop ».
          </p>
        </section>

        <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <h2 className="font-serif text-lg font-semibold">Sessions récentes</h2>
          {sessions.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">Aucune session pour le moment.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {sessions.map((session) => (
                <li key={session.id} className="rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-sm font-semibold">{session.name}</div>
                    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] ${STATUS_STYLES[session.status] ?? STATUS_STYLES.paused}`}>
                      {session.status}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-neutral-400">{formatDate(session.createdAt)}</div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {session.permissions.map((permission) => (
                      <span key={permission} className="rounded-md border border-[rgba(23,23,20,0.09)] bg-white px-2 py-0.5 text-[10px] text-neutral-500">
                        {permission}
                      </span>
                    ))}
                  </div>
                  {session.pendingAction?.actionId && (
                    <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
                      <div className="text-xs font-semibold text-amber-700">Action sensible en attente de votre validation</div>
                      <div className="mt-1 truncate font-mono text-[10px] text-amber-600">{actionLabel(session.pendingAction.action)}</div>
                      <div className="mt-2 flex gap-2">
                        <button
                          onClick={() => approveAction(session.id, session.pendingAction!.actionId)}
                          className="rounded-lg border border-emerald-300 bg-emerald-100 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-200"
                        >
                          Approuver
                        </button>
                        <button
                          onClick={() => stopSession(session.id)}
                          className="rounded-lg border border-[rgba(23,23,20,0.09)] bg-white px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-100"
                        >
                          Refuser et arrêter
                        </button>
                      </div>
                    </div>
                  )}
                  {session.inFlightAction?.actionId && (
                    <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3">
                      <div className="text-xs font-semibold text-sky-700">Action en cours dont le résultat est inconnu</div>
                      <div className="mt-1 truncate font-mono text-[10px] text-sky-600">{actionLabel(session.inFlightAction.action)}</div>
                      <button
                        onClick={() => retryAction(session.id, session.inFlightAction!.actionId)}
                        className="mt-2 rounded-lg border border-sky-300 bg-white px-3 py-1.5 text-xs font-semibold text-sky-700 hover:bg-sky-100"
                      >
                        Réessayer
                      </button>
                    </div>
                  )}
                  {["pending", "connected", "running", "paused"].includes(session.status) && (
                    <button
                      onClick={() => stopSession(session.id)}
                      className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-100"
                    >
                      Stop
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
