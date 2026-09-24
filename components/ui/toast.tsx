"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Système de toasts Gen3ia — remplace les `window.alert()` par des
 * notifications non bloquantes, accessibles (role="status" / "alert"),
 * empilées en haut à droite, avec barre de progression et fermeture
 * manuelle. Les erreurs de formulaires restent inline (sous le champ) :
 * les toasts servent aux confirmations et aux échecs globaux.
 */

export type ToastVariant = "success" | "error" | "info";

export interface ToastOptions {
  /** Identifiant stable (remplace un toast identique au lieu d'empiler). */
  id?: string;
  /** Durée d'affichage en ms (défaut : 5000, erreurs : 7000). */
  durationMs?: number;
}

interface ToastItem {
  id: string;
  variant: ToastVariant;
  message: string;
  /** Secondes de vie affichées par la barre de progression. */
  durationMs: number;
  createdAt: number;
}

interface ToastContextValue {
  toast: (message: string, variant?: ToastVariant, options?: ToastOptions) => string;
  success: (message: string, options?: ToastOptions) => string;
  error: (message: string, options?: ToastOptions) => string;
  info: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Record<ToastVariant, { border: string; icon: string; bar: string }> = {
  success: { border: "border-l-emerald-500", icon: "✓", bar: "bg-emerald-500" },
  error: { border: "border-l-red-500", icon: "!", bar: "bg-red-500" },
  info: { border: "border-l-neutral-900", icon: "✦", bar: "bg-[var(--g3-deep)]" },
};

const ARIA_LIVE: Record<ToastVariant, "polite" | "assertive"> = {
  success: "polite",
  info: "polite",
  error: "assertive",
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timers = timersRef.current;
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, variant: ToastVariant = "info", options?: ToastOptions) => {
      const id = options?.id ?? `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const durationMs = Math.max(1500, options?.durationMs ?? (variant === "error" ? 7000 : 5000));
      setToasts((current) => {
        // Un toast du même id remplace l'ancien (pas de pile dupliquée).
        const others = current.filter((item) => item.id !== id);
        return [...others.slice(-3), { id, variant, message, durationMs, createdAt: Date.now() }];
      });
      const timer = setTimeout(() => dismiss(id), durationMs);
      timersRef.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (message, options) => toast(message, "success", options),
      error: (message, options) => toast(message, "error", options),
      info: (message, options) => toast(message, "info", options),
      dismiss,
    }),
    [toast, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed right-3 top-3 z-[120] flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2"
        aria-label="Notifications"
      >
        {toasts.map((item) => {
          const styles = VARIANT_STYLES[item.variant];
          return (
            <div
              key={item.id}
              role={item.variant === "error" ? "alert" : "status"}
              aria-live={ARIA_LIVE[item.variant]}
              className={`g3-card pointer-events-auto animate-[toast-in_.25s_ease-out] !p-0 ${styles.border} overflow-hidden border-l-4 shadow-lg`}
            >
              <div className="flex items-start gap-2.5 px-3.5 py-3">
                <span
                  aria-hidden
                  className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold text-white ${styles.bar}`}
                >
                  {styles.icon}
                </span>
                <p className="min-w-0 flex-1 text-[13px] leading-snug text-[var(--g3-text)]">{item.message}</p>
                <button
                  type="button"
                  onClick={() => dismiss(item.id)}
                  className="shrink-0 rounded p-0.5 text-[var(--g3-faint)] transition-colors hover:text-[var(--g3-text-secondary)]"
                  aria-label="Fermer la notification"
                >
                  ✕
                </button>
              </div>
              <div
                className={`h-0.5 origin-left ${styles.bar}`}
                style={{
                  animation: `toast-bar ${item.durationMs}ms linear forwards`,
                }}
              />
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

/** Accès aux toasts — doit être utilisé sous un ToastProvider. */
export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    // Repli silencieux : l'application ne doit jamais planter faute de provider.
    return {
      toast: () => "",
      success: () => "",
      error: () => "",
      info: () => "",
      dismiss: () => {},
    };
  }
  return context;
}
