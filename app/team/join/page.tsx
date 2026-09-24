"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useAuth } from "@/lib/firebase/auth-client";
import { useTeam, type TeamInvitation } from "@/lib/team/useTeam";

/**
 * Acceptation d'une invitation d'équipe via /team/join?token=…
 * Les données passent par l'API serveur (/api/teams/invite + /api/teams/accept).
 * Gère proprement : utilisateur non connecté, invitation introuvable,
 * expirée, déjà utilisée, erreurs et redirection vers l'espace équipe.
 */

type JoinStatus = "loading" | "ready" | "joining" | "joined" | "notfound" | "error";

function JoinTeamFallback() {
  return (
    <div className="grid min-h-full place-items-center bg-[var(--g3-bg)]">
      <p className="text-sm text-[var(--g3-muted)]">Chargement…</p>
    </div>
  );
}

export default function JoinTeamPageRoot() {
  return (
    <Suspense fallback={<JoinTeamFallback />}>
      <JoinTeamContent />
    </Suspense>
  );
}

function JoinTeamContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const { user, loading: authLoading } = useAuth();
  const { acceptInvitation } = useTeam();
  const router = useRouter();
  const [invitation, setInvitation] = useState<TeamInvitation | null>(null);
  const [status, setStatus] = useState<JoinStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!token) {
      setStatus("notfound");
      return;
    }
    if (!user) {
      // Non connecté : la porte de connexion s'affiche, pas de requête API.
      setStatus("loading");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`/api/teams/invite?token=${encodeURIComponent(token)}`, { cache: "no-store" });
        const body = (await response.json().catch(() => ({}))) as { invitation?: TeamInvitation; error?: string };
        if (cancelled) return;
        if (!response.ok || !body.invitation) {
          setStatus("notfound");
          setErrorMessage(body.error ?? "Ce lien n'est plus valable : l&apos;invitation a peut-être déjà été utilisée ou a expiré.");
          return;
        }
        if (!body.invitation.valid) {
          setStatus("notfound");
          setErrorMessage(
            body.invitation.status === "accepted"
              ? "Cette invitation a déjà été utilisée."
              : "Cette invitation a expiré. Demandez une nouvelle invitation au propriétaire de l&apos;équipe.",
          );
          return;
        }
        setInvitation(body.invitation);
        setStatus("ready");
      } catch {
        if (!cancelled) {
          setStatus("error");
          setErrorMessage("Impossible de vérifier l'invitation (connexion au serveur impossible). Réessayez.");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token, user, authLoading]);

  const handleJoin = async () => {
    if (!token || status !== "ready") return;
    setStatus("joining");
    setErrorMessage(null);
    try {
      const teamId = await acceptInvitation(token);
      setStatus("joined");
      router.replace(`/team/${teamId}`);
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Impossible de rejoindre l’équipe.");
    }
  };

  // Non connecté : porte d'entrée claire vers la connexion (avant tout spinner).
  if (!authLoading && !user) {
    const nextUrl = token ? `/team/join?token=${encodeURIComponent(token)}` : "/team";
    return (
      <div className="grid min-h-full place-items-center bg-[var(--g3-bg)] px-4">
        <div className="anim-scale-in w-full max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-sky-100 text-2xl">✉️</div>
          <h1 className="mt-5 font-serif text-2xl font-semibold text-[var(--g3-text)]">Invitation d&apos;équipe</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--g3-muted)]">
            Connectez-vous avec le compte invité pour rejoindre l’équipe. Vous serez
            redirigé automatiquement vers l’invitation après la connexion.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link href={`/login?next=${encodeURIComponent(nextUrl)}`} className="g3-btn g3-btn-primary rounded-full">
              Se connecter
            </Link>
            <Link href={`/signup?next=${encodeURIComponent(nextUrl)}`} className="g3-btn g3-btn-ghost rounded-full">
              Créer un compte
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (authLoading || status === "loading" || status === "joining") {
    return (
      <div className="grid min-h-full place-items-center bg-[var(--g3-bg)] px-4">
        <div className="w-full max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-[var(--g3-border)] border-t-sky-500" />
          <p className="mt-4 text-sm text-[var(--g3-muted)]">
            {status === "joining" ? "Adhésion à l'équipe…" : "Vérification de l'invitation…"}
          </p>
        </div>
      </div>
    );
  }

  // Invitation introuvable / expirée / déjà utilisée.
  if (status === "notfound") {
    return (
      <div className="grid min-h-full place-items-center bg-[var(--g3-bg)] px-4">
        <div className="anim-scale-in w-full max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-100 text-2xl">⏳</div>
          <h1 className="mt-5 font-serif text-2xl font-semibold text-[var(--g3-text)]">
            Invitation invalide ou expirée
          </h1>
          <p className="mt-3 text-sm leading-6 text-[var(--g3-muted)]">{errorMessage}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Link href="/team" className="g3-btn g3-btn-primary rounded-full">Aller à mes équipes</Link>
            <Link href="/dashboard" className="g3-btn g3-btn-ghost rounded-full">Tableau de bord</Link>
          </div>
        </div>
      </div>
    );
  }

  // Erreur technique ou échec d'acceptation.
  if (status === "error") {
    return (
      <div className="grid min-h-full place-items-center bg-[var(--g3-bg)] px-4">
        <div className="anim-scale-in w-full max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-red-100 text-2xl">⚠️</div>
          <h1 className="mt-5 font-serif text-2xl font-semibold text-[var(--g3-text)]">Une erreur est survenue</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--g3-muted)]">{errorMessage}</p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button type="button" onClick={() => window.location.reload()} className="g3-btn g3-btn-primary rounded-full">
              Réessayer
            </button>
            <Link href="/team" className="g3-btn g3-btn-ghost rounded-full">Mes équipes</Link>
          </div>
        </div>
      </div>
    );
  }

  if (status === "joined") {
    return (
      <div className="grid min-h-full place-items-center bg-[var(--g3-bg)] px-4">
        <div className="anim-scale-in w-full max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-100 text-2xl">🎉</div>
          <h1 className="mt-5 font-serif text-2xl font-semibold text-[var(--g3-text)]">Vous avez rejoint l&apos;équipe !</h1>
          <p className="mt-3 text-sm text-[var(--g3-muted)]">Redirection vers l&apos;espace de l&apos;équipe…</p>
        </div>
      </div>
    );
  }

  // Prêt : récapitulatif de l'invitation.
  return (
    <div className="grid min-h-full place-items-center bg-[var(--g3-bg)] px-4">
      <div className="anim-scale-in w-full max-w-md rounded-3xl border border-[rgba(23,23,20,0.09)] bg-[var(--g3-surface)] p-8 text-center shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-sky-100 font-serif text-xl font-semibold text-sky-700">
          {invitation?.teamName?.charAt(0).toUpperCase() || "G"}
        </div>
        <p className="mt-5 text-xs font-bold uppercase tracking-[.25em] text-[var(--g3-faint)]">Invitation Gen3ia</p>
        <h1 className="mt-3 font-serif text-3xl font-semibold text-[var(--g3-text)]">
          {invitation?.teamName || "Une équipe"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--g3-muted)]">
          {invitation?.invitedBy?.displayName
            ? `${invitation.invitedBy.displayName} vous invite à rejoindre cette équipe.`
            : "Vous êtes invité à rejoindre cette équipe."}
        </p>
        <span className="mt-4 inline-block rounded-full bg-[var(--g3-elevated)] px-4 py-1.5 text-xs font-semibold capitalize text-[var(--g3-muted)]">
          Rôle proposé : {invitation?.role}
        </span>
        <button
          type="button"
          onClick={handleJoin}
          className="g3-btn g3-btn-primary mt-6 w-full rounded-full"
        >
          Accepter et rejoindre
        </button>
      </div>
    </div>
  );
}
