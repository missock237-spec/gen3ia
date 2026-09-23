"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { navPrimaryFor, type NavRole } from "./nav-registry";
import { NavIcon } from "@/components/ui/nav-icon";

/**
 * WorkspaceShell — navigation de l'espace utilisateur (architecture 3 espaces).
 *
 * Barre 1 (primaire, issue du NavRegistry) : Missions · Créer · Résultats ·
 * Connexions · Équipe. Les modules métier ne figurent plus ici : ils sont
 * proposés comme modèles dans « Créer ».
 *
 * Barre 2 (outils du Studio) : surfaces techniques transverses conservées.
 */

const STUDIO_TOOLS = [
  { href: "/studio/clients", label: "Clients ID" },
  { href: "/studio/calls", label: "Appels" },
  { href: "/studio/console", label: "Console" },
  { href: "/studio/interface-lab", label: "Atelier d'Interfaces" },
  { href: "/studio/schedules", label: "Planifications" },
  { href: "/studio/automations", label: "Automatisations" },
] as const;

export function WorkspaceShell() {
  const pathname = usePathname();
  const [role, setRole] = useState<NavRole>("user");

  // Le rôle sert uniquement à masquer les entrées primaire inexistantes pour
  // un compte ; les entrées développeur/admin vivent dans leur propre shell.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/auth/access", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { role?: NavRole };
        if (!cancelled && (data.role === "admin" || data.role === "developer")) setRole(data.role);
      })
      .catch(() => {
        /* utilisateur non connecté : rôle "user" par défaut */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const primary = navPrimaryFor("workspace", role);
  const active = (href: string) => pathname === href || (href !== "/studio" && pathname.startsWith(href + "/"));

  return (
    <div className="mb-6 space-y-2 md:mb-7">
      <nav aria-label="Espace de travail" className="no-scrollbar max-w-full overflow-x-auto">
        <ul className="inline-flex min-w-full items-center gap-1.5 rounded-2xl border border-[var(--g3-border)] bg-white p-1.5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          {primary.map((route) => (
            <li key={route.id} className="flex-1">
              <Link
                href={route.href}
                aria-current={active(route.href) ? "page" : undefined}
                className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-colors ${
                  active(route.href)
                    ? "bg-neutral-900 text-white shadow-[0_6px_18px_-8px_rgba(28,27,24,0.5)]"
                    : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                }`}
              >
                <NavIcon glyph={route.icon} href={route.href} size={15} />
                {route.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <nav aria-label="Outils du Studio" className="no-scrollbar max-w-full overflow-x-auto">
        <ul className="inline-flex items-center gap-1.5 px-0.5">
          {STUDIO_TOOLS.map((tool) => (
            <li key={tool.href}>
              <Link
                href={tool.href}
                aria-current={active(tool.href) ? "page" : undefined}
                className={`inline-flex whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active(tool.href)
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-[rgba(23,23,20,0.1)] bg-white/70 text-neutral-500 hover:border-neutral-300 hover:text-neutral-900"
                }`}
              >
                {tool.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
