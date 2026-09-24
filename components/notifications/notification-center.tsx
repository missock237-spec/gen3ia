"use client";

import * as React from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { useToast } from "@/components/ui/toast";

/**
 * Centre de notifications Gen3ia (cloche globale).
 *
 * Rôle clé : la validation à DISTANCE des actions sensibles. Quand un agent
 * attend un accord et que l'utilisateur n'est pas dans le chat, la notification
 * affiche deux boutons — « Approuver » et « Rejeter » — qui déclenchent les
 * routes métier d'approbation existantes (session + propriété vérifiées
 * serveur). Une notification native du navigateur est également émise si la
 * permission a été accordée.
 *
 * Rafraîchissement : polling léger (25 s) + refresh au retour d'onglet.
 */

type Gen3iaNotification = {
  id: string;
  type: "approval_requested" | "info";
  title: string;
  body: string;
  read: boolean;
  kind?: "agent_action" | "conversation";
  approvalId?: string;
  conversationId?: string;
  executionId?: string;
  toolSlug?: string;
  createdAtMs: number;
};

const POLL_INTERVAL_MS = 25_000;

function timeAgo(ms: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.round(hours / 24)} j`;
}

export function NotificationCenter() {
  const toast = useToast();
  const sessionAvailable = useSessionAvailable();
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<Gen3iaNotification[]>([]);
  const [unread, setUnread] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const [deciding, setDeciding] = React.useState<string | null>(null);
  const seenApprovalIds = React.useRef<Set<string>>(new Set());
  const firstLoadDone = React.useRef(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const refresh = React.useCallback(async () => {
    if (!sessionAvailable) return;
    setLoading(true);
    try {
      const response = await authFetch("/api/notifications?limit=30", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      const list = (Array.isArray(data.notifications) ? data.notifications : []) as Gen3iaNotification[];
      setItems(list);
      setUnread(Number(data.unread ?? 0));
      // Notification native du navigateur pour les NOUVELLES validations
      // (jamais au premier chargement : on ne rejoue pas l'historique).
      for (const item of list) {
        if (item.type !== "approval_requested" || !item.approvalId) continue;
        const isNew = !seenApprovalIds.current.has(item.approvalId);
        seenApprovalIds.current.add(item.approvalId);
        if (firstLoadDone.current && isNew && typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
          try {
            new Notification("Gen3ia — validation requise", { body: item.title + (item.body ? `\n${item.body}` : ""), tag: item.approvalId });
          } catch { /* notification native indisponible */ }
        }
      }
      firstLoadDone.current = true;
    } catch {
      /* réseau indisponible : le polling suivant retentera */
    } finally {
      setLoading(false);
    }
  }, [sessionAvailable]);

  React.useEffect(() => {
    if (!sessionAvailable) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, sessionAvailable]);

  // Fermeture au clic extérieur + touche Échap.
  React.useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markRead(id: string) {
    try {
      const response = await authFetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (response.ok) {
        const data = await response.json();
        setUnread(Number(data.unread ?? 0));
        setItems((current) => current.map((item) => (item.id === id ? { ...item, read: true } : item)));
      }
    } catch { /* non bloquant */ }
  }

  async function markAllRead() {
    try {
      const response = await authFetch("/api/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      if (response.ok) {
        const data = await response.json();
        setUnread(Number(data.unread ?? 0));
        setItems((current) => current.map((item) => ({ ...item, read: true })));
      }
    } catch { /* non bloquant */ }
  }

  /** Décision depuis la notification : route métier selon le type d'approbation. */
  async function decide(notification: Gen3iaNotification, decision: "approve" | "reject") {
    if (!notification.approvalId || deciding) return;
    setDeciding(notification.id);
    try {
      let response: Response;
      if (notification.kind === "conversation") {
        response = await authFetch(`/api/workspace/approvals/${encodeURIComponent(notification.approvalId)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ decision: decision === "approve" ? "approved" : "rejected" }),
        });
      } else {
        response = await authFetch("/api/agent/chat/approve", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ approvalId: notification.approvalId, action: decision }),
        });
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Décision impossible.");
      toast.success(decision === "approve" ? "Action approuvée — l'exécution continue." : "Action rejetée.");
      await markRead(notification.id);
      void refresh();
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Décision impossible.");
    } finally {
      setDeciding(null);
    }
  }

  if (!sessionAvailable) return null;

  return (
    <div ref={containerRef} className="fixed right-3 top-2.5 z-[70] sm:right-4">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label={`Notifications${unread > 0 ? ` (${unread} non lues)` : ""}`}
        className="relative grid h-10 w-10 place-items-center rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] text-base shadow-[0_8px_24px_-14px_rgba(0,0,0,0.5)] transition hover:bg-[var(--g3-elevated)]"
      >
        <span aria-hidden="true">🔔</span>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Centre de notifications"
          className="absolute right-0 top-12 max-h-[70vh] w-[min(92vw,380px)] overflow-y-auto rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-surface)] shadow-[0_30px_80px_-24px_rgba(0,0,0,0.6)]"
        >
          <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-[var(--g3-border)] bg-[var(--g3-surface)] px-4 py-3">
            <p className="text-sm font-bold text-[var(--g3-text)]">Notifications</p>
            {unread > 0 && (
              <button type="button" onClick={() => void markAllRead()} className="rounded-full border border-[var(--g3-border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--g3-muted)] transition hover:bg-[var(--g3-elevated)]">
                Tout marquer lu
              </button>
            )}
          </div>

          {loading && items.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-[var(--g3-muted)]">Chargement…</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs leading-5 text-[var(--g3-muted)]">
              Aucune notification pour le moment. Les validations d&apos;actions sensibles apparaîtront ici, avec des boutons pour approuver ou rejeter.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--g3-border)]">
              {items.map((item) => {
                const actionable = item.type === "approval_requested" && Boolean(item.approvalId) && !item.read;
                return (
                  <li key={item.id} className={`px-4 py-3 ${item.read ? "" : "bg-[var(--g3-elevated)]/50"}`}>
                    <div className="flex items-start gap-2">
                      {!item.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-hidden="true" />}
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm leading-5 text-[var(--g3-text)] ${item.read ? "" : "font-bold"}`}>{item.title}</p>
                        {item.body && <p className="mt-0.5 break-words text-[11px] leading-5 text-[var(--g3-muted)]">{item.body}</p>}
                        <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">{timeAgo(item.createdAtMs)}</p>
                        {actionable && (
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              onClick={() => void decide(item, "approve")}
                              disabled={deciding === item.id}
                              className="rounded-full bg-emerald-600 px-3.5 py-1.5 text-[11px] font-bold text-white transition hover:bg-emerald-500 disabled:opacity-50"
                            >
                              {deciding === item.id ? "…" : "Approuver"}
                            </button>
                            <button
                              type="button"
                              onClick={() => void decide(item, "reject")}
                              disabled={deciding === item.id}
                              className="rounded-full border border-red-300/50 px-3.5 py-1.5 text-[11px] font-bold text-red-300 transition hover:bg-red-500/10 disabled:opacity-50"
                            >
                              Rejeter
                            </button>
                          </div>
                        )}
                      </div>
                      {!item.read && !actionable && (
                        <button type="button" onClick={() => void markRead(item.id)} className="shrink-0 rounded-full border border-[var(--g3-border)] px-2 py-1 text-[10px] font-semibold text-[var(--g3-faint)] transition hover:bg-[var(--g3-elevated)]">
                          Lu
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
