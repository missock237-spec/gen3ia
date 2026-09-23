"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { navPrimaryFor } from "@/components/shells/nav-registry";
import { NavIcon } from "@/components/ui/nav-icon";

/**
 * AdminShell — shell opérateur de l'espace d'administration (architecture à
 * 3 espaces). Affiche clairement le rôle, le contexte « Administration » et un
 * lien explicite de retour au Workspace. La barrière serveur reste dans
 * app/admin/layout.tsx (source d'autorité) : ce shell ne fait que rendre
 * lisible le contexte d'élévation.
 */
export function AdminShell({ children, role }: { children: ReactNode; role: string }) {
  const pathname = usePathname();
  const nav = navPrimaryFor("admin");
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const current = nav.find((route) => active(route.href));

  return (
    <div className="min-h-full bg-[#101418] text-neutral-100">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        {/* Bandeau de contexte d'élévation — toujours visible */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/30 bg-amber-300/10 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-amber-300 text-sm font-bold text-neutral-900" aria-hidden="true">⛨</span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[.25em] text-amber-200/80">Gen3ia · Administration</div>
              <div className="text-xs text-neutral-300">
                Session élevée — rôle <span className="font-semibold text-amber-200">{role}</span>. Toutes les actions sont journalisées.
              </div>
            </div>
          </div>
          <Link
            href="/studio"
            className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/20"
          >
            <span aria-hidden="true">←</span> Retour au Workspace
          </Link>
        </div>

        <nav aria-label="Espace administration" className="no-scrollbar mb-6 max-w-full overflow-x-auto">
          <ul className="inline-flex min-w-full items-center gap-1.5 rounded-2xl border border-white/10 bg-white/5 p-1.5">
            {nav.map((route) => (
              <li key={route.id} className="flex-1">
                <Link
                  href={route.href}
                  aria-current={active(route.href) ? "page" : undefined}
                  className={`flex items-center justify-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-[13px] font-semibold transition ${
                    active(route.href)
                      ? "bg-white text-neutral-900"
                      : "text-neutral-400 hover:bg-white/10 hover:text-white"
                  }`}
                >
                  <NavIcon glyph={route.icon} size={15} />
                  {route.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {current && (
          <header className="mb-7">
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{current.label}</h1>
            <p className="mt-1 max-w-3xl text-sm text-neutral-400">{current.description}</p>
          </header>
        )}

        {children}
      </div>
    </div>
  );
}
