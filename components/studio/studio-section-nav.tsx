"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation de section du Studio (niveau entreprise) :
 * relie les trois espaces Studio avec l'état actif aria-current,
 * visible sur mobile (scroll horizontal) comme sur desktop.
 */

const STUDIO_SECTIONS = [
  {
    href: "/studio",
    label: "Agents & Missions",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m12 2 1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7L12 2Z" /></svg>
    ),
  },
  {
    href: "/studio/interface-lab",
    label: "Atelier d'Interfaces",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M8 6l-5 6 5 6M16 6l5 6-5 6" /></svg>
    ),
  },
  {
    href: "/studio/schedules",
    label: "Planifications",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
    ),
  },
] as const;

export function StudioSectionNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Sections du Studio" className="no-scrollbar mb-6 max-w-full overflow-x-auto md:mb-7">
      <ul className="inline-flex min-w-full items-center gap-1.5 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-1.5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
        {STUDIO_SECTIONS.map((section) => {
          const active = pathname === section.href;
          return (
            <li key={section.href} className="flex-1">
              <Link
                href={section.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-colors ${
                  active
                    ? "bg-neutral-900 text-white shadow-[0_6px_18px_-8px_rgba(28,27,24,0.5)]"
                    : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                }`}
              >
                {section.icon}
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
