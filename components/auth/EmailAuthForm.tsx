"use client";

import { useEffect, useState } from "react";
import { signInWithEmail, signUpWithEmail, resetPassword, traduireErreurAuth, establishSession, readNextRedirect, type SignupProfile } from "@/lib/firebase/auth-client";

const inputClasses = "w-full rounded-xl border px-4 py-3 text-sm outline-none transition focus:border-[var(--g3-border)] bg-transparent";
const buttonClasses = "w-full rounded-xl bg-[var(--g3-deep)] px-4 py-3 text-sm font-medium text-white transition hover:bg-[var(--g3-elevated)] disabled:cursor-not-allowed disabled:opacity-50";

type Mode = "connexion" | "inscription";

export default function EmailAuthForm() {
  const [mode, setMode] = useState<Mode>("connexion");
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

  useEffect(() => { setNextPath(readNextRedirect()); }, []);

  function validate(): string | null {
    if (!email.trim() || !email.includes("@")) return "Veuillez saisir une adresse email valide.";
    if (password.length < 6) return "Le mot de passe doit contenir au moins 6 caracteres.";
    if (mode === "inscription") {
      if (!firstName.trim() || !lastName.trim()) return "Le prenom et le nom sont obligatoires.";
      if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username.trim())) return "Choisissez un nom d'utilisateur de 3 a 32 caracteres.";
      if (password !== confirmPassword) return "Les deux mots de passe ne correspondent pas.";
    }
    return null;
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault(); setError(null); setInfo(null);
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setPending(true);
    try {
      if (mode === "inscription") {
        const profile: SignupProfile = { firstName, lastName, username, country, language: "fr", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
        const user = await signUpWithEmail(email, password, profile);
        await establishSession(user, nextPath);
      } else {
        const user = await signInWithEmail(email, password);
        await establishSession(user, nextPath);
      }
    } catch (authError) { setError(traduireErreurAuth(authError)); } finally { setPending(false); }
  }

  async function handleReset(event: React.MouseEvent) {
    event.preventDefault(); setError(null); setInfo(null);
    if (!email.trim() || !email.includes("@")) { setError("Saisissez votre adresse email, puis cliquez a nouveau sur le lien."); return; }
    setPending(true);
    try { await resetPassword(email); setInfo("Email de reinitialisation envoye. Consultez votre boite de reception (et vos spams)."); }
    catch (resetError) { setError(traduireErreurAuth(resetError)); }
    finally { setPending(false); }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 rounded-xl border p-1 text-sm">
        <button type="button" onClick={() => { setMode("connexion"); setError(null); }} className={mode === "connexion" ? "rounded-lg bg-[var(--g3-deep)] px-3 py-2 font-medium text-white" : "rounded-lg px-3 py-2 font-medium opacity-70"}>Se connecter</button>
        <button type="button" onClick={() => { setMode("inscription"); setError(null); }} className={mode === "inscription" ? "rounded-lg bg-[var(--g3-deep)] px-3 py-2 font-medium text-white" : "rounded-lg px-3 py-2 font-medium opacity-70"}>S&apos;inscrire</button>
      </div>

      {mode === "inscription" && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input className={inputClasses} placeholder="Prenom" value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" required />
            <input className={inputClasses} placeholder="Nom" value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="family-name" required />
          </div>
          <input className={inputClasses} placeholder="Nom d'utilisateur" value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} autoComplete="username" required maxLength={32} />
          <input className={inputClasses} placeholder="Pays (optionnel)" value={country} onChange={(e) => setCountry(e.target.value)} autoComplete="country-name" />
          <p className="text-xs opacity-50">Tu pourras completer ton profil plus tard depuis ton tableau de bord.</p>
        </>
      )}

      <input type="email" placeholder="Adresse email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required className={inputClasses} />
      <input type="password" placeholder="Mot de passe" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "inscription" ? "new-password" : "current-password"} required minLength={6} className={inputClasses} />
      {mode === "inscription" && <input type="password" placeholder="Confirmer le mot de passe" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" required minLength={6} className={inputClasses} />}
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {info && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{info}</p>}
      <button type="submit" disabled={pending} className={buttonClasses}>{pending ? "Creation du profil..." : mode === "connexion" ? "Se connecter" : "Creer mon compte"}</button>
      {mode === "connexion" && <a href="#" onClick={handleReset} className="text-center text-xs opacity-60 hover:opacity-100">Mot de passe oublie ?</a>}
    </form>
  );
}
