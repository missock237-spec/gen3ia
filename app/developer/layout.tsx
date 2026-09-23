import Link from "next/link";
import { headers } from "next/headers";
import type { ReactNode } from "react";

import { getPlatformAccess } from "@/lib/access/platform";
import { DeveloperProvider } from "@/components/developer/developer-context";
import { DeveloperShell } from "@/components/developer/developer-shell";

/**
 * Barrière serveur de l'espace développeur — source d'autorité (rôle
 * developer ou admin requis, vérifié côté serveur via getPlatformAccess).
 * La navigation, l'en-tête et le projet actif vivent dans DeveloperShell ;
 * les pages ne contiennent que leur contenu.
 */
export default async function DeveloperLayout({ children }: Readonly<{ children: ReactNode }>) {
  let authorized = false;
  try {
    const request = new Request("https://gen3ia.local/developer", { headers: await headers() });
    const access = await getPlatformAccess(request);
    authorized = access.canDeveloper;
  } catch {
    authorized = false;
  }

  if (!authorized) {
    return (
      <div className="min-h-full bg-[var(--g3-bg)] p-6 text-neutral-900 md:p-10">
        <div className="mx-auto flex min-h-[70vh] max-w-xl items-center justify-center">
          <section className="w-full rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100 text-2xl">⌘</div>
            <p className="mt-5 text-xs font-semibold uppercase tracking-[.25em] text-neutral-500">Gen3ia · Developer</p>
            <h1 className="mt-3 font-serif text-2xl font-semibold">Espace développeur restreint</h1>
            <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-neutral-500">
              Les projets, clés API, extensions, SDK et outils de développement sont séparés de l&apos;espace utilisateur.
            </p>
            <Link href="/studio" className="g3-btn g3-btn-primary mt-6 inline-flex rounded-full">
              Retour à l&apos;espace de travail
            </Link>
          </section>
        </div>
      </div>
    );
  }

  return (
    <DeveloperProvider>
      <DeveloperShell>{children}</DeveloperShell>
    </DeveloperProvider>
  );
}
