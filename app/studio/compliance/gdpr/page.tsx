"use client";

import { useState } from "react";
import { StudioHeader } from "@/components/studio/studio-header";
import {
  Field,
  Pill,
  EmptyHint,
  ModuleSection,
  StatCard,
  inputCls,
  btnPrimaryCls,
  btnGhostCls,
  cardCls,
  useModuleData,
  statusTone,
  statusLabel,
  shortDate,
} from "@/components/business/kit";

/** Module Conformité — RGPD (registre des traitements + demandes DSR, SLA 30 j). */

interface Processing {
  id: string;
  processingName: string;
  purpose: string;
  legalBasis: string;
  dataCategories: string[];
  recipients?: string;
  retentionDays: number;
  secured: boolean;
}

interface DsrRequest {
  id: string;
  subjectName: string;
  subjectEmail: string;
  type: string;
  typeLabel?: string;
  receivedAt: string;
  deadlineAt: string;
  status: string;
  daysLeft: number | null;
  sla: string;
}

const LEGAL_BASES: Record<string, string> = {
  consent: "Consentement",
  contract: "Contrat",
  legal_obligation: "Obligation légale",
  legitimate_interest: "Intérêt légitime",
  vital_interest: "Intérêt vital",
  public_task: "Mission publique",
};

const SLA_TONE: Record<string, "green" | "amber" | "red" | "neutral"> = { ok: "green", urgent: "amber", breached: "red", closed: "neutral" };

