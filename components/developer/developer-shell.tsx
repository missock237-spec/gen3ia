"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { navPrimaryFor } from "@/components/shells/nav-registry";
import { BackToWorkspace } from "@/components/shells/permission-notice";
import { useDeveloper } from "@/components/developer/developer-context";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";

/**
 * DeveloperShell — shell partagé de l'espace développeur (architecture à 3
 * espaces). Navigation, en-tête, sélecteur de projet et états de chargement
 * sont ici : les pages /developer/* ne contiennent que leur contenu.
 * La barrière serveur reste dans app/developer/layout.tsx (source d'autorité).
 */
export function DeveloperShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { projects, selectedProject, setSelectedProject, project, loadError, loadCore, message } = useDeveloper();

  const nav = navPrimaryFor("developer");
  const active = (href: string) => pathname === href || pathname.startsWith(href + "/");
  const current = nav.find((route) => active(route.href));

  return (
    <div className="min-h-full bg-[var(--g3-elevated)] text-neutral-950">
      <div className="mx-auto flex min-h-full max-w-[1500px] flex-col lg:flex-row">
        <aside className="w-full border-b bg-[var(--g3-deep)] p-4 text-white lg:min-h-screen lg:w-64 lg:border-b-0 lg:border-r lg:p-5">
          <Link href="/studio" className="flex items-center gap-2 text-lg font-bold">
            <span className="grid h-8 w-8 place-items-center rounded-xl bg-[var(--g3-surface)] overflow-hidden"><Gen3iaLogo size={32} alt="" /></span> Gen3ia
          </Link>
          <div className="mt-1 text-[10px] uppercase tracking-[.25em] text-[var(--g3-muted)]">Developer Studio</div>

          <nav aria-label="Espace développeur" className="mt-8 space-y-1">
            {nav.map((route) => (
              <Link
                key={route.id}
                href={route.href}
                aria-current={active(route.href) ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                  active(route.href)
                    ? "bg-[var(--g3-surface)] text-black"
                    : "text-[var(--g3-faint)] hover:bg-[var(--g3-deep)] hover:text-white"
                }`}
              >
                <span className="w-5 text-center" aria-hidden="true">{route.icon}</span>
                {route.label}
              </Link>
            ))}
          </nav>

          <div className="mt-8 border-t border-[var(--g3-border)] pt-5">
            <label htmlFor="developer-project" className="text-[10px] uppercase tracking-widest text-[var(--g3-muted)]">
              Projet actif
            </label>
            <select
              id="developer-project"
              value={selectedProject}
              onChange={(event) => setSelectedProject(event.target.value)}
              className="mt-2 w-full rounded-xl border border-[var(--g3-border)] bg-[var(--g3-deep)] px-3 py-2 text-xs text-white"
            >
              <option value="">Sélectionner</option>
              {projects.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-8 space-y-3 text-xs text-[var(--g3-muted)]">
            <div className="rounded-2xl border border-[var(--g3-border)] p-3">Compte développeur</div>
            <BackToWorkspace label="Retour au Workspace" />
          </div>
        </aside>

        <main className="min-w-0 flex-1 p-5 md:p-8">
          <header className="mb-7">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--g3-faint)]">
              <Link href="/studio" className="transition hover:text-[var(--g3-text-secondary)]">Espace de travail</Link>
              <span aria-hidden="true">/</span>
              <span className="font-medium text-sky-700">Développeur</span>
              {current && current.href !== "/developer" && (
                <>
                  <span aria-hidden="true">/</span>
                  <span className="font-medium text-[var(--g3-muted)]">{current.label}</span>
                </>
              )}
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight md:text-3xl">{current?.label ?? "Vue d'ensemble"}</h1>
            <p className="mt-1 max-w-3xl text-sm text-[var(--g3-muted)]">
              {current?.description ?? "Construis, connecte, teste et déploie tes applications Gen3ia."}
              {project && <span className="ml-1.5 rounded-full bg-[var(--g3-deep)] px-2 py-0.5 text-[10px] font-semibold text-white">{project.name}</span>}
            </p>
          </header>

          {loadError && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="alert">
              <span>{loadError}</span>
              <button type="button" onClick={() => void loadCore()} className="shrink-0 rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-500">
                Recharger
              </button>
            </div>
          )}
          {message && <div className="mb-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm" role="status">{message}</div>}

          {children}
        </main>
      </div>
    </div>
  );
}
