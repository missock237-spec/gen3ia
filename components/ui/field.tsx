import { forwardRef } from "react";

import { cx } from "@/lib/ui/cx";

/** Champ de formulaire Gen3ia — label + contrôle + hint, tokens --g3-*. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("space-y-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-bold uppercase tracking-[0.08em]"
        style={{ color: "var(--g3-muted)" }}
      >
        {label}
      </label>
      {children}
      {hint && !error && (
        <p className="text-[11px] leading-4" style={{ color: "var(--g3-faint)" }}>
          {hint}
        </p>
      )}
      {error && (
        <p className="text-[11px] font-semibold leading-4" style={{ color: "var(--g3-danger-strong)" }} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL_CLASS =
  "g3-input";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(CONTROL_CLASS, className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx("g3-textarea", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cx("g3-select", className)} {...rest}>
        {children}
      </select>
    );
  },
);
