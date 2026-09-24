import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { getPlatformAccess } from "@/lib/access/platform";
import { AdminShell } from "@/components/admin/admin-shell";

/**
 * Barrière serveur de l'espace d'administration — source d'autorité
 * (rôle admin vérifié côté serveur via getPlatformAccess / claims Firebase).
 * AdminShell n'est qu'une interface : elle ne protège rien, elle expose le
 * contexte (rôle, elevation, retour Workspace) quand la barrière passe.
 */
export default async function AdminLayout({ children }: Readonly<{ children: ReactNode }>) {
  let canAdmin = false;
  try {
    const request = new Request("https://gen3ia.local/admin", { headers: await headers() });
    const access = await getPlatformAccess(request);
    canAdmin = access.canAdmin;
  } catch {
    canAdmin = false;
  }

  if (!canAdmin) {
    return (
      <div className="min-h-full bg-[var(--g3-bg)] p-6 text-neutral-900 md:p-10">
        <div className="mx-auto flex min-h-[70vh] max-w-xl items-center justify-center">
          <section className="w-full rounded-3xl border border-[var(--g3-border)] bg-white p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100 text-2xl">⛨</div>
            <p className="mt-5 text-xs font-semibold uppercase tracking-[.25em] text-neutral-500">Gen3ia · Administration</p>
            <h1 className="mt-3 font-serif text-2xl font-semibold">Espace d&apos;administration restreint</h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-neutral-500">
              La vue plateforme, les comptes, la modération, la publicité et l&apos;audit sont réservés aux administrateurs. L&apos;autorisation est vérifiée côté serveur.
            </p>
            <Link href="/studio" className="g3-btn g3-btn-primary mt-6 inline-flex rounded-full">
              Retour à l&apos;espace de travail
            </Link>
          </section>
        </div>
      </div>
    );
  }

  // Le rôle exact est ré-affiché par le shell (contexte d'élévation visible).
  return <AdminShell role="admin">{children}</AdminShell>;
}
