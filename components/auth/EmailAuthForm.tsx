"use client";

import { useEffect, useState } from "react";

import {
  confirmR2PasswordReset,
  readNextRedirect,
  requestR2PasswordReset,
  signInWithR2,
  signUpWithR2,
} from "@/lib/auth/r2-auth-client";

/**
 * Task 151 — formulaire e-mail / mot de passe sur les COMPTES NATIFS R2.
 *
 * Les identifiants sont vérifiés par le serveur contre les comptes stockés
 * dans R2 (POST /api/auth/r2/signup et /api/auth/r2/login) : plus aucune
 * dépendance à la configuration Firebase (domaines autorisés, fournisseur
 * e-mail activé) — l'authentification fonctionne telle quelle sur tous les
 * domaines de déploiement. La session est posée par le cookie signé
 * `gen3ia_session`, reconnu par toute la plateforme.
 *
 * Mode « reset » : arrivée depuis un e-mail de réinitialisation
 * (/login?reset=<jeton>) — choix d'un nouveau mot de passe (usage unique,
 * 30 min de validité).
 */

const inputClasses = "w-full rounded-xl border px-4 py-3 text-sm outline-none transition focus:border-[var(--g3-border)] bg-transparent";
const buttonClasses = "w-full rounded-xl bg-[var(--g3-deep)] px-4 py-3 text-sm font-medium text-white transition hover:bg-[var(--g3-elevated)] disabled:cursor-not-allowed disabled:opacity-50";

type Mode = "connexion" | "inscription" | "reset";

const MIN_PASSWORD = 8;

function lireJetonReset(): string | null {
  if (typeof window === "undefined") return null;
  const token = new URLSearchParams(window.location.search).get("reset");
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function effacerJetonReset(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("reset");
    window.history.replaceState(null, "", url.pathname + (url.search || ""));
  } catch {
    // jamais bloquant
  }
}

