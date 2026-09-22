"use client";

import { useCallback, useEffect, useState } from "react";
import { authFetch } from "@/lib/firebase/auth-client";

/**
 * Kit UI des modules métier (Task 15 — architecture à moteurs).
 * Homogénéise les 12 surfaces (Marketing, Sales, RH, Documents, Conformité,
 * Opérations, Finance, Automatisations) : classes, champs, badges, stats et
 * hook de données typé. Chaque page reste un client component autonome qui
 * consomme ses routes /api/business/<module>.
 */

export const inputCls =
  "w-full rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-[14px] text-neutral-900 placeholder:text-neutral-400 outline-none transition focus:border-neutral-900 focus:ring-2 focus:ring-neutral-900/10 disabled:opacity-50";
export const labelCls = "mb-1.5 block text-[12px] font-semibold uppercase tracking-wide text-neutral-500";
export const btnPrimaryCls =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40";
export const btnGhostCls =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-[12.5px] font-semibold text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-900 disabled:opacity-40";
export const cardCls = "rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]";

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11.5px] text-neutral-400">{hint}</span> : null}
    </label>
  );
}

type PillTone = "neutral" | "green" | "amber" | "red" | "blue";
const TONE_CLS: Record<PillTone, string> = {
  neutral: "bg-neutral-100 text-neutral-600",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  blue: "bg-sky-50 text-sky-700",
};

export function Pill({ tone = "neutral", children }: { tone?: PillTone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${TONE_CLS[tone]}`}>{children}</span>;
}

export function StatCard({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: PillTone }) {
  return (
    <div className={cardCls}>
      <p className="text-[11.5px] font-semibold uppercase tracking-wide text-neutral-400">{label}</p>
      <p className="mt-1.5 text-[22px] font-bold leading-tight text-neutral-900">{value}</p>
      {hint ? (
        <p className="mt-1 text-[12px] text-neutral-500">
          {tone ? <Pill tone={tone}>{hint}</Pill> : hint}
        </p>
      ) : null}
    </div>
  );
}

export function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-neutral-300 bg-neutral-50 px-4 py-6 text-center text-[13px] text-neutral-500">{children}</p>;
}

export function ModuleSection({ title, children, actions }: { title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-bold text-neutral-900">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Tones de statut partagés par tous les modules. */
export function statusTone(status: string): PillTone {
  switch (status) {
    case "approved":
    case "signed":
    case "paid":
    case "completed":
    case "fulfilled":
    case "success":
    case "published":
    case "confirmed":
      return "green";
    case "pending":
    case "planned":
    case "draft":
    case "received":
    case "in_progress":
    case "reminded_1":
      return "amber";
    case "rejected":
    case "failed":
    case "overdue":
    case "written_off":
    case "refused":
    case "escalated":
      return "red";
    case "running":
    case "sent":
    case "reminded_2":
    case "partial":
      return "blue";
    default:
      return "neutral";
  }
}

export const STATUS_LABELS: Record<string, string> = {
  draft: "Brouillon",
  pending: "En attente",
  approved: "Approuvé",
  rejected: "Refusé",
  planned: "Planifié",
  confirmed: "Confirmé",
  completed: "Terminé",
  cancelled: "Annulé",
  in_progress: "En cours",
  sent: "Envoyé",
  signed: "Signé",
  archived: "Archivé",
  received: "Reçue",
  in_progress_gdpr: "En traitement",
  fulfilled: "Honorée",
  refused: "Refusée",
  open: "Ouverte",
  reminded_1: "Relance 1",
  reminded_2: "Relance 2",
  escalated: "Escaladée",
  paid: "Payée",
  written_off: "Abandonnée",
  published: "Publiée",
  ok: "À jour",
  due_soon: "Échéance proche",
  overdue: "En retard",
  success: "Succès",
  partial: "Partiel",
  failed: "Échec",
  skipped: "Ignoré",
  enabled: "Active",
  disabled: "Inactive",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * Hook de données module : charge `endpoint` (JSON { <key>: T[] }),
 * expose refresh + mutation helpers typés et un état d'erreur homogène.
 */
export function useModuleData<T>(endpoint: string, listKey: string) {
  const [items, setItems] = useState<T[]>([]);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const response = await authFetch(endpoint, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Chargement impossible.");
      setItems((data[listKey] ?? []) as T[]);
      const rest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) if (key !== listKey) rest[key] = value;
      setExtra(rest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }, [endpoint, listKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /** POST/PATCH/DELETE homogène : rafraîchit la liste et renvoie l'erreur. */
  const mutate = useCallback(
    async (method: "POST" | "PATCH" | "DELETE", body?: unknown, urlSuffix = ""): Promise<Record<string, unknown> | null> => {
      setBusy(true);
      try {
        const response = await authFetch(`${endpoint}${urlSuffix}`, {
          method,
          ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? "Action impossible.");
        await load();
        return data;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action impossible.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [endpoint, load],
  );

  const remove = useCallback(
    async (id: string) => mutate("DELETE", undefined, `?id=${encodeURIComponent(id)}`),
    [mutate],
  );

  return { items, extra, loading, error, setError, busy, mutate, remove, reload: load };
}

/** Formatage compact d'une date ISO pour les listes. */
export function shortDate(value: string | number | undefined | null): string {
  if (value === undefined || value === null || value === "") return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}
