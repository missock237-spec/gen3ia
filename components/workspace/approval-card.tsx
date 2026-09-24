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

  return (
    <div
      className={`my-2 rounded-xl border p-3.5 ${approval.status === "pending" ? "border-amber-300 bg-amber-50/60" : "border-[var(--g3-border)] bg-[var(--g3-surface)]"}`}
      data-approval-id={approval.id}
      data-status={approval.status}
      role={approval.status === "pending" ? "alert" : undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--g3-text)]">
          <span aria-hidden className="grid size-6 place-items-center rounded-full bg-amber-100 text-xs text-amber-700">⚖</span>
          {approval.title}
        </p>
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${APPROVAL_STATUS_STYLES[approval.status]}`}>
          {APPROVAL_STATUS_LABELS[approval.status]}
        </span>
      </div>

      <dl className="mt-2.5 grid grid-cols-1 gap-1.5 text-[11px] leading-relaxed sm:grid-cols-2">
        <div>
          <dt className="font-medium text-[var(--g3-muted)]">Outil utilisé</dt>
          <dd className="font-mono text-[var(--g3-text)]">{approval.toolName}</dd>
        </div>
        <div>
          <dt className="font-medium text-[var(--g3-muted)]">Coût estimé</dt>
          <dd className="text-[var(--g3-text)]">{approval.estimatedCost || "gratuit"}</dd>
        </div>
        <div>
          <dt className="font-medium text-[var(--g3-muted)]">Données concernées</dt>
          <dd className="text-[var(--g3-text)]">{approval.dataScope || "—"}</dd>
        </div>
        <div>
          <dt className="font-medium text-[var(--g3-muted)]">Niveau de risque</dt>
          <dd className="text-[var(--g3-text)]">{approval.risk}</dd>
        </div>
      </dl>

      {approval.impact && (
        <p className="mt-2 rounded-lg bg-[var(--g3-surface)]/80 px-2.5 py-2 text-xs leading-relaxed text-[var(--g3-text-secondary)]">
          <span className="font-medium">Impact : </span>
          {approval.impact}
        </p>
      )}

      {!decided && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => decide("approved")}
            disabled={disabled || busy}
            className="g3-btn g3-btn-primary text-xs"
          >
            {busy ? "Exécution…" : "Approuver l'action"}
          </button>
          <button
            type="button"
            onClick={() => decide("rejected")}
            disabled={disabled || busy}
            className="g3-btn g3-btn-danger text-xs"
          >
            Rejeter
          </button>
        </div>
      )}

      {approval.status === "approved" && approval.decidedAt && (
        <p className="mt-2 text-[11px] text-emerald-700">✓ Approuvée — l&apos;action a été exécutée dans cette conversation.</p>
      )}
      {approval.status === "rejected" && (
        <p className="mt-2 text-[11px] text-red-600">✕ Rejetée — aucune donnée n&apos;a été transmise.</p>
      )}
    </div>
  );
}