export default function EmailAuthForm() {
  const [mode, setMode] = useState<Mode>("connexion");
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [username, setUsername] = useState("");
  const [country, setCountry] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [nextPath, setNextPath] = useState<string | null>(null);

  useEffect(() => {
    setNextPath(readNextRedirect());
    const token = lireJetonReset();
    if (token) {
      setResetToken(token);
      setMode("reset");
    }
  }, []);

  function validate(): string | null {
    if (!email.trim() || !email.includes("@")) return "Veuillez saisir une adresse e-mail valide.";
    if (password.length < MIN_PASSWORD) return `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`;
    if (mode === "inscription") {
      if (!firstName.trim() || !lastName.trim()) return "Le prénom et le nom sont obligatoires.";
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username.trim())) return "Choisissez un nom d'utilisateur de 3 à 32 caractères.";
      if (password !== confirmPassword) return "Les deux mots de passe ne correspondent pas.";
    }
    if (mode === "reset" && password !== confirmPassword) return "Les deux mots de passe ne correspondent pas.";
    return null;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault(); setError(null); setInfo(null);
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setPending(true);
    try {
      if (mode === "inscription") {
        await signUpWithR2(
          {
            email,
            password,
            firstName,
            lastName,
            username,
            country: country || undefined,
            language: "fr",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          },
          nextPath,
        );
      } else if (mode === "connexion") {
        await signInWithR2(email, password, nextPath);
      } else if (mode === "reset" && resetToken) {
        const message = await confirmR2PasswordReset(resetToken, password);
        setResetToken(null);
        effacerJetonReset();
        setMode("connexion");
        setInfo(message);
      }
    } catch (authError) {
      setError(authError instanceof Error && authError.message ? authError.message : "Une erreur inattendue s'est produite. Veuillez réessayer.");
    } finally { setPending(false); }
  }

  async function handleReset(event: React.MouseEvent) {
    event.preventDefault(); setError(null); setInfo(null);
    if (!email.trim() || !email.includes("@")) { setError("Saisissez votre adresse e-mail, puis cliquez à nouveau sur le lien."); return; }
    setPending(true);
    try {
      const message = await requestR2PasswordReset(email);
      setInfo(message);
    } catch (resetError) {
      setError(resetError instanceof Error && resetError.message ? resetError.message : "La demande a échoué. Réessayez dans un instant.");
    } finally { setPending(false); }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {mode === "reset" ? (
        <div className="rounded-xl border border-[var(--g3-primary-soft)] bg-[var(--g3-primary-soft)] px-4 py-3 text-sm">
          Choisissez un nouveau mot de passe pour finaliser la réinitialisation de votre compte.
        </div>
      ) : (
        <div className="grid grid-cols-2 rounded-xl border p-1 text-sm">
          <button type="button" onClick={() => { setMode("connexion"); setError(null); }} className={mode === "connexion" ? "rounded-lg bg-[var(--g3-deep)] px-3 py-2 font-medium text-white" : "rounded-lg px-3 py-2 font-medium opacity-70"}>Se connecter</button>
          <button type="button" onClick={() => { setMode("inscription"); setError(null); }} className={mode === "inscription" ? "rounded-lg bg-[var(--g3-deep)] px-3 py-2 font-medium text-white" : "rounded-lg px-3 py-2 font-medium opacity-70"}>S&apos;inscrire</button>
        </div>
      )}

      {mode === "inscription" && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input className={inputClasses} placeholder="Prénom" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
            <input className={inputClasses} placeholder="Nom" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required />
          </div>
          <input className={inputClasses} placeholder="Nom d'utilisateur" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} autoComplete="username" required maxLength={32} />
          <input className={inputClasses} placeholder="Pays (optionnel)" value={country} onChange={(e) => setCountry(e.target.value)} autoComplete="country-name" />
          <p className="text-xs opacity-50">Vous pourrez compléter votre profil plus tard depuis votre tableau de bord.</p>
        </>
      )}

      {mode !== "reset" && (
        <input type="email" placeholder="Adresse e-mail" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required className={inputClasses} />
      )}
      <input type="password" placeholder={mode === "reset" ? "Nouveau mot de passe" : "Mot de passe"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "connexion" ? "current-password" : "new-password"} required minLength={MIN_PASSWORD} className={inputClasses} />
      {(mode === "inscription" || mode === "reset") && <input type="password" placeholder="Confirmer le mot de passe" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required minLength={MIN_PASSWORD} className={inputClasses} />}
      {error && <p role="alert" className="rounded-xl border border-[var(--g3-danger-soft)] bg-[var(--g3-danger-soft)] px-4 py-3 text-sm text-[var(--g3-danger-strong)]">{error}</p>}
      {info && <p role="status" className="rounded-xl border border-[var(--g3-success-soft)] bg-[var(--g3-success-soft)] px-4 py-3 text-sm text-[var(--g3-success-strong)]">{info}</p>}
      {/* Libellé conditionnel au mode : une CONNEXION n'a jamais « créé de profil » (audit UX 2-c). */}
      <button type="submit" disabled={pending} className={buttonClasses}>
        {pending
          ? (mode === "connexion" ? "Connexion…" : mode === "inscription" ? "Création du profil…" : "Modification…")
          : mode === "connexion" ? "Se connecter" : mode === "inscription" ? "Créer mon compte" : "Définir mon nouveau mot de passe"}
      </button>
      {mode === "reset" ? (
        <button type="button" onClick={() => { setMode("connexion"); setError(null); setInfo(null); effacerJetonReset(); }} className="text-center text-xs opacity-60 hover:opacity-100">Revenir à la connexion</button>
      ) : null}
      {mode === "connexion" && (
        <button type="button" onClick={handleReset} className="text-center text-xs opacity-60 hover:opacity-100">Mot de passe oublié ?</button>
      )}
    </form>
  );
}
