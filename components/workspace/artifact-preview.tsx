"use client";

import { useEffect, useState } from "react";

import { isRunnableHtmlApp } from "@/lib/domain/conversations/app-detect";
import type { ConversationArtifact } from "@/lib/domain/conversations/types";

/**
 * Aperçu en direct d'une application créée par l'agent.
 *
 * Dès qu'un artefact de type « app » (page HTML autonome) est créé dans la
 * conversation, un bouton « Voir le résultat en direct » apparaît dans le
 * fil : il ouvre un aperçu iframe sandboxé rendu à partir de la dernière
 * version de l'artefact — mis à jour en temps réel quand l'agent publie
 * une nouvelle version (nouvelle clé de rendu = rechargement automatique).
 */

export function LiveAppPreviewButton({ artifact }: { artifact: ConversationArtifact }) {
  const [open, setOpen] = useState(false);
  if (!isRunnableHtmlApp(artifact)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 inline-flex items-center gap-2 rounded-full bg-[var(--g3-deep)] px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[var(--g3-elevated)]"
        title="Prévisualiser l'application créée par l'agent"
      >
        <span aria-hidden>▶</span>
        Voir le résultat en direct
      </button>
      {open && <ArtifactLivePreviewModal artifact={artifact} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ArtifactLivePreviewModal({ artifact, onClose }: { artifact: ConversationArtifact; onClose: () => void }) {
  const latest = artifact.versions[0];
  const content = latest?.content ?? artifact.content ?? "";
  const [device, setDevice] = useState<"mobile" | "desktop">("desktop");
  const [reloadKey, setReloadKey] = useState(0);

  // Temps réel : si une nouvelle version arrive (streaming), l'aperçu se
  // recharge automatiquement grâce à la clé de version.
  const versionKey = `${artifact.id}:${latest?.version ?? 1}`;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-black/70 p-3 md:p-6" role="dialog" aria-modal="true" aria-label={`Aperçu en direct — ${artifact.title}`} onClick={onClose}>
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--g3-border)] bg-[var(--g3-surface)] shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex flex-wrap items-center gap-2 border-b border-[var(--g3-border)] bg-[var(--g3-elevated)] px-4 py-2.5">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--g3-text)]">
            ▶ {artifact.title}
            <span className="ml-2 rounded-full bg-[var(--g3-elevated)] px-2 py-0.5 text-[10px] font-medium text-[var(--g3-muted)]">v{latest?.version ?? 1} · temps réel</span>
          </p>
          <div className="flex overflow-hidden rounded-lg border border-[var(--g3-border-strong)]" role="group" aria-label="Taille d'aperçu">
            {(["mobile", "desktop"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setDevice(mode)}
                aria-pressed={device === mode}
                className={"px-2.5 py-1 text-[11px] transition " + (device === mode ? "bg-[var(--g3-deep)] text-white" : "bg-[var(--g3-surface)] text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]")}
              >
                {mode === "mobile" ? "Mobile" : "Plein écran"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setReloadKey((k) => k + 1)}
            className="rounded-lg border border-[var(--g3-border-strong)] px-2.5 py-1 text-[11px] text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
            title="Recharger l'aperçu"
          >
            ⟳
          </button>
          {/* Contrat ARTEFACTS : le lien WEB réel (/preview/<id>) — rendu
              direct dans le navigateur, ouvrable dans un onglet dédié. */}
          <a
            href={`/preview/${artifact.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-[var(--g3-border-strong)] px-2.5 py-1 text-[11px] text-[var(--g3-muted)] hover:bg-[var(--g3-elevated)]"
            title="Ouvrir le rendu dans un onglet dédié (lien web Gen3ia)"
          >
            Ouvrir dans un onglet
          </a>
          <button type="button" onClick={onClose} className="rounded-lg bg-[var(--g3-deep)] px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-[var(--g3-elevated)]" aria-label="Fermer l'aperçu">
            Fermer
          </button>
        </header>

        {content ? (
          <div className="grid min-h-0 flex-1 place-items-start justify-center overflow-auto bg-[var(--g3-elevated)]/60 p-3">
            <iframe
              key={versionKey + ":" + reloadKey}
              title={`Aperçu — ${artifact.title}`}
              sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"
              srcDoc={content}
              className={"h-full min-h-[420px] rounded-xl border border-[var(--g3-border-strong)] bg-[var(--g3-surface)] shadow-inner " + (device === "mobile" ? "w-[390px] max-w-full" : "w-full")}
            />
          </div>
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-center text-sm text-[var(--g3-muted)]">
            <div>
              <p>Le contenu de cette application n&apos;est pas encore disponible.</p>
              <p className="mt-1 text-xs text-[var(--g3-faint)]">Attendez la fin de la génération par l&apos;agent, puis rouvrez l&apos;aperçu.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
