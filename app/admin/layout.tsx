import Link from "next/link";
import { headers } from "next/headers";

import { getPlatformAccess } from "@/lib/access/platform";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  try {
    const request = new Request("https://gen3ia.local/admin", {
      headers: await headers(),
    });
    const access = await getPlatformAccess(request);

    if (access.canAdmin) {
      return children;
    }
  } catch {
    // Render a neutral access boundary below.
  }

  return (
    <div className="min-h-full bg-[#f6f4ef] p-6 text-neutral-900 md:p-10">
      <div className="mx-auto flex min-h-[70vh] max-w-xl items-center justify-center">
        <section
          className="w-full rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-8 text-center shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]"
          aria-labelledby="admin-access-title"
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-neutral-100 text-2xl">
            🔒
          </div>
          <p className="mt-5 text-xs font-semibold uppercase tracking-[.25em] text-neutral-500">
            Gen3ia · Administration
          </p>
          <h1 id="admin-access-title" className="mt-3 font-serif text-2xl font-semibold">
            Espace administrateur restreint
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-neutral-500">
            Cette zone est réservée aux comptes administrateurs. Elle n&apos;appartient pas à l&apos;espace de travail utilisateur.
          </p>
          <Link
            href="/dashboard"
            className="g3-btn g3-btn-primary mt-6 inline-flex rounded-full"
          >
            Retour à l&apos;espace de travail
          </Link>
        </section>
      </div>
    </div>
  );
}
