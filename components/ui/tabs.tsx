"use client";

import { cx } from "@/lib/ui/cx";

/**
 * Onglets Gen3ia — barre scrollable, indicateur par état aria-selected.
 * Compatible tactile (scroll horizontal) et clavier (focus visible).
 */
export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  badge?: number;
}

export function Tabs<T extends string = string>({
  items,
  active,
  onChange,
  className,
  ariaLabel = "Sections",
}: {
  items: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cx("no-scrollbar flex gap-1 overflow-x-auto rounded-xl border p-1", className)}
      style={{ borderColor: "var(--g3-border)", background: "var(--g3-surface)" }}
    >
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            className={cx(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
              selected ? "shadow-sm" : "",
            )}
            style={
              selected
                ? { background: "var(--g3-primary)", color: "var(--g3-on-primary)" }
                : { color: "var(--g3-muted)", background: "transparent" }
            }
          >
            {item.label}
            {typeof item.badge === "number" && item.badge > 0 && (
              <span
                className="rounded-full px-1.5 py-0.5 text-[10px] font-bold leading-none"
                style={{
                  background: selected ? "rgba(255,255,255,0.2)" : "var(--g3-primary-soft)",
                  color: selected ? "var(--g3-on-primary)" : "var(--g3-primary-strong)",
                }}
              >
                {item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
