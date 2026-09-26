import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";

import { getArtifact } from "@/lib/domain/artifacts/repository";
import { isRunnableHtmlApp } from "@/lib/domain/conversations/app-detect";
import {
  SESSION_COOKIE_NAME,
  verifySessionCookie,
} from "@/lib/server/session-cookie";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Aperçu en direct — Gen3ia",
  robots: { index: false, follow: false },
};

/**
 * ARTEFACTS — lien web d'aperçu en direct.
 *
 * Le contrat décrit dans la conversation : lorsque l'agent écrit du code ou
 * conçoit une interface, la réponse contient un LIEN WEB (/preview/<id>) ;
 * cette page rend le résultat directement dans le navigateur de l'utilisateur,
 * en dehors même de l'application (lien partageable, ouvrable dans un onglet).
 *
 * Sécurité : le document HTML produit par l'agent est rendu dans un iframe
 * SANDBOXÉ (scripts autorisés, origine opaque) — il ne peut ni lire les
 * cookies de gen3ia.online, ni accéder au DOM parent, ni persister côté
 * navigateur. L'accès reste réservé au PROPRIÉTAIRE de l'artefact (session
 * signée) : un lien transmis à un tiers ne rend rien.
 */

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const store = await cookies();
  const session = verifySessionCookie(store.get(SESSION_COOKIE_NAME)?.value);

  if (!session) {
    return (
      <PreviewShell title="Aperçu en direct">
        <div className="mx-auto max-w-md rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8 text-center">
          <p className="text-sm font-semibold text-[var(--g3-text)]">Connexion requise</p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--g3-muted)]">
            Cet aperçu est réservé au propriétaire de l&apos;artefact. Connectez-vous avec le compte
            qui a créé cette application pour voir son rendu en direct.
          </p>
          <Link
            href={`/login?next=${encodeURIComponent(`/preview/${id}`)}`}
            className="mt-5 inline-flex items-center justify-center rounded-full bg-gradient-to-r from-[#7C5CFF] to-[#E14FEA] px-5 py-2 text-sm font-semibold text-white transition hover:brightness-110"
          >
            Se connecter
          </Link>
        </div>
      </PreviewShell>
    );
  }

  const artifact = await getArtifact(session.uid, id).catch(() => null);

  if (!artifact) {
    return (
      <PreviewShell title="Aperçu en direct">
        <div className="mx-auto max-w-md rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-8 text-center">
          <p className="text-sm font-semibold text-[var(--g3-text)]">Aperçu introuvable</p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--g3-muted)]">
            Cet artefact n&apos;existe pas, a été supprimé, ou n&apos;appartient pas à ce compte.
          </p>
          <Link href="/workspace/conversations" className="mt-5 inline-flex items-center justify-center rounded-full border border-[var(--g3-border-strong)] px-5 py-2 text-sm font-semibold text-[var(--g3-text)] transition hover:bg-[var(--g3-elevated)]">
            Retour à la conversation
          </Link>
        </div>
      </PreviewShell>
    );
  }

  const latest = artifact.versions[0];
  const content = latest?.content ?? artifact.content ?? "";

  if (!isRunnableHtmlApp(artifact) || !content) {
    return (
      <PreviewShell title={artifact.title}>
        <div className="mx-auto max-w-2xl rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] p-6">
          <p className="text-sm font-semibold text-[var(--g3-text)]">{artifact.title}</p>
          <p className="mt-2 text-sm text-[var(--g3-muted)]">
            Cet artefact n&apos;est pas une application exécutable : aucun rendu direct disponible.
          </p>
          {content ? (
            <pre className="mt-4 max-h-[50vh] overflow-auto rounded-xl bg-black/40 p-4 text-xs leading-relaxed text-[var(--g3-muted)]">{content.slice(0, 20_000)}</pre>
          ) : null}
        </div>
      </PreviewShell>
    );
  }

  return (
    <PreviewShell title={artifact.title}>
      <div className="mx-auto flex h-full w-full max-w-[1400px] flex-col gap-3">
        <header className="flex flex-wrap items-center gap-3 rounded-full border border-[var(--g3-border)] bg-[var(--g3-surface)] px-5 py-2.5">
          <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-gradient-to-r from-[#7C5CFF] to-[#E14FEA]" />
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--g3-text)]">{artifact.title}</p>
          <span className="rounded-full bg-[var(--g3-elevated)] px-2.5 py-0.5 text-[10px] font-medium text-[var(--g3-muted)]">
            v{latest?.version ?? 1} · rendu en direct
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--g3-muted)]">Gen3ia</span>
        </header>
        <iframe
          title={`Aperçu en direct — ${artifact.title}`}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
          srcDoc={content}
          className="h-full min-h-[70vh] w-full flex-1 rounded-2xl border border-[var(--g3-border)] bg-white"
          referrerPolicy="no-referrer"
        />
      </div>
    </PreviewShell>
  );
}

function PreviewShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--g3-bg)] p-4 text-[var(--g3-text)] md:p-6" data-preview-title={title}>
      {children}
    </div>
  );
}
