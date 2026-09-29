import type { Metadata } from "next";
import Link from "next/link";

import { AdSenseAd } from "@/components/ads/adsense-ad";
import { VitrineHeader } from "@/components/home/vitrine-header";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";
import { FAQ_FR, SITE_URL } from "@/lib/geo/content";

/**
 * Page FAQ dédiée — surface GEO majeure.
 *
 * Une URL stable (gen3ia.online/faq) qui regroupe TOUTES les réponses
 * factuelles sur Gen3ia : c'est le format que les moteurs de réponse
 * (ChatGPT, Perplexity, Gemini, Google AI Overviews) citent le plus
 * volontiers quand un utilisateur demande « qu'est-ce que Gen3ia ? »,
 * « combien coûte Gen3ia ? »… Le JSON-LD FAQPage + BreadcrumbList et le
 * lien depuis llms.txt maximisent la probabilité de citation.
 */

const FAQ_URL = `${SITE_URL}/faq`;

export const metadata: Metadata = {
  title: "Questions fréquentes (FAQ)",
  description:
    "Tout savoir sur Gen3ia : agents IA autonomes, génération d'images, 800+ applications connectées, sécurité et validation humaine, tarifs à l'usage, appareils compatibles.",
  alternates: { canonical: "/faq" },
  openGraph: {
    type: "website",
    url: FAQ_URL,
    siteName: "Gen3ia",
    title: "Gen3ia — Questions fréquentes (FAQ)",
    description:
      "Qu'est-ce que Gen3ia ? Combien ça coûte ? Quelles applications sont connectées ? Toutes les réponses factuelles sur la plateforme d'agents IA autonomes.",
    locale: "fr_FR",
    images: [{ url: "/og-image.png", width: 1312, height: 736, alt: "Gen3ia — FAQ" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Gen3ia — Questions fréquentes (FAQ)",
    description: "Agents IA autonomes, images par IA, 800+ connecteurs, validation humaine : toutes les réponses.",
    images: ["/og-image.png"],
  },
};

/** JSON-LD : FAQPage (réponses citables) + BreadcrumbList (situation). */
const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "FAQPage",
      "@id": `${FAQ_URL}#faqpage`,
      url: FAQ_URL,
      inLanguage: "fr",
      isPartOf: { "@id": `${SITE_URL}/#website` },
      mainEntity: FAQ_FR.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Accueil", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "FAQ", item: FAQ_URL },
      ],
    },
  ],
};

export default function FaqPage() {
  return (
    <div className="g3-noise flex min-h-full flex-col bg-[var(--g3-bg)] text-[var(--g3-text)]">
      <VitrineHeader />

      <div className="flex-1">
        {/* ---------- Entête compact (halo aurora) ---------- */}
        <section className="sky-hero relative overflow-hidden">
          <div className="aurora" aria-hidden="true" />
          <div className="aurora-glow" aria-hidden="true" />
          <div className="relative mx-auto max-w-4xl px-4 pb-16 pt-20 sm:px-6 sm:pt-24">
            <nav aria-label="Fil d'Ariane" className="mb-8 text-xs text-[var(--g3-faint)]">
              <Link href="/" className="transition hover:text-[var(--g3-primary-strong)]">Accueil</Link>
              <span className="mx-2" aria-hidden>/</span>
              <span className="text-[var(--g3-muted)]">FAQ</span>
            </nav>
            <p className="g3-eyebrow">FAQ</p>
            <h1 className="mt-4 font-[family-name:var(--font-display)] text-4xl font-bold tracking-tight sm:text-6xl">
              Questions <span className="gradient-text">fréquentes</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-[var(--g3-text-secondary)]">
              Tout ce qu&apos;il faut savoir sur Gen3ia — les agents IA autonomes, la
              génération d&apos;images, les connecteurs, la sécurité et les tarifs —
              en réponses claires et factuelles.
            </p>
          </div>
        </section>

        {/* ---------- Réponses (details/summary : lisibles, citables, SSR) ---------- */}
        <section aria-label="Réponses aux questions fréquentes" className="mx-auto max-w-4xl px-4 pb-16 sm:px-6">
          <div className="space-y-3">
            {FAQ_FR.map((item, index) => (
              <details
                key={item.question}
                id={`faq-${index + 1}`}
                className="group rounded-2xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-5 backdrop-blur transition hover:border-[rgba(124,92,255,0.45)]"
                open={index === 0}
              >
                <summary className="cursor-pointer list-none font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--g3-text)] marker:hidden">
                  {item.question}
                </summary>
                <p className="mt-3 text-sm leading-7 text-[var(--g3-muted)]">{item.answer}</p>
              </details>
            ))}
          </div>

          {/* Recours croisé : le LLM (et l'utilisateur) trouve la version
              anglaise et la vitrine complète depuis la FAQ. */}
          <div className="mt-10 flex flex-col items-start justify-between gap-4 rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-deep)]/60 p-6 sm:flex-row sm:items-center">
            <p className="text-sm leading-6 text-[var(--g3-muted)]">
              Looking for this FAQ in <strong className="text-[var(--g3-text)]">English</strong> ?
              Une question reste sans réponse ? Testez la plateforme vous-même.
            </p>
            <div className="flex shrink-0 gap-2">
              <Link
                href="/en"
                hrefLang="en"
                className="rounded-full border border-[rgba(148,153,255,0.25)] bg-white/[0.04] px-5 py-2.5 text-sm font-medium text-[var(--g3-text-secondary)] transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
              >
                English version
              </Link>
              <Link
                href="/signup"
                className="rounded-full bg-[var(--g3-gradient)] bg-[length:160%_100%] px-5 py-2.5 text-sm font-semibold text-white shadow-[0_10px_28px_-10px_rgba(124,92,255,0.8)] transition hover:-translate-y-0.5 hover:brightness-110"
              >
                Commencer gratuitement
              </Link>
            </div>
          </div>
        </section>

        <AdSenseAd className="pb-12" />
      </div>

      {/* ---------- Pied de page compact ---------- */}
      <footer className="mt-auto border-t border-[var(--g3-border)] bg-[var(--g3-deep)]">
        <div className="rainbow-line" aria-hidden="true" />
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-10 sm:flex-row sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <Gen3iaLogo size={32} alt="" />
            <span className="font-[family-name:var(--font-display)] text-sm font-bold">Gen3ia</span>
          </Link>
          <nav aria-label="Pied de page FAQ" className="flex flex-wrap items-center justify-center gap-4 text-sm">
            <Link href="/studio" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Studio</Link>
            <Link href="/live" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Agent Live</Link>
            <Link href="/marketplace" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Marketplace</Link>
            <Link href="/privacy" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Confidentialité</Link>
          </nav>
          <p className="text-xs text-[var(--g3-faint)]">© {new Date().getFullYear()} Gen3ia AI Studio.</p>
        </div>
      </footer>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />
    </div>
  );
}
