"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * En-tête de la vitrine — V2 « Aurora OS ».
 * - transparent en haut de page (le héros aurora passe derrière) ;
 * - dès que le conteneur interne (#g3-scroll) défile : verre sombre
 *   translucide, flou d'arrière-plan, hairline et ombre profonde.
 * L'en-tête est sticky dans le conteneur de défilement : le contenu glisse
 * dessous. La marque porte la tuile dégradée Aurora de l'identité V2.
 */
export function VitrineHeader() {
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
        <Link href="/" className="flex items-center gap-2.5" aria-label="Gen3ia — accueil">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--g3-gradient)] bg-[length:160%_100%] text-sm font-black text-white shadow-[0_6px_20px_-6px_rgba(124,92,255,0.8)]">
            G3
          </span>
          <span className="font-[family-name:var(--font-display)] text-sm font-bold tracking-tight text-[var(--g3-text)]">Gen3ia</span>
        </Link>
        <nav aria-label="Navigation vitrine" className="hidden items-center gap-1.5 md:flex">
          {[
            { href: "#produits", label: "Produits" },
            { href: "#fonctionnement", label: "Fonctionnement" },
            { href: "#securite", label: "Sécurité" },
          ].map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-full border border-[rgba(148,153,255,0.16)] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] backdrop-blur transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
            >
              {item.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-full border border-[rgba(148,153,255,0.25)] bg-white/[0.04] px-4 py-2 text-sm font-medium text-[var(--g3-text-secondary)] backdrop-blur transition hover:border-[rgba(124,92,255,0.5)] hover:text-white"
          >
            Se connecter
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-[var(--g3-gradient)] bg-[length:160%_100%] px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_28px_-10px_rgba(124,92,255,0.8)] transition hover:-translate-y-0.5 hover:brightness-110"
          >
            Commencer
          </Link>
        </div>
      </div>
    </header>
  );
}
