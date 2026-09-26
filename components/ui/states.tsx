import { cx } from "@/lib/ui/cx";

/** Squelette de chargement Gen3ia (shimmer animé, tokens --g3-*). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cx("g3-skeleton rounded-xl", className)}
    />
  );
}

/** État vide Gen3ia : icône, titre, description, action réelle attendue. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
      style={{ color: "var(--g3-muted)" }}
    >
      {icon && (
        <div
          aria-hidden="true"
          className="flex h-12 w-12 items-center justify-center rounded-2xl text-xl"
          style={{ background: "var(--g3-primary-soft)", color: "var(--g3-primary-strong)" }}
        >
          {icon}
        </div>
      )}
      <div>
        <p className="text-sm font-bold" style={{ color: "var(--g3-text)" }}>
          {title}
        </p>
        {description && (
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5" style={{ color: "var(--g3-muted)" }}>
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
