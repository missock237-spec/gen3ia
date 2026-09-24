import { cx } from "@/lib/ui/cx";

/**
 * Badge Gen3ia — étiquettes d'état (tokens soft par sémantique).
 */
export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

const TONE_STYLES: Record<BadgeTone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: "var(--g3-elevated)", fg: "var(--g3-muted)", border: "var(--g3-border)" },
  primary: { bg: "var(--g3-primary-soft)", fg: "var(--g3-primary-strong)", border: "transparent" },
  info: { bg: "var(--g3-secondary-soft)", fg: "var(--g3-secondary)", border: "transparent" },
  success: { bg: "var(--g3-success-soft)", fg: "var(--g3-success-strong)", border: "transparent" },
  warning: { bg: "var(--g3-warning-soft)", fg: "var(--g3-warning-strong)", border: "transparent" },
  danger: { bg: "var(--g3-danger-soft)", fg: "var(--g3-danger-strong)", border: "transparent" },
};

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  const t = TONE_STYLES[tone];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold leading-4",
        className,
      )}
      style={{ background: t.bg, color: t.fg, border: `1px solid ${t.border}` }}
    >
      {children}
    </span>
  );
}

/** Point de statut coloré (petit disque + halo). */
export function StatusDot({ tone = "neutral" }: { tone?: BadgeTone }) {
  const colors: Record<BadgeTone, string> = {
    neutral: "var(--g3-faint)",
    primary: "var(--g3-primary)",
    info: "var(--g3-secondary)",
    success: "var(--g3-success)",
    warning: "var(--g3-warning)",
    danger: "var(--g3-danger)",
  };
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: colors[tone], boxShadow: `0 0 0 3px color-mix(in srgb, ${colors[tone]} 20%, transparent)` }}
    />
  );
}
