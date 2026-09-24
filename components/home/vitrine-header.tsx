"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * En-tête de la vitrine — comportement de défilement identique à runable.com :
 * - transparent en haut de page (le dégradé ciel du héros passe derrière) ;
 * - dès que le conteneur interne (#g3-scroll) défile, fond crème translucide,
 *   flou d'arrière-plan et ombre douce, avec une transition de 300 ms.
 * L'en-tête est sticky dans le conteneur de défilement : le contenu glisse
 * dessous, exactement comme la navigation fixe de Runable.
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


  const links = [
    { href: "#produits", label: "Produits" },
    { href: "#fonctionnement", label: "Fonctionnement" },
    { href: "#securite", label: "Sécurité" },
    { href: "#faq", label: "FAQ" },
  ];

  return (
    <header className="sticky top-0 z-50 px-3 pt-3 sm:px-6">
      <div
        className={`mx-auto flex max-w-6xl items-center justify-between gap-4 rounded-2xl border px-3 py-2.5 transition-all duration-300 ease-out sm:px-4 ${
          scrolled
            ? "border-white/10 bg-[#0b0c12]/75 shadow-[0_20px_50px_-25px_rgba(0,0,0,0.8)] backdrop-blur-xl"
            : "border-transparent bg-transparent"
        }`}
      >
        <Link href="/" className="flex items-center gap-2.5">
          <span className="nx-logo">G3</span>
          <span className="text-sm font-semibold tracking-tight text-white">Gen3ia</span>
        </Link>
        <nav aria-label="Navigation vitrine" className="hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <a key={link.href} href={link.href} className="rounded-full px-3.5 py-2 text-sm text-white/60 transition hover:bg-white/[0.06] hover:text-white">
              {link.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Link href="/login" className="hidden rounded-full px-4 py-2 text-sm text-white/70 transition hover:text-white sm:inline-flex">
            Se connecter
          </Link>
          <Link href="/signup" className="nx-btn-light !px-4 !py-2 text-sm">
            Commencer
          </Link>
        </div>
      </div>
    </header>
  );
}
