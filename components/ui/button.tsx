"use client";

import { forwardRef } from "react";

import { cx } from "@/lib/ui/cx";

/**
 * Bouton Gen3ia — primitive unique du design system.
 * Variantes alignées sur les tokens --g3-* (sombre et clair).
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "g3-btn-primary",
  secondary: "g3-btn-ghost",
  ghost: "g3-btn-ghost",
  danger: "g3-btn-danger",
  success: "g3-btn-success",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-xs rounded-lg",
  md: "",
  lg: "px-5 py-3 text-[15px] rounded-2xl",
  icon: "h-9 w-9 p-0 rounded-xl",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, className, disabled, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx("g3-btn", VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
      {...rest}
    >
      {loading ? (
        <span className="g3-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      ) : (
        children
      )}
    </button>
  );
});
