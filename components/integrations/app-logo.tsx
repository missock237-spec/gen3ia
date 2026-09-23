"use client";

import { useState } from "react";

/**
 * Logo officiel d'une app connecteur — avec repli élégant sur les initiales
 * quand l'URL est absente ou en échec de chargement (jamais d'icône cassée).
 * Composant partagé : hub /integrations, composer de conversation,
 * connecteurs autorisés des projets.
 */
export function AppLogo({
  entry,
  size = 36,
}: {
  entry: { toolkit: string; label: string; logo?: string | null };
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initials = entry.label.slice(0, 2).toUpperCase();
  if (!entry.logo || failed) {
    return (
      <span
        aria-hidden
        className="flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-sky-100 to-indigo-100 text-[11px] font-black text-indigo-700"
        style={{ width: size, height: size }}
      >
        {initials}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- URL d'icône Composio externe, dimensions fixes
    <img
      src={entry.logo}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="shrink-0 rounded-lg bg-white object-contain"
      style={{ width: size, height: size }}
    />
  );
}
