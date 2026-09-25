import AuthButtons from "@/components/auth/AuthButtons";
import EmailAuthForm from "@/components/auth/EmailAuthForm";
import { AuthAuroraAside } from "@/components/auth/auth-aurora-aside";

/**
 * Route /signup : alias de /login pour les liens "Creer un compte".
 * V2 « Aurora OS » : split-screen premium, panneau aurora à gauche.
 * Le formulaire integre les onglets Se connecter / S'inscrire.
 */
export default function SignupPage() {
  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <AuthAuroraAside />

      <div className="relative flex items-center justify-center overflow-hidden p-6">
        <div className="aurora opacity-60" aria-hidden="true" />
        <section className="relative w-full max-w-md">
          <div className="mb-8">
            <p className="g3-eyebrow">Gen3ia · Interface V2</p>
            <h1 className="mt-3 font-[family-name:var(--font-display)] text-3xl font-bold text-[var(--g3-text)]">
              Créez votre compte
            </h1>
            <p className="mt-2 text-sm text-[var(--g3-muted)]">
              Une minute suffit : votre wallet de démonstration est crédité
              automatiquement pour tester la plateforme.
            </p>
          </div>

          <div className="g3-gradient-border p-6 shadow-[0_30px_90px_-40px_rgba(124,92,255,0.55)]">
            <EmailAuthForm />

            <div className="my-6 flex items-center gap-3 text-xs text-[var(--g3-faint)]">
              <span className="h-px flex-1 bg-[var(--g3-border)]" />
              ou continuer avec
              <span className="h-px flex-1 bg-[var(--g3-border)]" />
            </div>

            <AuthButtons />
          </div>

          <p className="mt-6 text-center text-xs text-[var(--g3-faint)]">
            Gratuit · Facturation à l&apos;usage (XAF / EUR) · Actions sensibles
            toujours validées par un humain.
          </p>
        </section>
      </div>
    </div>
  );
}
