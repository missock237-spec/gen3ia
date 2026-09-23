import AuthButtons from "@/components/auth/AuthButtons";
import EmailAuthForm from "@/components/auth/EmailAuthForm";

/**
 * Route /signup : alias de /login pour les liens "Creer un compte".
 * Le formulaire integre les onglets Se connecter / S'inscrire.
 */
export default function SignupPage() {
  return (
    <div className="min-h-full bg-[var(--g3-bg)] flex items-center justify-center p-6">
      <section className="w-full max-w-md">
        <div className="mb-8">
          <h1 className="font-serif text-3xl font-semibold text-neutral-900">
            Bienvenue sur Gen3ia
          </h1>

          <p className="mt-2 text-sm text-neutral-600">
            Creez des agents IA autonomes, des workflows et des applications.
          </p>
        </div>

        <div className="rounded-3xl border border-[var(--g3-border)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <EmailAuthForm />

          <div className="my-6 flex items-center gap-3 text-xs text-neutral-500">
            <span className="h-px flex-1 bg-current" />
            ou continuer avec
            <span className="h-px flex-1 bg-current" />
          </div>

          <AuthButtons />
        </div>
      </section>
    </div>
  );
}
