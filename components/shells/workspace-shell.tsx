"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { navPrimaryFor, type NavRole } from "./nav-registry";

/**
 * WorkspaceShell — navigation de l'espace utilisateur (architecture 3 espaces).
 *
 * Barre 1 (primaire, issue du NavRegistry) : Missions · Créer · Résultats ·
 * Connexions · Équipe. Les modules métier ne figurent plus ici : ils sont
 * proposés comme modèles dans « Créer ».
 *
 * Barre 2 (outils du Studio) : surfaces techniques transverses conservées.
 */

// Outils du Studio : Clients ID est accessible à TOUS LES COMPTES (demande
// propriétaire — restauration). Console est l'IDE développeur
// (/studio/console, restreint par le middleware) : elle n'est affichée
// qu'aux rôles développeur/admin — la nav ne doit pas mentir.
const STUDIO_TOOLS = [
  { href: "/studio/clients", label: "Clients ID", minRole: undefined as NavRole | undefined },
  { href: "/studio/console", label: "Console", minRole: "developer" as NavRole },
] as const;

const ROLE_ORDER: Record<NavRole, number> = { user: 0, developer: 1, admin: 2 };

export function WorkspaceShell() {
  const pathname = usePathname();
  const [role, setRole] = useState<NavRole>("user");

  // Le rôle sert uniquement à masquer les entrées inexistantes pour un
  // compte ; les entrées développeur/admin vivent dans leur propre shell.
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
  const tools = STUDIO_TOOLS.filter(
    (tool) => !("minRole" in tool) || !tool.minRole || ROLE_ORDER[role] >= ROLE_ORDER[tool.minRole],
  );
  const active = (href: string) => pathname === href || (href !== "/studio" && pathname.startsWith(href + "/"));

  return (
    <div className="mb-6 space-y-2 md:mb-7">
      <nav aria-label="Espace de travail" className="no-scrollbar max-w-full overflow-x-auto">
        <ul className="g3-tabs w-full min-w-full">
          {primary.map((route) => (
            <li key={route.id} className="flex-1">
              <Link
                href={route.href}
                aria-current={active(route.href) ? "page" : undefined}
                className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition-colors ${
                  active(route.href)
                    ? "bg-[var(--g3-gradient)] bg-[length:160%_100%] text-white shadow-[0_8px_22px_-8px_var(--g3-primary)]"
                    : "text-[var(--g3-muted)] hover:bg-[var(--g3-hover)] hover:text-[var(--g3-text)]"
                }`}
              >
                <span aria-hidden="true">{route.icon}</span>
                {route.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <nav aria-label="Outils du Studio" className="no-scrollbar max-w-full overflow-x-auto">
        <ul className="inline-flex items-center gap-1.5 px-0.5">
          {tools.map((tool) => (
            <li key={tool.href}>
              <Link
                href={tool.href}
                aria-current={active(tool.href) ? "page" : undefined}
                className={`inline-flex whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  active(tool.href)
                    ? "border-[var(--g3-primary)] bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]"
                    : "border-[var(--g3-border)] bg-[var(--g3-surface)]/70 text-[var(--g3-muted)] hover:border-[var(--g3-border-strong)] hover:text-[var(--g3-text)]"
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
