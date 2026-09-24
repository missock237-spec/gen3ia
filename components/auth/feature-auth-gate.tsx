"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/firebase/auth-client";

interface FeatureAuthGateProps {
  children: ReactNode;
  feature: string;
  description: string;
}

interface ServerSessionUser {
  uid: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

const ServerSessionUserContext = createContext<ServerSessionUser | null>(null);

/**
 * Utilisateur issu du cookie de session serveur : disponible meme lorsque
 * l'etat Firebase client n'a pas pu etre restaure (webviews mobiles,
 * stockage bloque). Rendu null si aucune session serveur n'existe.
 */
export function useServerSessionUser(): ServerSessionUser | null {
  return useContext(ServerSessionUserContext);
}

/**
 * Verifie la session serveur via le cookie signe (GET /api/auth/session).
 * Retourne null tant que la reponse n'est pas connue.
 */
function useServerSession(enabled: boolean): { user: ServerSessionUser | null; checking: boolean } {
  const [state, setState] = useState<{ user: ServerSessionUser | null; checking: boolean }>({
    user: null,
    checking: enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (!response.ok) throw new Error("Pas de session serveur.");
        const body = (await response.json()) as { authenticated: boolean; user?: ServerSessionUser };
        if (!cancelled && body?.authenticated && body.user) {
          setState({ user: body.user, checking: false });
        }
      } catch {
        /* pas de session serveur : la page protegee affichera le portail */
      } finally {
        if (!cancelled) setState((previous) => ({ ...previous, checking: false }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return state;
}

export function FeatureAuthGate({ children, feature, description }: FeatureAuthGateProps) {
  const { user, loading } = useAuth();
  const { user: serverUser, checking } = useServerSession(!loading && !user);

  if (loading || checking) {
    return (
      <div className="min-h-full bg-[var(--g3-bg)] p-8 text-[var(--g3-text)]">
        <div className="mx-auto flex min-h-[60vh] max-w-md items-center justify-center">
          <div className="w-full rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--g3-border)] border-t-sky-500" />
            <p className="mt-4 text-sm text-[var(--g3-muted)]">Vérification de votre session…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!user && !serverUser) {
    return (
      <div className="min-h-full bg-[var(--g3-bg)] p-5 text-[var(--g3-text)] md:p-8">
        <div className="mx-auto flex min-h-[70vh] max-w-lg items-center justify-center">
          <section className="anim-scale-in w-full rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-sky-100 text-2xl">🔐</div>
            <p className="mt-5 text-xs font-semibold uppercase tracking-[.25em] text-sky-600">Gen3ia · accès protégé</p>
            <h1 className="mt-3 font-serif text-2xl font-semibold">{feature}</h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[var(--g3-muted)]">{description}</p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Link href="/login" className="g3-btn g3-btn-primary rounded-full">Se connecter</Link>
              <Link href="/signup" className="g3-btn g3-btn-ghost rounded-full">Créer un compte</Link>
            </div>
            <p className="mt-5 text-xs text-[var(--g3-faint)]">Vos agents, extensions, sessions Live et données d’équipe restent associées à votre compte.</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <ServerSessionUserContext.Provider value={user ? null : serverUser}>
      {children}
    </ServerSessionUserContext.Provider>
  );
}
