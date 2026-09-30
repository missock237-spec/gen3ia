"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";
import { ThemeToggle } from "@/components/ui/theme-toggle";

/** Libellés du header selon la langue de la surface vitrine (FR par défaut). */
const LABELS = {
  fr: {
    nav: [
      { href: "#produits", label: "Produits" },
      { href: "#fonctionnement", label: "Fonctionnement" },
      { href: "#securite", label: "Sécurité" },
    ],
    faq: { href: "/faq", label: "FAQ" },
    login: "Se connecter",
    signup: "Commencer",
    homeAria: "Gen3ia — accueil",
  },
  en: {
    nav: [
      { href: "/studio", label: "Studio" },
      { href: "/live", label: "Live agent" },
      { href: "/marketplace", label: "Marketplace" },
    ],
    faq: { href: "/faq", label: "FAQ (FR)" },
    login: "Log in",
    signup: "Get started",
    homeAria: "Gen3ia — home",
  },
} as const;

/**
 * En-tête de la vitrine — V2 « Aurora OS ».
 * - transparent en haut de page (le héros aurora passe derrière) ;
 * - dès que le conteneur interne (#g3-scroll) défile : verre sombre
 *   translucide, flou d'arrière-plan, hairline et ombre profonde.
 * L'en-tête est sticky dans le conteneur de défilement : le contenu glisse
 * dessous. La marque porte la tuile dégradée Aurora de l'identité V2.
 */
export function VitrineHeader({ lang = "fr" }: { lang?: "fr" | "en" }) {
  const labels = LABELS[lang];
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const el = document.getElementById("g3-scroll");
    if (!el) return;
    const onScroll = () => setScrolled(el.scrollTop > 12);
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-all duration-300 ease-out ${
        scrolled
          ? "border-[var(--g3-border)] bg-[var(--g3-bg)]/85 shadow-[0_18px_50px_-30px_rgba(0,0,0,0.9)] backdrop-blur-xl"
          : "border-transparent bg-transparent"
      }`}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Link href={lang === "en" ? "/en" : "/"} className="flex items-center gap-2.5" aria-label={labels.homeAria}>
          <Gen3iaLogo size={36} alt="" />
          <span className="font-[family-name:var(--font-display)] text-sm font-bold tracking-tight text-[var(--g3-text)]">Gen3ia</span>
        </Link>
        <nav aria-label="Navigation vitrine" className="hidden items-center gap-1.5 md:flex">
          {labels.nav.map((item) =>
            item.href.startsWith("#") ? (
              <a
                key={item.href}
                href={item.href}
                className="rounded-full border border-[rgba(148,153,255,0.16)] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] backdrop-blur transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
              >
                {item.label}
              </a>
            ) : (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-full border border-[rgba(148,153,255,0.16)] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] backdrop-blur transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
              >
                {item.label}
              </Link>
            )
          )}
          <Link
            href={labels.faq.href}
            className="rounded-full border border-[rgba(148,153,255,0.16)] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] backdrop-blur transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
          >
            {labels.faq.label}
          </Link>
        </nav>
        <div className="flex items-center gap-2">
          {/* Bascule de thème accessible depuis la vitrine (étape 4 : le
              choix clair/sombre est disponible sur TOUTES les surfaces). */}
          <div className="hidden sm:block">
            <ThemeToggle compact />
          </div>
          <Link
            href="/login"
            className="rounded-full border border-[rgba(148,153,255,0.25)] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] backdrop-blur transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
          >
            {labels.login}
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-[var(--g3-gradient)] bg-[length:160%_100%] px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_28px_-10px_rgba(124,92,255,0.8)] transition hover:-translate-y-0.5 hover:brightness-110"
          >
            {labels.signup}
          </Link>
        </div>
      </div>
    </header>
  );
}
