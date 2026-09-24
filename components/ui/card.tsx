import { cx } from "@/lib/ui/cx";

/**
 * Carte Gen3ia — surface standard du design system (tokens --g3-*).
 */
export function Card({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("g3-card", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cx("border-b px-5 py-4", className)} style={{ borderColor: "var(--g3-border)" }}>{children}</div>;
}

export function CardTitle({ className, children }: { className?: string; children: React.ReactNode }) {
  return <h3 className={cx("text-sm font-bold tracking-tight", className)} style={{ color: "var(--g3-text)" }}>{children}</h3>;
}

export function CardDescription({ className, children }: { className?: string; children: React.ReactNode }) {
  return <p className={cx("mt-1 text-xs leading-5", className)} style={{ color: "var(--g3-muted)" }}>{children}</p>;
}

export function CardBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cx("px-5 py-4", className)}>{children}</div>;
}

export function CardFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cx("border-t px-5 py-3.5", className)} style={{ borderColor: "var(--g3-border)" }}>{children}</div>;
}
