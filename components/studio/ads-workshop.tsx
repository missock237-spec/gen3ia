"use client";

import { useEffect, useState } from "react";

import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { Callout } from "@/components/studio/callout";
import { FeatureCard, FeatureLinkCard } from "@/components/studio/feature-card";

type Provider = "google_ads" | "meta_ads" | "tiktok_ads";

const PROVIDER_LABELS: Record<Provider, string> = {
  google_ads: "Google Ads",
  meta_ads: "Meta Ads",
  tiktok_ads: "TikTok Ads",
};

/**
 * Atelier publicitaire du Studio (extrait de app/studio/page.tsx).
 * Flux complet : connexion OAuth → génération → validation humaine → publication.
 * Toutes les notifications passent par le Callout unifié.
 */
export function AdsWorkshop() {
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
    try {
      const response = await authFetch("/api/ads/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      window.location.assign(data.authorizationUrl);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Connexion impossible");
      setBusy(false);
    }
  };

  const generateAd = async () => {
    if (sessionDisponible === false) { setMessage("Session expirée. Reconnectez-vous."); return; }
    if (objective.trim().length < 10) return;
    setBusy(true); setMessage(""); setPendingApprovalId(null); setPublishResult("");
    try {
      const provider = connections[0];
      if (!provider) throw new Error("Connectez d'abord un compte Ads.");
      const response = await authFetch("/api/ads/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ objective, provider, accountId: "connected", destinationUrl: "https://gen3ia.com" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setPendingApprovalId(String(data.approvalId ?? ""));
      setMessage("Publicité générée. Validation humaine requise avant publication : approuvez ou rejetez la publication ci-dessous.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Génération impossible");
    } finally {
      setBusy(false);
    }
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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="g3-card p-6">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-xl font-semibold">Générateur publicitaire</h2>
            <span className="rounded-full border border-emerald-200 bg-emerald-100 px-3 py-1 text-xs text-emerald-600">Sécurité active</span>
          </div>
          <p className="mt-2 text-sm text-neutral-500">Décrivez le résultat attendu. L&apos;orchestrateur sélectionne les compétences et outils nécessaires.</p>
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Ex. Analyse mon marché, prépare une campagne et propose les créations publicitaires…"
            className="g3-textarea mt-5 min-h-40"
            aria-label="Objectif publicitaire"
          />
          <button disabled={busy || objective.trim().length < 10} onClick={generateAd} className="g3-btn g3-btn-primary mt-4">Lancer l&apos;agent Ads</button>
          {message && <Callout tone="info" className="mt-4">{message}</Callout>}
        </div>
        <div className="g3-card p-6">
          <h2 className="font-serif text-xl font-semibold">Connexions Ads</h2>
          <p className="mt-2 text-sm text-neutral-500">Les jetons sont stockés chiffrés côté serveur. Une publication externe exige une validation humaine.</p>
          <div className="mt-5 space-y-3">
            {(Object.keys(PROVIDER_LABELS) as Provider[]).map((provider) => (
              <button
                key={provider}
                disabled={busy}
                onClick={() => connectAds(provider)}
                aria-label={connections.includes(provider) ? `${PROVIDER_LABELS[provider]} connecté` : `Connecter ${PROVIDER_LABELS[provider]}`}
                className="flex w-full items-center justify-between rounded-xl border border-[var(--g3-border)] bg-neutral-50 p-4 text-left hover:bg-neutral-100"
              >
                <span>{PROVIDER_LABELS[provider]}</span>
                <span className={connections.includes(provider) ? "text-emerald-600 text-sm" : "text-sky-700 text-sm"}>
                  {connections.includes(provider) ? "Connecté" : "Connecter"}
                </span>
              </button>
            ))}
          </div>
          {loaded && (memoryCount > 0 || fileCount > 0) && (
            <p className="mt-4 text-xs text-neutral-400">
              Ressources disponibles : {memoryCount} souvenir{memoryCount > 1 ? "s" : ""} · {fileCount} fichier{fileCount > 1 ? "s" : ""} permanent{fileCount > 1 ? "s" : ""}.
            </p>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-5 md:grid-cols-3">
        <div className="g3-card p-5 md:col-span-3">
          <h3 className="font-serif text-lg font-semibold">Validation humaine</h3>
          <p className="mt-2 text-sm text-neutral-500">Aucune publication ne part sans votre décision explicite. Le coût de publication est débité du portefeuille après exécution.</p>
          {pendingApprovalId ? (
            <div className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <span className="font-mono text-xs text-amber-800">Approbation en attente : {pendingApprovalId}</span>
              <button disabled={busy} onClick={() => decideApproval("approve")} className="g3-btn g3-btn-primary">Approuver &amp; publier</button>
              <button disabled={busy} onClick={() => decideApproval("reject")} className="rounded-full border border-[var(--g3-border)] bg-white px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-100">Rejeter</button>
            </div>
          ) : (
            <p className="mt-4 rounded-xl border border-[var(--g3-border)] bg-neutral-50 p-4 text-sm text-neutral-400">Aucune publication en attente de validation.</p>
          )}
          {publishResult && <Callout tone="success" className="mt-3">{publishResult}</Callout>}
        </div>
        <FeatureCard title="Terminal IA" text="Un terminal sandboxé réservé aux agents. Aucun accès direct utilisateur au shell d'exécution." />
        <FeatureLinkCard href="/memory" title="Mémoire permanente" text="Souvenirs et documents (100 Mo max, 10 fichiers par lot) conservés pour vos missions. Gestion sur une page dédiée." cta="Ouvrir la mémoire" />
        <FeatureCard title="Caméra & fichiers" text="La caméra fonctionne uniquement après autorisation explicite. Les captures et fichiers peuvent être conservés dans le stockage permanent." />
      </section>

      <footer className="rounded-2xl border border-amber-200 bg-amber-100 p-4 text-xs text-amber-700">
        Les actions externes, dépenses publicitaires et opérations sensibles restent soumises aux politiques de sécurité et à une confirmation humaine. Les agents ne peuvent pas contourner ces contrôles.
      </footer>
    </div>
  );
}