export default function ComplianceGdprPage() {
  const { items: processing, extra, loading, error, setError, busy, mutate, remove } = useModuleData<Processing>("/api/business/compliance-gdpr", "processing");
  const requests = (extra.requests as DsrRequest[] | undefined) ?? [];
  const kpis = (extra.kpis as { openRequests: number; breached: number } | undefined) ?? { openRequests: 0, breached: 0 };
  const [tab, setTab] = useState<"processing" | "requests">("processing");
  const [proc, setProc] = useState({ processingName: "", purpose: "", legalBasis: "consent", dataCategoriesText: "", recipients: "", retentionDays: "365", secured: true });
  const [req, setReq] = useState({ subjectName: "", subjectEmail: "", type: "access", details: "" });
  const [notice, setNotice] = useState<string | null>(null);

  async function createProcessing() {
    setNotice(null);
    const result = await mutate("POST", {
      kind: "processing",
      processingName: proc.processingName,
      purpose: proc.purpose,
      legalBasis: proc.legalBasis,
      dataCategories: proc.dataCategoriesText.split(",").map((c) => c.trim()).filter(Boolean),
      ...(proc.recipients ? { recipients: proc.recipients } : {}),
      retentionDays: Number(proc.retentionDays) || 365,
      secured: proc.secured,
    });
    if (result) {
      setNotice("Traitement inscrit au registre.");
      setProc({ ...proc, processingName: "", purpose: "", dataCategoriesText: "", recipients: "" });
    }
  }

  async function createRequest() {
    setNotice(null);
    if (await mutate("POST", { kind: "request", subjectName: req.subjectName, subjectEmail: req.subjectEmail, type: req.type, ...(req.details ? { details: req.details } : {}) })) {
      setNotice("Demande enregistrée — échéance réglementaire à 30 jours ajoutée au calendrier.");
      setReq({ ...req, subjectName: "", subjectEmail: "", details: "" });
    }
  }

  async function decide(id: string, status: "in_progress" | "fulfilled" | "refused") {
    setNotice(null);
    if (await mutate("PATCH", { kind: "request", id, status })) setNotice("Demande mise à jour.");
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-0 py-2">
      <StudioHeader
        eyebrow="MODULE · CONFORMITÉ"
        title="RGPD"
        description="Registre des traitements et demandes des personnes (accès, rectification, effacement, portabilité) avec échéance réglementaire de 30 jours suivie automatiquement."
      />

      {error ? (
        <p role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">
          {error} <button className="underline" onClick={() => setError(null)}>Fermer</button>
        </p>
      ) : null}
      {notice ? <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] text-emerald-700">{notice}</p> : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="Traitements au registre" value={String(processing.length)} />
        <StatCard label="Demandes ouvertes" value={String(kpis.openRequests)} tone={kpis.openRequests ? "amber" : "green"} />
        <StatCard label="SLA dépassés" value={String(kpis.breached)} tone={kpis.breached ? "red" : "green"} />
      </div>

      <div className="mb-4 flex gap-1.5">
        {(["processing", "requests"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-xl px-4 py-2 text-[13px] font-semibold ${tab === key ? "bg-neutral-900 text-white" : "bg-white text-neutral-600 ring-1 ring-neutral-200 hover:text-neutral-900"}`}
          >
            {key === "processing" ? "Registre des traitements" : "Demandes des personnes"}
          </button>
        ))}
      </div>

      {tab === "processing" ? (
        <>
          <div className={cardCls}>
            <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Inscrire un traitement</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Nom du traitement">
                <input className={inputCls} value={proc.processingName} onChange={(e) => setProc({ ...proc, processingName: e.target.value })} placeholder="Newsletter clients" />
              </Field>
              <Field label="Base légale">
                <select className={inputCls} value={proc.legalBasis} onChange={(e) => setProc({ ...proc, legalBasis: e.target.value })}>
                  {Object.entries(LEGAL_BASES).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Finalité">
                <input className={inputCls} value={proc.purpose} onChange={(e) => setProc({ ...proc, purpose: e.target.value })} placeholder="Envoyer nos actualités aux clients abonnés" />
              </Field>
              <Field label="Catégories de données (séparées par des virgules)">
                <input className={inputCls} value={proc.dataCategoriesText} onChange={(e) => setProc({ ...proc, dataCategoriesText: e.target.value })} placeholder="e-mail, nom, préférences" />
              </Field>
              <Field label="Destinataires (optionnel)">
                <input className={inputCls} value={proc.recipients} onChange={(e) => setProc({ ...proc, recipients: e.target.value })} placeholder="Service marketing, outil d'e-mailing" />
              </Field>
              <Field label="Durée de conservation (jours)">
                <input type="number" min="1" className={inputCls} value={proc.retentionDays} onChange={(e) => setProc({ ...proc, retentionDays: e.target.value })} />
              </Field>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <label className="flex items-center gap-2 text-[13px] text-neutral-700">
                <input type="checkbox" checked={proc.secured} onChange={(e) => setProc({ ...proc, secured: e.target.checked })} />
                Données sécurisées (chiffrement, accès restreint)
              </label>
              <button className={btnPrimaryCls} disabled={busy || !proc.processingName || !proc.purpose || !proc.dataCategoriesText.trim()} onClick={createProcessing}>
                Inscrire au registre
              </button>
            </div>
          </div>

          <ModuleSection title={`Traitements (${processing.length})`}>
            {loading ? <p className="text-[13px] text-neutral-500">Chargement…</p> : null}
            {!loading && processing.length === 0 ? <EmptyHint>Registre vide — inscrivez votre premier traitement.</EmptyHint> : null}
            <div className="space-y-2.5">
              {processing.map((entry) => (
                <article key={entry.id} className={cardCls}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-[14px] font-bold text-neutral-900">{entry.processingName}</h3>
                      <p className="text-[12.5px] text-neutral-500">{entry.purpose}</p>
                      <p className="mt-1 text-[12px] text-neutral-400">
                        {LEGAL_BASES[entry.legalBasis] ?? entry.legalBasis} · conservation {entry.retentionDays} j · {entry.dataCategories.join(", ")}
                        {entry.recipients ? ` · destinataires : ${entry.recipients}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Pill tone={entry.secured ? "green" : "amber"}>{entry.secured ? "Sécurisé" : "À vérifier"}</Pill>
                      <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => remove(entry.id)}>
                        Retirer
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </ModuleSection>
        </>
      ) : (
        <>
          <div className={cardCls}>
            <h2 className="mb-4 text-[15px] font-bold text-neutral-900">Enregistrer une demande</h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Nom de la personne">
                <input className={inputCls} value={req.subjectName} onChange={(e) => setReq({ ...req, subjectName: e.target.value })} placeholder="Jean Martin" />
              </Field>
              <Field label="E-mail">
                <input type="email" className={inputCls} value={req.subjectEmail} onChange={(e) => setReq({ ...req, subjectEmail: e.target.value })} placeholder="jean@exemple.fr" />
              </Field>
              <Field label="Type de demande">
                <select className={inputCls} value={req.type} onChange={(e) => setReq({ ...req, type: e.target.value })}>
                  <option value="access">Droit d&apos;accès</option>
                  <option value="rectification">Rectification</option>
                  <option value="erasure">Effacement</option>
                  <option value="portability">Portabilité</option>
                  <option value="opposition">Opposition</option>
                </select>
              </Field>
              <Field label="Détails (optionnel)">
                <input className={inputCls} value={req.details} onChange={(e) => setReq({ ...req, details: e.target.value })} placeholder="Demande reçue par e-mail" />
              </Field>
            </div>
            <div className="mt-4 flex justify-end">
              <button className={btnPrimaryCls} disabled={busy || !req.subjectName || !req.subjectEmail} onClick={createRequest}>
                Enregistrer la demande
              </button>
            </div>
          </div>

          <ModuleSection title={`Demandes (${requests.length})`}>
            {!loading && requests.length === 0 ? <EmptyHint>Aucune demande pour l&apos;instant.</EmptyHint> : null}
            <div className="space-y-2.5">
              {requests.map((request) => (
                <article key={request.id} className={cardCls}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-[14px] font-bold text-neutral-900">
                        {request.typeLabel ?? request.type} — {request.subjectName}
                      </h3>
                      <p className="text-[12.5px] text-neutral-500">
                        {request.subjectEmail} · reçue le {shortDate(request.receivedAt)} · échéance {shortDate(request.deadlineAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Pill tone={SLA_TONE[request.sla] ?? "neutral"}>
                        {request.sla === "breached" ? "SLA dépassé" : request.sla === "urgent" ? `${request.daysLeft} j restants` : request.sla === "closed" ? "Clôturée" : "Dans les délais"}
                      </Pill>
                      <Pill tone={statusTone(request.status)}>{statusLabel(request.status)}</Pill>
                    </div>
                  </div>
                  {request.status !== "fulfilled" && request.status !== "refused" ? (
                    <div className="mt-3 flex gap-2">
                      {request.status === "received" ? (
                        <button className={btnGhostCls} disabled={busy} onClick={() => decide(request.id, "in_progress")}>
                          Prendre en charge
                        </button>
                      ) : null}
                      <button className={btnPrimaryCls} disabled={busy} onClick={() => decide(request.id, "fulfilled")}>
                        Marquer honorée
                      </button>
                      <button className={`${btnGhostCls} text-red-600`} disabled={busy} onClick={() => decide(request.id, "refused")}>
                        Refuser
                      </button>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          </ModuleSection>
        </>
      )}
    </main>
  );
}
