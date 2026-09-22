"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { matchNavRoute, NAV_REGISTRY } from "@/components/shells/nav-registry";

type Crumb = { label: string; href?: string };

/**
 * Fil d'Ariane global — dérivé du NavRegistry unique (architecture à 3
 * espaces) : [Espace de travail, …parents, page courante]. Le dernier élément
 * est la page courante (non cliquable, aria-current).
 */
function crumbsFor(pathname: string): Crumb[] {
  const matched = matchNavRoute(pathname);
  if (!matched) return [];

  // Chemin de parents : remonte les préfixes connus du registre
  // (ex. /studio/marketing/landing → Espace de travail / Missions / landing).
  const prefixes = NAV_REGISTRY.filter(
    (route) => route.href !== matched.href && matched.href.startsWith(route.href + "/"),
  ).sort((a, b) => a.href.length - b.href.length);

  const crumbs: Crumb[] = [{ label: "Espace de travail", href: "/studio" }];
  for (const parent of prefixes) {
    crumbs.push({ label: parent.label, href: parent.href });
  }
  crumbs.push({ label: matched.label });
  return crumbs;
}

export function Breadcrumbs() {
  const pathname = usePathname();
  if (pathname === "/" || pathname === "/login" || pathname === "/signup") return null;
  // Le studio et ses sous-espaces gèrent leur fil d'Ariane dans SectionHeader.
  if (pathname.startsWith("/studio") || pathname.startsWith("/developer") || pathname.startsWith("/admin")) return null;
  const crumbs = crumbsFor(pathname);
  if (!crumbs.length) return null;

  return (
    <nav aria-label="Fil d'Ariane" className="g3-breadcrumb">
      {crumbs.map((crumb, index) => {
        const last = index === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${index}`} className="inline-flex items-center gap-[7px]">
            {index > 0 && <span className="g3-breadcrumb-sep" aria-hidden="true">›</span>}
            {last || !crumb.href ? (
              <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
            ) : (
              <Link href={crumb.href}>{crumb.label}</Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
