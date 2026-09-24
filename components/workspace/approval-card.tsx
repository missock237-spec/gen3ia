"use client";

import { useState } from "react";

import { APPROVAL_STATUS_LABELS, APPROVAL_STATUS_STYLES } from "./labels";
import type { ConversationApproval } from "@/lib/domain/conversations/types";

/**
 * Carte de validation inline — l'action sensible est résumée clairement :
 * impact, outil utilisé, données concernées et coût estimé. La décision
 * (approuver / rejeter) reste dans le fil de la conversation.
 */

interface ApprovalCardProps {
  approval: ConversationApproval;
  onDecide: (approvalId: string, decision: "approved" | "rejected") => Promise<void>;
  disabled?: boolean;
}

export function ApprovalCard({ approval, onDecide, disabled = false }: ApprovalCardProps) {
  const [busy, setBusy] = useState(false);
  const decided = approval.status !== "pending";

  const decide = async (decision: "approved" | "rejected") => {
    if (decided || busy) return;
    setBusy(true);
    try {
      await onDecide(approval.id, decision);
    } finally {
      setBusy(false);
    }
  };

  const pending = approval.status === "pending";
  const riskTone = /élev|high|crit/i.test(approval.risk)
    ? "bg-red-50 text-red-700 border-red-200"
    : /moy|medium/i.test(approval.risk)
      ? "bg-amber-50 text-amber-800 border-amber-200"
      : "bg-emerald-50 text-emerald-700 border-emerald-200";

  return (
    <div
      className={`my-2 overflow-hidden rounded-xl border bg-[var(--g3-surface)] shadow-[var(--g3-shadow-sm)] ${pending ? "border-amber-300 ring-4 ring-amber-100/70" : "border-[var(--g3-border)]"}`}
      data-approval-id={approval.id}
      data-status={approval.status}
      role={pending ? "alert" : undefined}
    >
      <div className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 ${pending ? "bg-amber-50/70" : ""}`}>
        <p className="flex min-w-0 items-center gap-2.5 text-[13.5px] font-semibold text-[var(--g3-ink)]">
          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M12 8v4M12 16h.01" /></svg>
          </span>
          <span className="min-w-0">
            <span className="block text-[11px] font-medium text-amber-700">Validation requise</span>
            <span className="block truncate">{approval.title}</span>
          </span>
        </p>
        <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${APPROVAL_STATUS_STYLES[approval.status]}`}>
          {APPROVAL_STATUS_LABELS[approval.status]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-px border-y border-[var(--g3-border)] bg-[var(--g3-border)] text-[12px] sm:grid-cols-4">
        <div className="bg-[var(--g3-surface)] px-4 py-2.5">
          <dt className="text-[11px] text-[var(--g3-muted)]">Outil</dt>
          <dd className="mt-0.5 truncate font-mono text-[11.5px] text-[var(--g3-ink)]" title={approval.toolName}>{approval.toolName}</dd>
        </div>
        <div className="bg-[var(--g3-surface)] px-4 py-2.5">
          <dt className="text-[11px] text-[var(--g3-muted)]">Coût estimé</dt>
          <dd className="mt-0.5 font-medium tabular-nums text-[var(--g3-ink)]">{approval.estimatedCost || "Gratuit"}</dd>
        </div>
        <div className="bg-[var(--g3-surface)] px-4 py-2.5">
          <dt className="text-[11px] text-[var(--g3-muted)]">Données</dt>
          <dd className="mt-0.5 truncate text-[var(--g3-ink)]" title={approval.dataScope}>{approval.dataScope || "—"}</dd>
        </div>
        <div className="bg-[var(--g3-surface)] px-4 py-2.5">
          <dt className="text-[11px] text-[var(--g3-muted)]">Risque</dt>
          <dd className="mt-0.5"><span className={`rounded-full border px-1.5 py-px text-[10.5px] font-medium ${riskTone}`}>{approval.risk}</span></dd>
        </div>
      </dl>

      {approval.impact && (
        <p className="px-4 pt-3 text-[13px] leading-relaxed text-[var(--g3-ink-2)]">
          <span className="font-medium text-[var(--g3-ink)]">Impact : </span>
          {approval.impact}
        </p>
      )}

      {!decided && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <button type="button" onClick={() => decide("approved")} disabled={disabled || busy} className="g3-btn g3-btn-primary !h-8 text-xs">
            {busy ? "Exécution…" : "Approuver et exécuter"}
          </button>
          <button type="button" onClick={() => decide("rejected")} disabled={disabled || busy} className="g3-btn g3-btn-ghost !h-8 text-xs">
            Rejeter
          </button>
          <span className="ml-auto text-[11px] text-[var(--g3-subtle)]">Rien ne sera exécuté sans votre accord.</span>
        </div>
      )}

      {approval.status === "approved" && approval.decidedAt && (
        <p className="px-4 py-3 text-[12px] text-emerald-700">Approuvée — l&apos;action a été exécutée dans cette conversation.</p>
      )}
      {approval.status === "rejected" && (
        <p className="px-4 py-3 text-[12px] text-red-600">Rejetée — aucune donnée n&apos;a été transmise.</p>
      )}
    </div>
  );
}
