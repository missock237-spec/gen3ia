import React, { Component, ErrorInfo } from 'react';
import { captureException } from '@sentry/nextjs';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

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
    // Envoyer à Sentry
    captureException(error, {
      contexts: {
        react: {
          componentStack: errorInfo.componentStack,
        },
      },
    });
    
    // Callback custom
    this.props.onError?.(error, errorInfo);
  }

  componentDidUpdate(prevProps: Props) {
    // Reset si les resetKeys changent
    if (this.state.hasError && this.props.resetKeys) {
      const hasResetKeyChanged = this.props.resetKeys.some(
        (key, i) => prevProps.resetKeys?.[i] !== key
      );
      if (hasResetKeyChanged) {
        this.setState({ hasError: false, error: null });
      }
    }
  }

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

  reset = () => {
    this.setState({ hasError: false, error: null });
  };
}

// Fallback par défaut
function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] p-6 space-y-4">
      <AlertTriangle className="w-12 h-12 text-destructive" />
      <div className="text-center space-y-2">
        <h2 className="text-lg font-semibold">Une erreur est survenue</h2>
        <p className="text-sm text-muted-foreground">
          Nos équipes ont été notifiées. Veuillez réessayer.
        </p>
        <p className="text-xs font-mono bg-muted px-2 py-1 rounded">
          {error.message}
        </p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={reset}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
        >
          <RefreshCw className="w-4 h-4" />
          Réessayer
        </button>
        <a
          href="/"
          className="flex items-center gap-2 px-4 py-2 border rounded-md hover:bg-muted"
        >
          <Home className="w-4 h-4" />
          Retour à l'accueil
        </a>
      </div>
    </div>
  );
                       }
