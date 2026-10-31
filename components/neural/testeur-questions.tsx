"use client";

import { useState } from "react";

/**
 * TESTEUR DE QUESTIONS DE LA VOCATION (it.66 — demande propriétaire :
 * « fais en sorte qu'il soit capable de répondre à des questions qui
 * rentrent dans son cadre d'apprentissage » — puis, it.65, « depuis le
 * navigateur tu vas tester gen3 »).
 *
 * Composant CLIENT public : poste une question à POST /api/neural/questions
 * (endpoint public, aucune donnée utilisateur) et rend la réponse réelle
 * du pont vocation — ancrée charte, avec son thème et son score. Aucune
 * réponse n'est fabriquée côté client : ce qui s'affiche est CE QUE gen3
 * RÉPOND, y compris l'honnêteté « connu: false » d'une question hors cadre.
 */

interface ReponseQuestions {
  connu?: boolean;
  reponse?: string | null;
  theme?: string | null;
  score?: number | null;
  source?: string | null;
  motif?: string | null;
  erreur?: string;
}

/** Suggestions de test — construites depuis les mots des domaines réels. */
const SUGGESTIONS: readonly string[] = [
  "que sais-tu faire en cybersécurité ?",
  "quels sont tes domaines ?",
  "peux-tu faire la vérification factuelle multi-sources ?",
  "what can you do in artificial intelligence ?",
];

export default function TesteurQuestionsVocation() {
  const [question, setQuestion] = useState("");
  const [reponse, setReponse] = useState<ReponseQuestions | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  async function poser(texte: string) {
    const propre = texte.trim();
    if (!propre || occupe) return;
    setOccupe(true);
    setErreur(null);
    try {
      const res = await fetch("/api/neural/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: propre }),
      });
      const json = (await res.json()) as ReponseQuestions;
      if (!res.ok) {
        setErreur(json.erreur ?? `Erreur ${res.status}`);
        setReponse(null);
      } else {
        setReponse(json);
      }
    } catch {
      setErreur("Réseau indisponible — réessayez.");
      setReponse(null);
    } finally {
      setOccupe(false);
    }
  }

  return (
    <section aria-label="Tester gen3 — poser une question dans son cadre d'apprentissage" className="g3v6-card p-5">
      <h2 className="text-sm font-bold">Tester gen3 — posez-lui une question de son cadre</h2>
      <p className="mt-1 text-[12px] leading-relaxed text-[var(--g3-muted)]">
        La réponse vient du moteur neuronal local, composée depuis la charte de vocation
        (domaine reconnu, tâches réelles, outils du registre) — aucune réponse fabriquée :
        une question hors cadre est signalée comme telle.
      </p>
      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void poser(question);
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Votre question pour gen3 (FR ou EN)…"
          aria-label="Votre question pour gen3"
          maxLength={600}
          className="flex-1 rounded-md border border-[var(--g3-border)] bg-[var(--g3-bg)] px-3 py-2 text-[13px] text-[var(--g3-text)] outline-none focus:border-[var(--g3v6-spike-text)]"
        />
        <button
          type="submit"
          disabled={occupe || question.trim().length === 0}
          className="rounded-md border border-[var(--g3v6-spike-border)] bg-[var(--g3v6-spike-bg)] px-4 py-2 text-[13px] font-semibold text-[var(--g3v6-spike-text)] disabled:opacity-50"
        >
          {occupe ? "gen3 réfléchit…" : "Poser la question"}
        </button>
      </form>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setQuestion(suggestion);
              void poser(suggestion);
            }}
            className="rounded-full border border-[var(--g3-border)] px-2.5 py-1 text-[11px] text-[var(--g3-muted)] hover:border-[var(--g3v6-spike-border)] hover:text-[var(--g3v6-spike-text)]"
          >
            {suggestion}
          </button>
        ))}
      </div>
      {erreur ? (
        <p role="alert" className="mt-3 text-[12px] text-red-400">
          {erreur}
        </p>
      ) : null}
      {reponse ? (
        <div className="mt-3 rounded-md border border-[var(--g3-border)] bg-[var(--g3-bg)] p-4" aria-live="polite">
          {reponse.connu ? (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3v6-spike-text)]">
                Réponse de gen3 {reponse.theme ? `— ${reponse.theme}` : ""} {typeof reponse.score === "number" ? `· appariement ${reponse.score.toFixed(2)}` : ""}
              </p>
              <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-[var(--g3-text-secondary)]">
                {reponse.reponse}
              </p>
            </>
          ) : (
            <>
              <p className="text-[11px] font-semibold uppercase tracking-[var(--g3v6-track)] text-[var(--g3-faint)]">
                Hors cadre reconnu — gen3 ne fabrique pas de réponse
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--g3-muted)]">{reponse.motif}</p>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
