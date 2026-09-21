"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { AnimatedTabs, AnimatedTabsSection } from "@/components/ui/animated-tabs";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { SouvenirsPanel, type MemoryEntry } from "@/components/memory/souvenirs-panel";
import { DocumentsPanel, type DocumentFileEntry } from "@/components/memory/documents-panel";
import { SemanticSearchPanel } from "@/components/memory/semantic-search-panel";
import { formatBytes } from "@/lib/storage/upload-policy";

export type StorageUsageView = { usedBytes: number; quotaBytes: number; fileCount: number };

/**
 * Page dédiée « Mémoire permanente » : les souvenirs texte (clé/valeur)
 * et les documents réellement stockés (100 Mo max/fichier, 10 fichiers
 * par lot) que les agents retrouveront lors de leurs missions.
 */
export function MemoryWorkspace() {
  const sessionDisponible = useSessionAvailable();
  const [tab, setTab] = useState("souvenirs");
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [files, setFiles] = useState<DocumentFileEntry[]>([]);
  const [usage, setUsage] = useState<StorageUsageView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [globalMessage, setGlobalMessage] = useState("");

  const refreshMemories = useCallback(async () => {
    try {
      const response = await authFetch("/api/memory", { cache: "no-store" });
      if (response.ok) setMemories((await response.json()).memories ?? []);
    } catch { /* indisponible ponctuellement */ }
  }, []);

  const refreshFiles = useCallback(async () => {
    try {
      const response = await authFetch("/api/storage/permanent", { cache: "no-store" });
      if (response.ok) {
        const body = await response.json();
        setFiles(body.files ?? []);
        if (body.usage) setUsage(body.usage);
      }
    } catch { /* indisponible ponctuellement */ }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) { setLoaded(true); return; }
    if (sessionDisponible === null) return;
    void Promise.all([refreshMemories(), refreshFiles()]).finally(() => setLoaded(true));
  }, [sessionDisponible, refreshMemories, refreshFiles]);

  if (sessionDisponible === false) {
    return (
      <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center px-6 py-20 text-center">
        <div className="g3-card w-full p-10">
          <div className="g3-eyebrow">GEN3IA · MÉMOIRE PERMANENTE</div>
          <h1 className="mt-3 font-serif text-2xl font-semibold">Connectez-vous pour accéder à votre mémoire</h1>
          <p className="mt-3 text-sm leading-6 text-neutral-500">
            Votre mémoire permanente conserve les informations clés et les documents que vos agents
            réutilisent à chaque mission. Elle est strictement personnelle et protégée.
          </p>
          <Link href="/login?next=/memory" className="g3-btn g3-btn-primary mt-6 inline-flex">Se connecter</Link>
        </div>
      </div>
    );
  }

  const quotaPercent = usage && usage.quotaBytes > 0 ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 100)) : 0;

  return (
    <div className="p-4 md:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="g3-eyebrow">GEN3IA AI STUDIO</div>
            <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight md:text-4xl">Mémoire permanente</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500 md:text-base">
              Tout ce que vos agents doivent retenir : informations clés et documents réellement stockés
              jusqu&apos;à <strong>100 Mo par fichier</strong>, par lots de <strong>10 fichiers</strong>. Secrets et
              mots de passe y restent interdits.
            </p>
          </div>
          <Link href="/studio" className="g3-btn g3-btn-ghost w-fit text-xs">← Retour au Studio</Link>
        </header>

        {/* Bandeau statistiques + quota */}
        <section aria-label="Vue d'ensemble de la mémoire" className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="g3-card p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Souvenirs texte</p>
            <p className="mt-1 font-serif text-3xl font-semibold">{memories.length}</p>
            <p className="mt-1 text-xs text-neutral-400">clé/valeur réutilisables par vos agents</p>
          </div>
          <div className="g3-card p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Documents stockés</p>
            <p className="mt-1 font-serif text-3xl font-semibold">{usage?.fileCount ?? files.length}</p>
            <p className="mt-1 text-xs text-neutral-400">{usage ? formatBytes(usage.usedBytes) : "…"} occupés sur votre espace</p>
          </div>
          <div className="g3-card p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Quota de stockage</p>
              <p className="text-xs font-semibold text-neutral-600">{quotaPercent}%</p>
            </div>
            <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-neutral-200" role="progressbar" aria-valuenow={quotaPercent} aria-valuemin={0} aria-valuemax={100} aria-label="Quota de stockage utilisé">
              <div className={`h-full rounded-full transition-all ${quotaPercent > 90 ? "bg-red-500" : quotaPercent > 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(quotaPercent, 2)}%` }} />
            </div>
            <p className="mt-2 text-xs text-neutral-400">{usage ? `${formatBytes(usage.usedBytes)} sur ${formatBytes(usage.quotaBytes)}` : "Chargement…"}</p>
          </div>
        </section>

        {globalMessage && (
          <div className="anim-fade-in mt-4 rounded-xl border border-violet-200 bg-violet-100 p-4 text-sm text-violet-700" role="status">
            {globalMessage}
          </div>
        )}

        <div className="mb-6 mt-6">
          <AnimatedTabs
            ariaLabel="Sections de la mémoire permanente"
            active={tab}
            onChange={setTab}
            tabs={[
              { key: "souvenirs", label: `Souvenirs texte${memories.length ? ` · ${memories.length}` : ""}` },
              { key: "documents", label: `Documents${files.length ? ` · ${files.length}` : ""}` },
              { key: "recherche", label: "Recherche sémantique" },
            ]}
          />
        </div>

        {tab === "souvenirs" ? (
          <AnimatedTabsSection>
            <SouvenirsPanel memories={memories} loaded={loaded} onRefresh={refreshMemories} onNotify={setGlobalMessage} />
          </AnimatedTabsSection>
        ) : tab === "documents" ? (
          <AnimatedTabsSection>
            <DocumentsPanel
              files={files}
              usage={usage}
              loaded={loaded}
              onRefresh={refreshFiles}
              onNotify={setGlobalMessage}
            />
          </AnimatedTabsSection>
        ) : (
          <AnimatedTabsSection>
            <SemanticSearchPanel />
          </AnimatedTabsSection>
        )}

        <footer className="mt-8 rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-4 text-xs leading-5 text-neutral-400">
          Vos données restent associées à votre compte : les agents n&apos;y accèdent qu&apos;avec les permissions
          que vous leur accordez. Aucune publication externe n&apos;est possible depuis la mémoire permanente.
        </footer>
      </div>
    </div>
  );
}
