"use client";

import Link from "next/link";

import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";
import { MarketplaceHub } from "@/components/marketplace/marketplace-hub";
import { AGENT_TEMPLATES } from "@/lib/agents/templates";
import { useSessionAvailable } from "@/lib/firebase/auth-client";

/**
 * Section « Templates sectoriels » (Task 132) : grille sobre des six agents
 * métier prêts à l'emploi — nom, secteur, description courte et lien vers le
 * Studio avec `?template=<id>` (le branchement complet du paramètre côté
 * Studio est assuré par l'agent principal, hors périmètre Task 132).
 *
 * STYLE : strictement les tokens/classes des familles violet/cyan déjà
 * utilisées par le hub (var(--g3-*), ombres neutres) — identité 2 couleurs.
 */
function TemplatesSectoriels() {
  return (
    <section
      aria-labelledby="titre-templates-sectoriels"
      className="mx-auto max-w-[1480px] px-3 pb-10 sm:px-5 lg:px-7"
    >
      <div className="rounded-[30px] border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] sm:p-8">
        <div className="text-[10px] font-bold tracking-[.28em] text-[var(--g3-info)]">GEN3IA / TEMPLATES</div>
        <h2 id="titre-templates-sectoriels" className="mt-3 font-serif text-2xl font-bold tracking-tight">
          Templates sectoriels
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--g3-muted)]">
          Six agents métier prêts à l&apos;emploi : personnalité, outils autorisés et garde-fous préréglés pour votre
          secteur. Un clic vers le Studio pour les instancier et les personnaliser.
        </p>
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {AGENT_TEMPLATES.map((template) => (
            <article
              key={template.id}
              className="flex flex-col rounded-3xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] p-5 transition duration-200 hover:-translate-y-0.5 hover:border-[var(--g3-border)]"
            >
              <div className="flex items-start gap-3">
                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[var(--g3-secondary-soft)] text-xs font-bold text-[var(--g3-info)]">
                  {template.nom.trim().slice(0, 2).toUpperCase() || "G3"}
                </div>
                <div className="min-w-0">
                  <h3 className="truncate font-semibold">{template.nom}</h3>
                  <p className="mt-1 text-[11px] text-[var(--g3-faint)]">{template.secteur}</p>
                </div>
              </div>
              <p className="mt-4 line-clamp-3 min-h-[60px] text-sm leading-5 text-[var(--g3-muted)]">
                {template.description}
              </p>
              <div className="mt-auto flex items-center justify-between border-t border-[var(--g3-border)] pt-4">
                <span className="text-xs text-[var(--g3-faint)]">
                  {template.outilsAutorises.length} outils autorisés
                </span>
                <Link
                  href={`/studio?template=${template.id}`}
                  className="text-sm font-semibold text-[var(--g3-primary-strong)] hover:text-[var(--g3-primary-strong)]"
                >
                  Ouvrir dans le Studio →
                </Link>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function MarketplacePage() {
  // Session Firebase OU cookie de session serveur : l'une des deux suffit
  // pour parcourir, acheter et installer des extensions.
  const sessionDisponible = useSessionAvailable();

  if (sessionDisponible !== true) {
    return (
      <FeatureAuthGate
        feature="Marketplace Gen3ia"
        description="Connectez-vous pour découvrir, acheter, installer et gérer les extensions de vos agents."
      >
        <span />
      </FeatureAuthGate>
    );
  }

  return (
    <div className="min-h-full bg-[var(--g3-bg)]">
      <div className="mx-auto max-w-[1480px] px-3 pt-3 sm:px-5 lg:px-7">
      </div>
      <MarketplaceHub />
      <TemplatesSectoriels />
    </div>
  );
}
