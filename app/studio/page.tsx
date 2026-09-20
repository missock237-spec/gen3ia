"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";

import { AgentManager } from "@/components/agent/agent-manager";
import { UniversalAgentChat } from "@/components/agent/universal-agent-chat";
import { AnimatedTabs } from "@/components/ui/animated-tabs";
import { WorkspaceTaskPanel } from "@/components/agent/workspace-task-panel";

type Provider = "google_ads" | "meta_ads" | "tiktok_ads";
const labels: Record<Provider, string> = { google_ads: "Google Ads", meta_ads: "Meta Ads", tiktok_ads: "TikTok Ads" };

function AdsWorkshop() {
  const [connections, setConnections] = useState<Provider[]>([]);
  const [objective, setObjective] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [memoryCount, setMemoryCount] = useState(0);
  const [fileCount, setFileCount] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [publishResult, setPublishResult] = useState("");
  const sessionDisponible = useSessionAvailable();

  useEffect(() => {
    const load = async () => {
      const [ads, memory, storage] = await Promise.all([
        authFetch("/api/ads/connections", { cache: "no-store" }),
        authFetch("/api/memory", { cache: "no-store" }),
        authFetch("/api/storage/permanent", { cache: "no-store" }),
      ]);
      if (ads.ok) setConnections(((await ads.json()).connections ?? []).map((x: { provider: Provider }) => x.provider));
      if (memory.ok) setMemoryCount(((await memory.json()).memories ?? []).length);
      if (storage.ok) setFileCount(((await storage.json()).files ?? []).length);
      setLoaded(true);
    };
    void load();
  }, []);

  const connectAds = async (provider: Provider) => {
    if (sessionDisponible === false) { setMessage("Session expirée. Reconnectez-vous."); return; }
    setBusy(true); setMessage("");
    try { const response = await authFetch("/api/ads/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); window.location.assign(data.authorizationUrl); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Connexion impossible"); setBusy(false); }
  };

  const generateAd = async () => {
    if (sessionDisponible === false) { setMessage("Session expirée. Reconnectez-vous."); return; }
    if (objective.trim().length < 10) return; setBusy(true); setMessage(""); setPendingApprovalId(null); setPublishResult("");
    try { const provider = connections[0]; if (!provider) throw new Error("Connectez d'abord un compte Ads."); const response = await authFetch("/api/ads/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective, provider, accountId: "connected", destinationUrl: "https://gen3ia.com" }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setPendingApprovalId(String(data.approvalId ?? "")); setMessage("Publicité générée. Validation humaine requise avant publication : approuvez ou rejetez la publication ci-dessous."); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Génération impossible"); } finally { setBusy(false); }
  };

  const decideApproval = async (action: "approve" | "reject") => {
    if (!pendingApprovalId) return;
    if (sessionDisponible === false) { setMessage("Session expirée. Reconnectez-vous."); return; }
    setBusy(true); setMessage(""); setPublishResult("");
    try {
      const decision = await authFetch("/api/agent/chat/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: pendingApprovalId, action }) });
      const decisionData = await decision.json();
      if (!decision.ok) throw new Error(decisionData.error || "Décision impossible.");
      if (action === "reject") {
        setMessage("Publication rejetée. Aucun envoi externe n'a été effectué.");
        setPendingApprovalId(null);
        return;
      }
      const publish = await authFetch("/api/ads/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: pendingApprovalId }) });
      const publishData = await publish.json();
      if (!publish.ok) throw new Error(publishData.error || "Publication impossible.");
      setPublishResult("Publication effectuée avec succès.");
      setMessage("");
      setPendingApprovalId(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Action impossible");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="g3-card p-6"><div className="flex items-center justify-between"><h2 className="font-serif text-xl font-semibold">Générateur publicitaire</h2><span className="rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-xs text-emerald-600">Sécurité active</span></div><p className="mt-2 text-sm text-neutral-500">Décrivez le résultat attendu. L&apos;orchestrateur sélectionne les compétences et outils nécessaires.</p><textarea value={objective} onChange={e => setObjective(e.target.value)} placeholder="Ex. Analyse mon marché, prépare une campagne et propose les créations publicitaires…" className="g3-textarea mt-5 min-h-40" /><button disabled={busy || objective.trim().length < 10} onClick={generateAd} className="g3-btn g3-btn-primary mt-4">Lancer l&apos;agent Ads</button>{message && <div className="anim-fade-in mt-4 rounded-xl border border-violet-200 bg-violet-100 p-4 text-sm text-violet-700">{message}</div>}</div>
        <div className="g3-card p-6"><h2 className="font-serif text-xl font-semibold">Connexions Ads</h2><p className="mt-2 text-sm text-neutral-500">Les jetons sont stockés chiffrés côté serveur. Une publication externe exige une validation humaine.</p><div className="mt-5 space-y-3">{(Object.keys(labels) as Provider[]).map(provider => <button key={provider} disabled={busy} onClick={() => connectAds(provider)} className="flex w-full items-center justify-between rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4 text-left hover:bg-neutral-100"><span>{labels[provider]}</span><span className={connections.includes(provider) ? "text-emerald-600 text-sm" : "text-sky-700 text-sm"}>{connections.includes(provider) ? "Connecté" : "Connecter"}</span></button>)}</div></div>
      </section>
      <section className="grid grid-cols-1 gap-5 md:grid-cols-3">
        <div className="g3-card p-5 md:col-span-3">
          <h3 className="font-serif text-lg font-semibold">Validation humaine</h3>
          <p className="mt-2 text-sm text-neutral-500">Aucune publication ne part sans votre décision explicite. Le coût de publication est débité du portefeuille après exécution.</p>
          {pendingApprovalId ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <span className="font-mono text-xs text-amber-800">Approbation en attente : {pendingApprovalId}</span>
              <button disabled={busy} onClick={() => decideApproval("approve")} className="g3-btn g3-btn-primary">Approuver &amp; publier</button>
              <button disabled={busy} onClick={() => decideApproval("reject")} className="rounded-full border border-[rgba(23,23,20,0.09)] bg-white px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-100">Rejeter</button>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4 text-sm text-neutral-400">Aucune publication en attente de validation.</p>
          )}
          {publishResult && <div className="anim-fade-in mt-3 rounded-xl border border-emerald-200 bg-emerald-100 p-4 text-sm text-emerald-700">{publishResult}</div>}
        </div>
        <Feature title="Terminal IA" text="Un terminal sandboxé réservé aux agents. Aucun accès direct utilisateur au shell d'exécution." />
        <FeatureLink href="/memory" title="Mémoire permanente" text="Souvenirs et documents (100 Mo max, 10 fichiers par lot) conservés pour vos missions. Gestion sur une page dédiée." cta="Ouvrir la mémoire" />
        <Feature title="Caméra & fichiers" text="La caméra fonctionne uniquement après autorisation explicite. Les captures et fichiers peuvent être conservés dans le stockage permanent." />
      </section>
      <footer className="rounded-2xl border border-amber-200 bg-amber-100 p-4 text-xs text-amber-700">Les actions externes, dépenses publicitaires et opérations sensibles restent soumises aux politiques de sécurité et à une confirmation humaine. Les agents ne peuvent pas contourner ces contrôles.</footer>
    </div>
  );
}

function Feature({ title, text }: { title: string; text: string }) {
  return <div className="g3-card p-5"><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-neutral-500">{text}</p></div>;
}

function FeatureLink({ href, title, text, cta }: { href: string; title: string; text: string; cta: string }) {
  return <Link href={href} className="g3-card block p-5 transition hover:bg-white"><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-neutral-500">{text}</p><span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-sky-700">{cta} →</span></Link>;
}

function StudioPageInner() {
  const [tab, setTab] = useState<"agents" | "ads">("agents");
  const searchParams = useSearchParams();
  const initialTask = searchParams.get("task") ?? "";
  const taskId = searchParams.get("taskId") ?? "";
  const [, setUser] = useState<User | null>(null);

  useEffect(() => onAuthStateChanged(auth, (current) => setUser(current)), []);

  return (
    <div className="min-h-full bg-[#f6f4ef] text-neutral-900 p-4 md:p-8">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="g3-eyebrow">GEN3IA AI STUDIO</div>
            <h1 className="mt-2 font-serif text-3xl font-semibold tracking-tight md:text-4xl">Studio d&apos;agents IA</h1>
            <p className="mt-2 max-w-2xl text-sm text-neutral-500 md:text-base">Créez un agent, personnalisez-le, exécutez-le immédiatement. Les agents de code accèdent en exclusivité à l&apos;Atelier d&apos;Interfaces propulsé par 21st.dev.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/memory" className="g3-btn g3-btn-ghost text-xs">Mémoire<span className="rounded-md border border-emerald-200 bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-700">Nouveau</span></Link>
            <Link href="/marketplace" className="g3-btn g3-btn-ghost text-xs">Marketplace</Link>
            <Link href="/live" className="g3-btn g3-btn-ghost text-xs">Agent Live<span className="rounded-md border border-amber-200 bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-700">PC</span></Link>
          </div>
        </header>

        <div className="mb-6">
          <AnimatedTabs
            ariaLabel="Sections du studio"
            active={tab}
            onChange={(key) => setTab(key as "agents" | "ads")}
            tabs={[
              { key: "agents", label: "🤖 Mes agents" },
              { key: "ads", label: "📣 Studio Ads" },
            ]}
          />
        </div>

        {tab === "agents" ? <div className="space-y-6">{taskId ? <WorkspaceTaskPanel taskId={taskId} /> : <AgentManager />}<UniversalAgentChat initialMessage={taskId ? "" : initialTask} /></div> : <AdsWorkshop />}
      </div>
    </div>
  );
}

export default function StudioPage() {
  return (
    <Suspense fallback={<div className="min-h-full bg-[#f6f4ef]" />}>
      <StudioPageInner />
    </Suspense>
  );
}
