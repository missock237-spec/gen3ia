"use client";

import { useState } from "react";
import { StudioHeader } from "@/components/studio/studio-header";
import { Field, EmptyHint, ModuleSection, inputCls, btnPrimaryCls, btnGhostCls, cardCls, useModuleData, shortDate } from "@/components/business/kit";

/** Module Marketing — Webinar → Content (AI Engine + Document Engine). */

interface WebinarOutputs {
  linkedinPost: string;
  followUpEmail: string;
  blogArticle: string;
  xThread: string[];
  keyQuotes: string[];
}

interface WebinarAsset {
  id: string;
  title: string;
  audience?: string;
  outputs: WebinarOutputs | null;
  createdAt: number;
}

type Tab = "linkedinPost" | "followUpEmail" | "blogArticle" | "xThread";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "linkedinPost", label: "LinkedIn" },
  { key: "followUpEmail", label: "E-mail" },
  { key: "blogArticle", label: "Article" },
  { key: "xThread", label: "Thread X" },
];

export default function MarketingWebinarPage() {
  const { items: assets, loading, error, setError, busy, mutate, remove } = useModuleData<WebinarAsset>("/api/business/marketing-webinar", "assets");
  const [form, setForm] = useState({ title: "", audience: "", transcript: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("linkedinPost");

  async function generate() {
    setNotice(null);
    const result = await mutate("POST", { action: "create", title: form.title, audience: form.audience, transcript: form.transcript });
    if (result?.asset) {
      setNotice("Kit de contenus généré — LinkedIn, e-mail, article et thread X sont prêts.");
      setOpenId(String((result.asset as { id: string }).id));
      setForm({ title: "", audience: "", transcript: "" });
    }
  }

  async function exportDocx(id: string) {
    setNotice(null);
    const result = await mutate("POST", { action: "export", id });
    if (result?.artifactId) setNotice(`Kit exporté (${String(result.filename)}) — téléchargeable depuis vos fichiers.`);
  }

  const open = assets.find((a) => a.id === openId) ?? null;

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · MARKETING"
        title="Webinar → Contenus"
        highlight="recyclage"
        description="Collez la transcription d'un webinar : l'AI Engine produit un post LinkedIn, un e-mail de suivi, un article de blog et un thread X fidèles aux propos tenus."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Nouveau kit de contenus</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Titre du webinar">
            <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Automatiser sa prospection avec l'IA" />
          </Field>
          <Field label="Audience (optionnel)">
            <input className={inputCls} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} placeholder="Commerciaux B2B" />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Transcription (min. 200 caractères)" hint="Collez le texte brut de la session, Questions/Réponses incluses.">
            <textarea className={`${inputCls} font-mono`} rows={8} value={form.transcript} onChange={(e) => setForm({ ...form, transcript: e.target.value })} placeholder="Animateur : Bienvenue à tous… " />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.title || form.transcript.trim().length < 200} onClick={generate}>
            Générer le kit de contenus
          </button>
        </div>
      </div>

      <ModuleSection title={`Kits générés (${assets.length})`}>
        {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
        {!loading && assets.length === 0 ? <EmptyHint>Aucun kit pour l&apos;instant. Générez le premier depuis une transcription.</EmptyHint> : null}
        <div className="space-y-3">
          {assets.map((asset) => (
            <article key={asset.id} className={cardCls}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-[15px] font-bold text-neutral-900">{asset.title}</h3>
                  <p className="text-[12px] text-neutral-500">{shortDate(asset.createdAt)}{asset.audience ? ` · ${asset.audience}` : ""}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className={btnGhostCls} onClick={() => setOpenId(openId === asset.id ? null : asset.id)}>
                    {openId === asset.id ? "Masquer" : "Afficher"}
                  </button>
                  <button className={btnGhostCls} disabled={busy} onClick={() => exportDocx(asset.id)}>
                    Exporter .docx
                  </button>
                  <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(asset.id)}>
                    Supprimer
                  </button>
                </div>
              </div>

              {openId === asset.id && asset.outputs ? (
                <div className="mt-4">
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {TABS.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold ${tab === t.key ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {tab === "xThread" ? (
                    <ol className="space-y-1.5 text-[13px] text-neutral-700">
                      {asset.outputs.xThread.map((tweet, i) => (
                        <li key={i} className="rounded-lg bg-neutral-50 px-3 py-2">{i + 1}. {tweet}</li>
                      ))}
                    </ol>
                  ) : (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-neutral-50 p-3.5 font-sans text-[13px] leading-relaxed text-neutral-700">
                      {asset.outputs[tab]}
                    </pre>
                  )}
                  {asset.outputs.keyQuotes.length ? (
                    <p className="mt-3 text-[12px] text-neutral-500">Citations clés : {asset.outputs.keyQuotes.slice(0, 3).join(" · ")}</p>
                  ) : null}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </ModuleSection>
    </main>
  );
}
