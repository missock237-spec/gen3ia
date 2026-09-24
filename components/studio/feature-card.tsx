"use client";

import Link from "next/link";

/**
 * Carte de fonctionnalité du Studio — version interne (texte seul)
 * et version lien (navigation vers une page dédiée).
 * Extraites de app/studio/page.tsx pour réutilisation et cohérence.
 */
export function FeatureCard({ title, text }: { title: string; text: string }) {
  return (
    <div className="g3-card p-5">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">{text}</p>
    </div>
  );
}

export function FeatureLinkCard({
  href,
  title,
  text,
  cta,
}: {
  href: string;
  title: string;
  text: string;
  cta: string;
}) {
  return (
    <Link href={href} className="g3-card block p-5 transition hover:bg-[var(--g3-surface)]">
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-[var(--g3-muted)]">{text}</p>
      <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-sky-700">{cta} →</span>
    </Link>
  );
}
