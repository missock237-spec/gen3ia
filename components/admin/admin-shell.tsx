"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { navPrimaryFor, type NavRole, type NavRoute } from "@/components/shells/nav-registry";

/**
 * Entrée genAPI — Agent OS gRPC (tunnels mTLS souverains, paquets à usage
 * unique, facturation Chariow à l'exécution). Déclarée LOCALEMENT dans le
 * shell admin : le registre global (nav-registry.ts) reste inchangé tant que
 * la surface genAPI (routes + console) est en cours d'intégration.
 */
const ROUTE_ADMIN_GENAPI: NavRoute = {
  id: "admin-genapi",
  href: "/admin/genapi",
  label: "genAPI",
  icon: "⌁",
  description: "Agent OS gRPC : clients mTLS, paquets à usage unique et journal",
  contexts: ["admin"],
  minRole: "admin",
  section: "primary",
  keywords: ["genapi", "grpc", "mtls", "certificats", "agent os", "daemon", "paquets"],
};

/**
 * AdminShell — shell opérateur de l'espace d'administration (architecture à
 * 3 espaces). Affiche clairement le rôle, le contexte « Administration » et un
 * lien explicite de retour au Workspace. La barrière serveur reste dans
 * app/admin/layout.tsx (source d'autorité) : ce shell ne fait que rendre
 * lisible le contexte d'élévation.
 */
export function AdminShell({ children, role }: { children: ReactNode; role: string }) {
  const pathname = usePathname();
  // Le rôle du layout est transmis au registre : l'appel historique sans rôle
  // (défaut "user") échouait au test minRoleSatisfied("user", "admin") et
  // filtrait TOUTES les entrées minRole admin (nav vide). Les entrées du
  // registre restent inchangées ; genAPI est ajoutée en fin de liste par le
  // shell seul (ROUTE_ADMIN_GENAPI ci-dessus).
  const roleNav: NavRole = role === "admin" ? "admin" : role === "developer" ? "developer" : "user";
  const nav = [...navPrimaryFor("admin", roleNav), ROUTE_ADMIN_GENAPI];
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const current = nav.find((route) => active(route.href));

  return (
    <div className="min-h-full bg-[var(--g3-bg)] text-[var(--g3-text-secondary)]">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        {/* Bandeau de contexte d'élévation — toujours visible */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--g3-warning-soft)] bg-[var(--g3-warning-soft)] px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--g3-warning)] text-sm font-bold text-[var(--g3-text)]" aria-hidden="true">⛨</span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[.25em] text-[var(--g3-warning-strong)]">Gen3ia · Administration</div>
              <div className="text-xs text-[var(--g3-faint)]">
                Session élevée — rôle <span className="font-semibold text-[var(--g3-warning-strong)]">{role}</span>. Toutes les actions sont journalisées.
              </div>
            </div>
          </div>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-full bg-[var(--g3-surface)]/10 px-4 py-2 text-xs font-semibold text-white transition hover:bg-[var(--g3-surface)]/20"
          >
            <span aria-hidden="true">←</span> Retour au tableau de bord
          </Link>
        </div>

        <nav aria-label="Espace administration" className="no-scrollbar mb-6 max-w-full overflow-x-auto">
          <ul className="inline-flex min-w-full items-center gap-1.5 rounded-2xl border border-white/10 bg-[var(--g3-surface)]/5 p-1.5">
            {nav.map((route) => (
              <li key={route.id} className="flex-1">
                <Link
                  href={route.href}
                  aria-current={active(route.href) ? "page" : undefined}
                  className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition ${
                    active(route.href)
                      ? "bg-[var(--g3-surface)] text-[var(--g3-text)]"
                      : "text-[var(--g3-faint)] hover:bg-[var(--g3-surface)]/10 hover:text-white"
                  }`}
                >
                  <span aria-hidden="true">{route.icon}</span>
                  {route.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {current && (
          <header className="mb-7">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{current.label}</h1>
            <p className="mt-1 max-w-3xl text-sm text-[var(--g3-faint)]">{current.description}</p>
          </header>
        )}

        {children}
      </div>
    </div>
  );
}
