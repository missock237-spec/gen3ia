import Link from "next/link";

import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";

/**
 * Panneau Aurora des pages d'authentification V2 : moitié gauche décorative
 * (espace profond, halos animés, promesse produit) — masquée sur mobile.
 *
 * a11y (axe aria-hidden-focus) : ce panneau contient un lien (retour accueil)
 * et du contenu produit réel — il ne doit PAS porter aria-hidden. Les
 * décorations (halos, grille) sont des divs vides : rien à masquer. Le
 * masquage mobile est naturel (hidden lg:flex).
 */
export function AuthAuroraAside() {
  return (
    <aside className="sky-hero relative hidden overflow-hidden border-r border-[var(--g3-border)] lg:flex lg:flex-col lg:justify-between lg:p-12">
      <div className="aurora" />
      <div className="aurora-glow" />
      <div className="grid-bg absolute inset-0" />

      {/* Marque */}
      <Link href="/" className="relative flex items-center gap-3">
        <Gen3iaLogo size={40} alt="" />
        <span className="font-[family-name:var(--font-display)] text-lg font-bold text-[var(--g3-text)]">Gen3ia</span>
      </Link>

      {/* Promesse */}
      <div className="relative max-w-md">
        <p className="g3-eyebrow">Interface V2 · Aurora</p>
        <h2 className="mt-4 font-[family-name:var(--font-display)] text-4xl font-bold leading-[1.1] text-[var(--g3-text)]">
          Décrivez-le. <span className="gradient-text">L&apos;agent l&apos;exécute.</span>
        </h2>
        <p className="mt-5 text-sm leading-7 text-[var(--g3-muted)]">
          Des agents IA autonomes qui planifient, exécutent et livrent —
          recherche, documents, images, 800+ applications connectées —
          avec la validation humaine au centre.
        </p>

        {/* Points de preuve */}
        <ul className="mt-8 space-y-3 text-sm text-[var(--g3-text-secondary)]">
          {[
            "Exécution réelle, résultat seul à l'écran",
            "Images ultra réalistes générées dans le chat",
            "Actions sensibles approuvables à distance",
          ].map((point) => (
            <li key={point} className="flex items-center gap-3">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--g3-success-soft)]">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--g3-success-strong)]">
                  <path d="m5 12 5 5L20 7" />
                </svg>
              </span>
              {point}
            </li>
          ))}
        </ul>
      </div>

      {/* Signature — a11y (axe color-contrast) : g3-faint échoue AA 4.5:1 sur
          le dégradé sky-hero ; g3-muted passe (≥ 5:1) tout en restant discret. */}
      <p className="relative font-[family-name:var(--font-display)] text-sm text-[var(--g3-muted)]">
        Créer <span className="mx-2 text-[var(--g3-muted)]">·</span> Exécuter <span className="mx-2 text-[var(--g3-muted)]">·</span> Grandir
      </p>
    </aside>
  );
}
