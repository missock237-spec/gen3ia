"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { ObservabilityDashboard, type ObservabilityOverviewView } from "@/components/observability/observability-dashboard";
import { StudioHeader } from "@/components/studio/studio-header";
import { Callout } from "@/components/studio/callout";

/**
 * Observabilité des agents (/observability) : traces d'exécution, coûts,
 * tokens, usage des outils et alertes. Visibilité demandée par les
 * entreprises sur ce que font leurs agents — Gartner en fait un critère
 * d'adoption des plateformes agentiques.
 */
export default function ObservabilityPage() {
  const sessionDisponible = useSessionAvailable();
  const [overview, setOverview] = useState<ObservabilityOverviewView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [days, setDays] = useState(14);
  // Garde anti-désordre : si l'utilisateur change de fenêtre (7→14→30) pendant
  // qu'une requête est en vol, la réponse périmée ne doit pas écraser la plus
  // récente (ni réafficher une erreur obsolète).
  const loadTokenRef = useRef(0);

  const load = useCallback(async (windowDays: number) => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setError("");
    try {
      const response = await authFetch(`/api/observability/overview?days=${windowDays}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Observabilité indisponible.");
      if (token !== loadTokenRef.current) return;
      setOverview(data as ObservabilityOverviewView);
    } catch (e) {
      if (token !== loadTokenRef.current) return;
      setError(e instanceof Error ? e.message : "Observabilité indisponible.");
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) { setLoading(false); return; }
    if (sessionDisponible === null) return;
    void load(days);
  }, [sessionDisponible, days, load]);

  return (
    <div className="pb-4">
      <StudioHeader
        eyebrow="GEN3IA · OBSERVABILITÉ"
        title="Observabilité des agents"
        description="Traces d'exécution, coûts, tokens, usage des outils et alertes : gardez la visibilité totale sur ce que vos agents font, dépensent et décident."
        actions={
          <Link href="/studio" className="g3-btn g3-btn-ghost text-xs">← Retour au Studio</Link>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {[7, 14, 30].map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={days === option}
            onClick={() => setDays(option)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors ${days === option ? "bg-neutral-900 text-white" : "border border-neutral-300 text-neutral-600 hover:bg-neutral-100"}`}
          >
            {option} jours
          </button>
        ))}
        <button type="button" onClick={() => void load(days)} className="rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-semibold text-neutral-600 hover:bg-neutral-100">
          Rafraîchir
        </button>
      </div>

      {error ? <Callout tone="error" className="mb-5 rounded-2xl">{error}</Callout> : null}

      {sessionDisponible === false ? (
        <div className="g3-card p-10 text-center">
          <h2 className="font-serif text-xl font-semibold">Connectez-vous pour voir vos traces</h2>
          <p className="mt-2 text-sm text-neutral-500">L&apos;observabilité est strictement personnelle : chaque compte ne voit que ses propres exécutions.</p>
          <Link href="/login?next=/observability" className="g3-btn g3-btn-primary mt-5 inline-flex">Se connecter</Link>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index} className="h-24 animate-pulse rounded-2xl border border-neutral-200 bg-white" />
          ))}
          <div className="col-span-2 h-48 animate-pulse rounded-2xl border border-neutral-200 bg-white lg:col-span-4" />
        </div>
      ) : overview ? (
        <ObservabilityDashboard overview={overview} />
      ) : null}
    </div>
  );
}
