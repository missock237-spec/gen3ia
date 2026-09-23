"use client";

import { useEffect, useState } from "react";

import {
  completerConnexionRedirect,
  establishSession,
  readNextRedirect,
  signInWithGoogle,
  signInWithGitHub,
  traduireErreurAuth
} from "@/lib/firebase/auth-client";
import { useToast } from "@/components/ui/toast";

function GoogleLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" className="shrink-0">
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z" />
      <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
    </svg>
  );
}

function GitHubLogo() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="18" height="18" fill="currentColor" className="shrink-0">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function AuthButtons() {
  const toast = useToast();
  // Connexion par redirection (mobile) : au retour du flux OAuth sur /login,
  // on recupere le resultat et on etablit la session serveur.
  const [nextPath, setNextPath] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState("");
  useEffect(() => { setNextPath(readNextRedirect()); }, []);
  useEffect(() => {
    completerConnexionRedirect(nextPath).catch((error) => {
      const message = traduireErreurAuth(error);
      setInlineError(message);
      toast.error(message);
    });
  }, [nextPath, toast]);

  async function authenticate(
    provider: "google" | "github"
  ) {
    setInlineError("");
    try {
      const user =
        provider === "google"
          ? await signInWithGoogle()
          : await signInWithGitHub();

      // Sur mobile, signInWith* redirige : on n'arrive jamais ici.
      await establishSession(user, nextPath);
    } catch (error) {
      // La redirection mobile est un flux normal, pas une erreur a afficher.
      if (error instanceof Error && error.message === "REDIRECTION_EN_COURS") {
        return;
      }
      const message = traduireErreurAuth(error);
      setInlineError(message);
      toast.error(message);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {inlineError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] leading-snug text-red-700" role="alert">
          {inlineError}
        </p>
      )}
      {/* Bouton conforme a l'identite Google : fond blanc, bordure #dadce0,
          logo G multicolore et texte #3c4043. */}
      <button
        type="button"
        onClick={() => authenticate("google")}
        className="flex w-full items-center justify-center gap-3 rounded-xl border border-[#dadce0] bg-white px-4 py-3 text-sm font-medium text-[#3c4043] transition hover:bg-[#f8f9fa] hover:shadow-sm"
      >
        <GoogleLogo />
        Continuer avec Google
      </button>

      {/* Bouton conforme a l'identite GitHub : fond #24292f, octocat blanc,
          texte blanc. */}
      <button
        type="button"
        onClick={() => authenticate("github")}
        className="flex w-full items-center justify-center gap-3 rounded-xl border border-[#24292f] bg-[#24292f] px-4 py-3 text-sm font-medium text-white transition hover:bg-[#32383f]"
      >
        <GitHubLogo />
        Continuer avec GitHub
      </button>
    </div>
  );
}
