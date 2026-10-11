"use client";

import type { ReactNode } from "react";

/**
 * Callout Gen3ia — notification unifiée du Studio.
 * Remplace les alertes inline (violet/rouge/émeraude/ambre) dispersées
 * dans les pages. Accessible : role="alert" pour les erreurs,
 * role="status" pour les retours d'information.
 */

export type CalloutTone = "info" | "success" | "warning" | "error" | "neutral";

const TONE_STYLES: Record<CalloutTone, { box: string; iconColor: string }> = {
  info: { box: "border-[var(--g3-primary-soft)] bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]", iconColor: "text-[var(--g3-primary-strong)]" },
  success: { box: "border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]", iconColor: "text-[var(--g3-success-strong)]" },
  warning: { box: "border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]", iconColor: "text-[var(--g3-warning-strong)]" },
  error: { box: "border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] text-[var(--g3-danger-strong)]", iconColor: "text-[var(--g3-danger-strong)]" },
  neutral: { box: "border-[rgba(23,23,20,0.09)] bg-[var(--g3-elevated)] text-[var(--g3-muted)]", iconColor: "text-[var(--g3-muted)]" },
};

function ToneIcon({ tone }: { tone: CalloutTone }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true as const };
  switch (tone) {
    case "success":
      return <svg {...common} className={TONE_STYLES[tone].iconColor}><path d="m5 12 4 4L19 6" /></svg>;
    case "warning":
      return <svg {...common} className={TONE_STYLES[tone].iconColor}><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>;
    case "error":
      return <svg {...common} className={TONE_STYLES[tone].iconColor}><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>;
    case "neutral":
      return <svg {...common} className={TONE_STYLES[tone].iconColor}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>;
    default:
      return <svg {...common} className={TONE_STYLES[tone].iconColor}><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z" /></svg>;
  }
}

export function Callout({
  tone = "info",
  children,
  className = "",
}: {
  tone?: CalloutTone;
  children: ReactNode;
  className?: string;
}) {
  const style = TONE_STYLES[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`anim-fade-in flex items-start gap-2.5 rounded-xl border p-4 text-sm leading-6 ${style.box} ${className}`}
    >
      <span className="mt-0.5 shrink-0">
        <ToneIcon tone={tone} />
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
