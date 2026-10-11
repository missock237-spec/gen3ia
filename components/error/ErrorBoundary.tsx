"use client";

import Link from "next/link";
import React, { Component, type ErrorInfo } from "react";
import { captureException } from "@sentry/nextjs";

/**
 * ERROR BOUNDARY RÉUTILISABLE (intentions du commit 6069ca4, intégrées au
 * standard du projet).
 *
 * Correctif d'intégration (Task 127) : le module d'origine importait
 * `lucide-react` (non installé). Ici : icônes SVG inline (aucune dépendance
 * neuve), classes du design system Gen3ia (tokens g3-*, 2 couleurs), envoi
 * Sentry conservé, reset par clés conservé.
 *
 * Les boundaries ROUTES restent app/error.tsx + app/global-error.tsx (Next
 * natif) — ce composant sert aux sections encapsulées (ateliers, panneaux).
 */

interface Props {
  children: React.ReactNode;
  fallback?: React.ComponentType<{ error: Error; reset: () => void }>;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  resetKeys?: string[];
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    captureException(error, {
      contexts: { react: { componentStack: errorInfo.componentStack } },
    });
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && this.props.resetKeys) {
      const hasResetKeyChanged = this.props.resetKeys.some((key, i) => prevProps.resetKeys?.[i] !== key);
      if (hasResetKeyChanged) {
        this.setState({ hasError: false, error: null });
      }
    }
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        const Fallback = this.props.fallback;
        return <Fallback error={this.state.error!} reset={this.reset} />;
      }
      return <DefaultErrorFallback error={this.state.error!} reset={this.reset} />;
    }
    return this.props.children;
  }
}

/** Icône triangle d'alerte (SVG inline — tokens 2 couleurs du projet). */
function AlertTriangleIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--g3-primary-strong, currentColor)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

/** Fallback par défaut — style design system Gen3ia. */
function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-[200px] flex-col items-center justify-center gap-4 p-6" role="alert">
      <AlertTriangleIcon />
      <div className="space-y-1 text-center">
        <h2 className="text-lg font-semibold text-[var(--g3-text)]">Une erreur est survenue</h2>
        <p className="text-sm text-[var(--g3-muted)]">Nos équipes ont été notifiées. Veuillez réessayer.</p>
        <p className="rounded bg-[var(--g3-elevated)] px-2 py-1 font-mono text-xs text-[var(--g3-text-secondary)]">{error.message}</p>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-[var(--g3-primary)] px-4 py-2 text-sm font-medium text-[var(--g3-on-primary)] transition hover:opacity-90"
        >
          Réessayer
        </button>
        <Link
          href="/"
          className="rounded-md bg-[var(--g3-primary-soft)] px-4 py-2 text-sm font-medium text-[var(--g3-primary-strong)] transition hover:opacity-90"
        >
          Retour à l&apos;accueil
        </Link>
      </div>
    </div>
  );
}
