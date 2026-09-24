"use client";

import { useEffect, useState } from "react";

/**
 * Bouton flottant « Haut » — apparaît après un certain défilement du
 * conteneur principal (#g3-scroll) et ramène en haut en douceur.
 * Reproduit le bouton « ↑ Top » de runable.com.
 */
export function ScrollTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = document.getElementById("g3-scroll");
    if (!el) return;
    const onScroll = () => setVisible(el.scrollTop > 480);
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label="Revenir en haut de la page"
      onClick={() =>
        document
          .getElementById("g3-scroll")
          ?.scrollTo({ top: 0, behavior: "smooth" })
      }
      className={`fixed bottom-5 right-5 z-40 flex items-center gap-1.5 rounded-full border border-[rgba(23,23,20,0.1)] bg-[var(--g3-surface)] px-4 py-2.5 text-sm font-semibold text-[var(--g3-text)] shadow-[0_14px_36px_-16px_rgba(28,27,24,0.45)] transition-all duration-300 ease-out hover:-translate-y-0.5 hover:shadow-[0_18px_40px_-16px_rgba(28,27,24,0.55)] ${
        visible ? "opacity-100" : "pointer-events-none translate-y-3 opacity-0"
      }`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
      Haut
    </button>
  );
}
