"use client";

import { useState } from "react";
import { StudioHeader } from "@/components/studio/studio-header";
import {
  Field,
  Pill,
  EmptyHint,
  ModuleSection,
  cardCls,
  inputCls,
  btnPrimaryCls,
  btnGhostCls,
  useModuleData,
  statusTone,
  statusLabel,
} from "@/components/business/kit";

/** Module Marketing — Landing Pages (AI Engine + Document Engine). */

interface LandingContent {
  headline: string;
  subheadline: string;
  benefits: Array<{ title: string; body: string }>;
  sections: Array<{ title: string; body: string }>;
  cta: string;
  seoKeywords: string[];
}

interface LandingPage {
  id: string;
  name: string;
  product: string;
  audience: string;
  tone: string;
  language: string;
  features: string[];
  status: string;
  content: LandingContent | null;
  artifactId: string | null;
}

export default function MarketingLandingPage() {
  const { items: pages, loading, error, setError, busy, mutate, remove } = useModuleData<LandingPage>("/api/business/marketing-landing", "pages");
  const [form, setForm] = useState({ name: "", product: "", audience: "", tone: "professionnel", language: "fr", featuresText: "" });
  const [notice, setNotice] = useState<string | null>(null);

  async function create() {
    setNotice(null);
    const result = await mutate("POST", {
      action: "create",
      name: form.name,
      product: form.product,
      audience: form.audience,
      tone: form.tone,
      language: form.language,
      features: form.featuresText.split("\n").map((f) => f.trim()).filter(Boolean),
    });
    if (result) {
      setForm({ ...form, name: "", product: "", audience: "", featuresText: "" });
      setNotice("Brouillon créé — générez maintenant le contenu.");
    }
  }

  async function generate(id: string) {
    setNotice(null);
    if (await mutate("POST", { action: "generate", id })) setNotice("Contenu généré par l'AI Engine.");
  }

  async function publish(id: string) {
    setNotice(null);
    if (await mutate("POST", { action: "publish", id })) setNotice("Landing page publiée.");
  }

  async function exportPdf(id: string) {
    setNotice(null);
    const result = await mutate("POST", { action: "export", id });
    if (result?.artifactId) setNotice(`PDF exporté (${String(result.filename)}) — téléchargeable depuis vos fichiers.`);
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · MARKETING"
        title="Landing Pages"
        highlight="IA"
        description="Créez un brief, l'AI Engine rédige une landing page complète (accroche, bénéfices, sections, CTA, SEO) et le Document Engine l'exporte en PDF."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p>
      ) : null}

      <div className={cardCls}>
        <h2 className="mb-4 text-[15px] font-bold text-[var(--g3-text)]">Nouveau brief de landing page</h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nom du projet">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Lancement GenSales" />
          </Field>
          <Field label="Ton">
            <select className={inputCls} value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
              <option value="professionnel">Professionnel</option>
              <option value="amical">Amical</option>
              <option value="audacieux">Audacieux</option>
              <option value="premium">Premium</option>
              <option value="technique">Technique</option>
            </select>
          </Field>
          <Field label="Produit / service">
            <textarea className={inputCls} rows={2} value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })} placeholder="Plateforme d'agents IA pour PME…" />
          </Field>
          <Field label="Audience cible">
            <textarea className={inputCls} rows={2} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} placeholder="Dirigeants de PME de 10 à 200 salariés…" />
          </Field>
          <Field label="Fonctionnalités à valoriser (une par ligne)" hint="L'IA les transformera en bénéfices clients.">
            <textarea className={inputCls} rows={4} value={form.featuresText} onChange={(e) => setForm({ ...form, featuresText: e.target.value })} placeholder={"Agents IA 24/7\nAppels téléphoniques automatiques\nIntégrations 1000+ apps"} />
          </Field>
          <Field label="Langue">
            <select className={inputCls} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option value="fr">Français</option>
              <option value="en">English</option>
            </select>
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <button className={btnPrimaryCls} disabled={busy || !form.name || !form.product || !form.audience || !form.featuresText.trim()} onClick={create}>
            Créer le brouillon
          </button>
        </div>
      </div>

      <ModuleSection title={`Landing pages (${pages.length})`}>
        {loading ? <p className="text-[13px] text-[var(--g3-muted)]">Chargement…</p> : null}
        {!loading && pages.length === 0 ? <EmptyHint>Aucune landing page pour l&apos;instant. Créez votre premier brief ci-dessus.</EmptyHint> : null}
        <div className="grid gap-4 lg:grid-cols-2">
          {pages.map((page) => (
            <article key={page.id} className={cardCls}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-[15px] font-bold text-[var(--g3-text)]">{page.name}</h3>
                  <p className="mt-0.5 text-[12.5px] text-[var(--g3-muted)]">
                    {page.audience} · {page.tone} · {page.language.toUpperCase()}
                  </p>
                </div>
                <Pill tone={statusTone(page.status)}>{statusLabel(page.status)}</Pill>
              </div>

              {page.content ? (
                <div className="mt-3 rounded-xl bg-[var(--g3-elevated)] p-3.5">
                  <p className="text-[14px] font-bold text-[var(--g3-text)]">{page.content.headline}</p>
                  <p className="mt-1 text-[12.5px] text-[var(--g3-muted)]">{page.content.subheadline}</p>
                  <ul className="mt-2 list-inside list-disc space-y-0.5 text-[12.5px] text-[var(--g3-muted)]">
                    {page.content.benefits.slice(0, 3).map((b, i) => (
                      <li key={i}>
                        <strong>{b.title}</strong> — {b.body.slice(0, 90)}{b.body.length > 90 ? "…" : ""}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[12px] font-semibold text-[var(--g3-text)]">CTA : {page.content.cta}</p>
                </div>
              ) : (
                <p className="mt-3 px-3 py-2 text-[12.5px] text-[var(--g3-muted)]">Contenu non encore généré.</p>
              )}

              <div className="mt-3 flex flex-wrap gap-2">
                <button className={btnGhostCls} disabled={busy} onClick={() => generate(page.id)}>
                  {page.content ? "Régénérer" : "Générer le contenu"}
                </button>
                {page.content ? (
                  <button className={btnGhostCls} disabled={busy} onClick={() => exportPdf(page.id)}>
                    Exporter en PDF
                  </button>
                ) : null}
                {page.content && page.status !== "published" ? (
                  <button className={btnPrimaryCls} disabled={busy} onClick={() => publish(page.id)}>
                    Publier
                  </button>
                ) : null}
                <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(page.id)}>
                  Supprimer
                </button>
              </div>
            </article>
          ))}
        </div>
      </ModuleSection>
    </main>
  );
}
