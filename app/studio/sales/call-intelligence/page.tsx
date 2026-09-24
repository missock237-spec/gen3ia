"use client";

import { useState } from "react";
import { StudioHeader } from "@/components/studio/studio-header";
import { Field, Pill, EmptyHint, ModuleSection, StatCard, inputCls, btnPrimaryCls, btnGhostCls, cardCls, useModuleData, statusTone, statusLabel, shortDate } from "@/components/business/kit";

/** Module Sales — Call Intelligence (AI Engine + Scheduling Engine sur la Call App). */

interface Insight {
  summary: string;
  sentiment: "positif" | "neutre" | "negatif";
  interestLevel: "chaud" | "tiede" | "froid";
  score: number;
  objections: Array<{ objection: string; response: string }>;
  nextSteps: string[];
  followUpDays: number;
  followUpReason: string;
}

interface CallInsightRow {
  id: string;
  callSessionId: string;
  to: string;
  objective?: string;
  insight: Insight;
  followUpEventId: string | null;
  createdAt: number;
}

interface AvailableCall {
  id: string;
  to: string;
  objective: string;
  status: string;
  turns: number;
  createdAt: number;
}

const INTEREST_TONE: Record<Insight["interestLevel"], "green" | "amber" | "red"> = { chaud: "green", tiede: "amber", froid: "red" };
const SENTIMENT_LABEL: Record<Insight["sentiment"], string> = { positif: "Positif", neutre: "Neutre", negatif: "Négatif" };

export default function SalesCallIntelligencePage() {
  const { items: insights, extra, loading, error, setError, busy, mutate } = useModuleData<CallInsightRow>("/api/business/sales-call-intelligence", "insights");
  const availableCalls = (extra.availableCalls as AvailableCall[] | undefined) ?? [];
  const [selected, setSelected] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  async function analyze() {
    setNotice(null);
    const result = await mutate("POST", { action: "analyze", callSessionId: selected });
    if (result?.insight) {
      const row = result.insight as CallInsightRow;
      setNotice(row.followUpEventId ? "Analyse terminée — rendez-vous de suivi planifié automatiquement." : "Analyse terminée.");
      setSelected("");
    }
  }

  const avgScore = insights.length ? Math.round(insights.reduce((acc, i) => acc + i.insight.score, 0) / insights.length) : null;
  const hot = insights.filter((i) => i.insight.interestLevel === "chaud").length;

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · SALES"
        title="Call Intelligence"
        highlight="appels"
        description="Analyse automatique des appels passés par vos agents : résumé, sentiment, objections traitées, score d'opportunité et suivi planifié."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Appels analysés" value={String(insights.length)} />
        <StatCard label="Score moyen" value={avgScore !== null ? `${avgScore}/100` : "—"} hint={avgScore !== null ? (avgScore >= 60 ? "Opportunités solides" : "À retravailler") : undefined} />
        <StatCard label="Interlocuteurs chauds" value={String(hot)} />
      </div>

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-[var(--g3-text)]">Analyser un appel terminé</h2>
        {availableCalls.length === 0 ? (
          <EmptyHint>Aucun appel terminé à analyser. Lancez des appels depuis l&apos;onglet Appels du Studio, puis revenez ici.</EmptyHint>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1">
              <Field label="Appel à analyser">
                <select className={inputCls} value={selected} onChange={(e) => setSelected(e.target.value)}>
                  <option value="">— Choisir un appel —</option>
                  {availableCalls.map((call) => (
                    <option key={call.id} value={call.id}>
                      {new Date(call.createdAt).toLocaleDateString("fr-FR")} · {call.to} · {call.turns} échanges · {call.objective.slice(0, 40)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button className={btnPrimaryCls} disabled={busy || !selected} onClick={analyze}>
              Lancer l&apos;analyse IA
            </button>
          </div>
        )}
      </div>

      <ModuleSection title={`Analyses (${insights.length})`}>
        {loading ? <p className="text-[13px] text-[var(--g3-muted)]">Chargement…</p> : null}
        {!loading && insights.length === 0 ? <EmptyHint>Aucune analyse pour l&apos;instant.</EmptyHint> : null}
        <div className="space-y-3">
          {insights.map((row) => (
            <article key={row.id} className={cardCls}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h3 className="text-[15px] font-bold text-[var(--g3-text)]">{row.to}</h3>
                  <p className="text-[12px] text-[var(--g3-muted)]">{shortDate(row.createdAt)}{row.objective ? ` · ${row.objective.slice(0, 60)}` : ""}</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <Pill tone={INTEREST_TONE[row.insight.interestLevel]}>{row.insight.interestLevel}</Pill>
                  <Pill tone={statusTone(row.insight.sentiment === "positif" ? "approved" : row.insight.sentiment === "negatif" ? "rejected" : "pending")}>{SENTIMENT_LABEL[row.insight.sentiment]}</Pill>
                  <Pill tone="blue">{row.insight.score}/100</Pill>
                </div>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--g3-text-secondary)]">{row.insight.summary}</p>

              {openId === row.id ? (
                <div className="mt-3 space-y-3 text-[13px]">
                  {row.insight.objections.length ? (
                    <div>
                      <p className="mb-1 font-semibold text-[var(--g3-text)]">Objections & réponses</p>
                      <ul className="space-y-1.5">
                        {row.insight.objections.map((o, i) => (
                          <li key={i} className="rounded-lg bg-[var(--g3-elevated)] px-3 py-2">
                            <strong>Objection :</strong> {o.objection}
                            <br />
                            <strong>Réponse :</strong> {o.response}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div>
                    <p className="mb-1 font-semibold text-[var(--g3-text)]">Prochaines actions</p>
                    <ul className="list-inside list-disc text-[var(--g3-text-secondary)]">
                      {row.insight.nextSteps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                  <p className="text-[12px] text-[var(--g3-muted)]">
                    Suivi recommandé dans {row.insight.followUpDays} jour(s) — {row.insight.followUpReason}
                    {row.followUpEventId ? " (rendez-vous créé dans votre calendrier)" : ""}
                  </p>
                </div>
              ) : null}

              <div className="mt-3 flex gap-2">
                <button className={btnGhostCls} onClick={() => setOpenId(openId === row.id ? null : row.id)}>
                  {openId === row.id ? "Réduire" : "Détails"}
                </button>
                <Pill tone="neutral">{statusLabel(row.followUpEventId ? "confirmed" : "planned")}</Pill>
              </div>
            </article>
          ))}
        </div>
      </ModuleSection>
    </main>
  );
}
