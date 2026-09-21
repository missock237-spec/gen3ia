"use client";

import { useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";

/**
 * Recherche sémantique dans la mémoire : les souvenirs épisodiques
 * (échanges passés), décisions et préférences sont retrouvés par similarité
 * d'embeddings — « Qu'est-ce qu'on a décidé sur le projet X ? » retrouve
 * les échanges pertinents, au-delà des mots-clés exacts.
 */

interface SearchHit {
  id: string;
  type: string;
  content: string;
  createdAt: string;
  agentId?: string;
  score: number;
}

const TYPE_LABELS: Record<string, string> = {
  conversation: "Échange passé",
  fact: "Fait",
  decision: "Décision",
  preference: "Préférence",
  execution: "Exécution",
  artifact: "Livrable",
  project: "Projet",
};

const EXAMPLES = [
  "Qu'est-ce qu'on a décidé sur le projet X ?",
  "Quelles sont mes préférences de rédaction ?",
  "Quel livrable a été produit la semaine dernière ?",
];

export function SemanticSearchPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [scope, setScope] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function search(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2 || loading) return;
    setLoading(true);
    setError("");
    try {
      const response = await authFetch("/api/memory/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: query.trim(), limit: 10 }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Recherche impossible.");
      setResults(data.results ?? []);
      setScope(typeof data.scope === "string" ? data.scope : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Recherche impossible.");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="g3-card p-5">
        <h2 className="text-base font-bold">Recherche sémantique</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-500">
          Posez une question en langage naturel : la mémoire retrouve les échanges, décisions et
          préférences pertinents par similarité de sens — pas seulement par mots-clés.
        </p>
        <form onSubmit={search} className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            className="g3-input flex-1"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ex. Qu'est-ce qu'on a décidé sur la charte graphique ?"
            maxLength={500}
            aria-label="Requête de recherche sémantique"
          />
          <button type="submit" className="g3-btn g3-btn-primary" disabled={query.trim().length < 2 || loading}>
            {loading ? <>Recherche<span className="g3-dots"><span /><span /><span /></span></> : "Rechercher"}
          </button>
        </form>
        {results === null && !error ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button key={example} type="button" className="g3-chip" onClick={() => setQuery(example)}>
                {example}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {error && <Callout tone="error" className="rounded-2xl">{error}</Callout>}

      {results !== null && (
        <div className="space-y-3" aria-live="polite">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            {results.length} souvenir{results.length > 1 ? "s" : ""} pertinent{results.length > 1 ? "s" : ""} trouvé{results.length > 1 ? "s" : ""}
            {scope === "global" ? " · portée globale" : ""}
          </p>
          {results.length === 0 ? (
            <div className="g3-card p-6 text-sm text-neutral-500">
              Aucun souvenir ne correspond à cette recherche. Plus vous dialoguez avec vos agents, plus la
              mémoire épisodique s&apos;enrichit.
            </div>
          ) : (
            results.map((hit) => (
              <article key={hit.id} className="g3-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-sky-700">
                    {TYPE_LABELS[hit.type] ?? hit.type}
                  </span>
                  {hit.createdAt ? <span className="text-xs text-neutral-400">{hit.createdAt.slice(0, 10)}</span> : null}
                  <span className="ml-auto text-xs font-semibold text-neutral-400">{Math.round(hit.score * 100)}% de correspondance</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-neutral-700">{hit.content}</p>
              </article>
            ))
          )}
        </div>
      )}
    </div>
  );
}
