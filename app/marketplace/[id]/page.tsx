"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { authFetch, useSessionAvailable } from "@/lib/firebase/auth-client";
import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";

type Fiche = {
  extension: {
    id: string; name: string; description: string; category: string; tags: string[];
    developerName: string; status: string; latestVersion: string | null; approvedVersion: string | null;
    pricing: { model: string; amountMinor?: number; unitAmountMinor?: number; currency?: string; interval?: string };
    permissions: string[]; stats: { installs: number; ratingCount: number; rating: number | null };
  };
  version: {
    version: string; changelog: string;
    tools: Array<{ id: string; name: string; description: string }>;
    skills: Array<{ id: string; name: string; description: string }>;
    workflows: Array<{ id: string; name: string; description: string }>;
    settings?: Array<{ key: string; label: string; description?: string; type: string; default: string | number | boolean }>;
  } | null;
  reviews: Array<{ userId: string; rating: number; title: string | null; body: string; createdAt: number }>;
  userState: { installed: boolean; version?: string; status?: string; entitled: boolean } | null;
};

function price(pricing: Fiche["extension"]["pricing"]) {
  if (pricing.model === "free") return "Gratuit";
  if (pricing.model === "usage") return `${((pricing.unitAmountMinor ?? 0) / 100).toLocaleString("fr-FR")} ${pricing.currency ?? "XAF"} / utilisation`;
  const amount = `${((pricing.amountMinor ?? 0) / 100).toLocaleString("fr-FR")} ${pricing.currency ?? "XAF"}`;
  return pricing.model === "subscription" ? `${amount} / ${pricing.interval === "year" ? "an" : "mois"}` : amount;
}

function permissionDescription(permission: string) {
  if (permission === "storage.read") return "Lire les fichiers explicitement accessibles à l'extension.";
  if (permission === "storage.write") return "Créer ou modifier des fichiers autorisés.";
  if (permission === "memory.read") return "Consulter la mémoire autorisée de l'agent.";
  if (permission === "memory.write") return "Enregistrer des informations dans la mémoire autorisée.";
  if (permission === "agent.invoke") return "Déclencher une capacité d'agent autorisée.";
  if (permission.startsWith("http.fetch:")) return `Accéder au domaine externe ${permission.slice("http.fetch:".length)}.`;
  return "Capacité déclarée par le manifeste approuvé.";
}

export default function ExtensionFichePage() {
  const sessionDisponible = useSessionAvailable();
  const [fiche, setFiche] = useState<Fiche | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [rating, setRating] = useState(5);
  const [reviewBody, setReviewBody] = useState("");
  const [permissionDraft, setPermissionDraft] = useState<string[]>([]);
  const [permissionsDirty, setPermissionsDirty] = useState(false);
  const [runResult, setRunResult] = useState<{ tool: string; output: string } | null>(null);

  const load = useCallback(async () => {
    const id = window.location.pathname.split("/").pop();
    // authFetch : ID token Firebase si disponible, sinon cookie de session.
    const response = await authFetch(`/api/extensions/${id}?reviews=1`, { cache: "no-store" });
    if (response.status === 401) throw new Error("Session expirée. Reconnectez-vous.");
    if (!response.ok) throw new Error("Impossible de charger cette extension.");
    const data = await response.json() as Fiche;
    setFiche(data);
    setPermissionDraft(data.extension.permissions);
    setPermissionsDirty(false);
  }, []);

  useEffect(() => {
    if (sessionDisponible === false) return;
    const timer = setTimeout(() => { void load().catch((e) => setMessage(e instanceof Error ? e.message : "Erreur de chargement")); }, 0);
    return () => clearTimeout(timer);
  }, [load, sessionDisponible]);

  if (sessionDisponible === null) return <div className="min-h-full bg-[var(--g3-bg)] p-10 text-center text-neutral-500">Chargement…</div>;
  if (sessionDisponible === false) return <FeatureAuthGate feature="Marketplace Gen3ia" description="Connectez-vous pour consulter les extensions, leurs permissions, leurs versions et leurs avis."><span /></FeatureAuthGate>;
  if (!fiche) return <div className="min-h-full bg-[var(--g3-bg)] p-10 text-center text-neutral-500">{message || "Chargement…"}</div>;

  const { extension, version, reviews, userState } = fiche;
  const action = async (path: string, init?: RequestInit) => {
    setBusy(true); setMessage("");
    try {
      const response = await authFetch(`/api/extensions/${extension.id}${path}`, {
        ...init,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) throw new Error("Session expirée. Reconnectez-vous.");
      if (!response.ok) throw new Error(data.error ?? "Action impossible");
      if (data.checkoutUrl) { window.location.href = data.checkoutUrl; return; }
      setMessage(data.status === "updated" ? "Extension mise à jour." : data.status === "uninstalled" ? "Extension désinstallée." : data.status === "purchased" ? (data.message ?? "Achat effectué.") : data.status === "reported" ? "Signalement envoyé." : "Action effectuée.");
      await load();
    } catch (e) { setMessage(e instanceof Error ? e.message : "Action impossible"); }
    finally { setBusy(false); }
  };

  const savePermissions = async () => {
    await action("/permissions", { method: "PATCH", body: JSON.stringify({ permissions: permissionDraft }) });
  };

  const submitReview = async () => {
    if (reviewBody.trim().length < 4) return;
    await action("/reviews", { method: "POST", body: JSON.stringify({ rating, body: reviewBody.trim() }) });
    setReviewBody("");
  };

  const runTool = async (toolId: string) => {
    setBusy(true); setMessage(""); setRunResult(null);
    try {
      const response = await authFetch(`/api/extensions/${extension.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolId, input: {} }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? "Exécution impossible");
      setRunResult({ tool: toolId, output: JSON.stringify(data.output ?? data, null, 2).slice(0, 4000) });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Exécution impossible");
    } finally { setBusy(false); }
  };

  return (
    <div className="min-h-full bg-[var(--g3-bg)] p-4 text-neutral-900 sm:p-6 md:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-4">
          <Link href="/marketplace" className="text-sm text-neutral-500 hover:text-neutral-900">← Marketplace</Link>
          <Link href="/marketplace/purchases" className="text-xs font-semibold text-sky-700 hover:text-sky-800">Achats & licences →</Link>
        </div>

        <header className="mt-4 overflow-hidden rounded-[30px] border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)] md:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="max-w-3xl">
              <div className="flex flex-wrap gap-2"><span className="rounded-full bg-neutral-100 px-3 py-1 text-xs text-neutral-500">{extension.category}</span><span className="rounded-full bg-violet-100 px-3 py-1 text-xs text-violet-700">v{extension.approvedVersion ?? extension.latestVersion ?? "—"}</span><span className="rounded-full bg-emerald-100 px-3 py-1 text-xs text-emerald-600">Version approuvée</span></div>
              <h1 className="mt-4 font-serif text-3xl font-bold tracking-tight sm:text-4xl">{extension.name}</h1>
              <p className="mt-2 text-sm text-neutral-500">par {extension.developerName} · {extension.stats.installs.toLocaleString("fr-FR")} installations · {extension.stats.rating !== null ? `${extension.stats.rating}/5 (${extension.stats.ratingCount} avis)` : "pas encore notée"}</p>
              <p className="mt-5 text-sm leading-7 text-neutral-600">{extension.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">{extension.tags.map((tag) => <span key={tag} className="rounded-md bg-neutral-100 px-2.5 py-1 text-[11px] text-neutral-500">#{tag}</span>)}</div>
            </div>
            <div className="w-full shrink-0 lg:w-72">
              <div className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-5 text-center"><div className="text-2xl font-bold text-violet-700">{price(extension.pricing)}</div><p className="mt-1 text-[11px] text-neutral-400">Paiement et entitlement vérifiés côté serveur</p></div>
              <div className="mt-3 space-y-2">
                {userState?.installed ? <><div className="rounded-xl border border-emerald-200 bg-emerald-100 px-4 py-2.5 text-center text-sm text-emerald-600">Installée · v{userState.version}</div><button disabled={busy} onClick={() => action("/update", { method: "POST" })} className="w-full rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm font-semibold hover:bg-neutral-50 disabled:opacity-40">Mettre à jour</button><button disabled={busy} onClick={() => action("/install", { method: "DELETE" })} className="w-full rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-600 disabled:opacity-40">Désinstaller</button></> : <button disabled={busy || extension.status !== "approved"} onClick={() => action("/install", { method: "POST", body: "{}" })} className="w-full rounded-full bg-neutral-900 px-4 py-3 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-40">{extension.pricing.model === "free" ? "Installer gratuitement" : "Acheter & installer"}</button>}
                <button disabled={busy} onClick={() => action("/reports", { method: "POST", body: JSON.stringify({ reason: "other", details: "Signalement depuis la fiche." }) })} className="w-full py-2 text-xs text-neutral-400 hover:text-neutral-600">Signaler cette extension</button>
              </div>
            </div>
          </div>
        </header>

        {message && <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-neutral-800">{message}</div>}

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.35fr_.9fr]">
          <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
            <div className="flex items-end justify-between gap-3"><div><p className="text-[10px] font-bold tracking-[.2em] text-sky-700">CAPACITÉS</p><h2 className="mt-1 font-serif text-xl font-semibold">Tools, skills & workflows</h2></div><span className="text-xs text-neutral-400">{(version?.tools.length ?? 0) + (version?.skills.length ?? 0) + (version?.workflows.length ?? 0)} capacités</span></div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {(version?.tools ?? []).map((tool) => <div key={`tool-${tool.id}`} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4"><span className="text-[10px] font-bold uppercase tracking-wider text-sky-700">Tool</span><h3 className="mt-2 text-sm font-semibold">{tool.name}</h3><p className="mt-1 text-xs leading-5 text-neutral-500">{tool.description}</p><code className="mt-3 block truncate text-[10px] text-neutral-400">ext.{extension.id}.{tool.id}</code>{userState?.installed && <button disabled={busy} onClick={() => runTool(tool.id)} className="mt-3 rounded-full bg-sky-700 px-4 py-2 text-xs font-semibold text-white transition hover:bg-sky-800 disabled:opacity-40">Exécuter</button>}{runResult?.tool === tool.id && <pre className="mt-3 max-h-56 overflow-auto rounded-xl border border-neutral-200 bg-white p-3 text-[11px] leading-5 text-neutral-700" role="status">{runResult.output}</pre>}</div>)}
              {(version?.skills ?? []).map((skill) => <div key={`skill-${skill.id}`} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4"><span className="text-[10px] font-bold uppercase tracking-wider text-violet-700">Skill</span><h3 className="mt-2 text-sm font-semibold">{skill.name}</h3><p className="mt-1 text-xs leading-5 text-neutral-500">{skill.description}</p></div>)}
              {(version?.workflows ?? []).map((workflow) => <div key={`workflow-${workflow.id}`} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4"><span className="text-[10px] font-bold uppercase tracking-wider text-amber-700">Workflow</span><h3 className="mt-2 text-sm font-semibold">{workflow.name}</h3><p className="mt-1 text-xs leading-5 text-neutral-500">{workflow.description}</p></div>)}
            </div>
            {!version && <p className="mt-4 text-sm text-neutral-400">Aucune version approuvée disponible.</p>}
          </section>

          <div className="space-y-5">
            <section className="rounded-3xl border border-amber-200 bg-amber-50 p-6">
              <p className="text-[10px] font-bold tracking-[.2em] text-amber-700">SÉCURITÉ</p><h2 className="mt-1 font-serif text-xl font-semibold">Permissions</h2><p className="mt-2 text-xs leading-5 text-neutral-500">Vous pouvez retirer des permissions. Une permission absente du manifeste approuvé ne peut pas être ajoutée.</p>
              <div className="mt-4 space-y-2">{permissionDraft.map((permission) => <label key={permission} className="flex cursor-pointer items-start gap-3 rounded-xl border border-neutral-200 bg-white p-3"><input type="checkbox" checked={permissionDraft.includes(permission)} onChange={(e) => { if (!e.target.checked) { setPermissionDraft((current) => current.filter((item) => item !== permission)); setPermissionsDirty(true); } }} className="mt-1 accent-neutral-900" /><span className="min-w-0"><code className="break-all text-[11px] text-amber-700">{permission}</code><span className="mt-1 block text-[10px] leading-4 text-neutral-400">{permissionDescription(permission)}</span></span></label>)}</div>
              {userState?.installed && <button disabled={busy || !permissionsDirty} onClick={savePermissions} className="mt-4 w-full rounded-full bg-amber-100 px-4 py-2.5 text-xs font-semibold text-amber-700 disabled:opacity-30">Enregistrer les permissions</button>}
            </section>

            <section className="rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"><p className="text-[10px] font-bold tracking-[.2em] text-neutral-400">VERSION</p><h2 className="mt-1 font-serif text-xl font-semibold">{version?.version ?? "—"}</h2><p className="mt-3 text-sm leading-6 text-neutral-500 whitespace-pre-wrap">{version?.changelog || "Aucun changelog fourni."}</p><div className="mt-4 rounded-xl bg-neutral-50 p-3 text-[11px] text-neutral-400">Les versions sont publiées uniquement après validation du manifeste et de ses permissions.</div></section>
          </div>
        </div>

        <section className="mt-5 rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-6 shadow-[0_2px_10px_rgba(15,23,42,0.05)]">
          <div className="flex items-center justify-between"><div><p className="text-[10px] font-bold tracking-[.2em] text-neutral-400">COMMUNAUTÉ</p><h2 className="mt-1 font-serif text-xl font-semibold">Avis utilisateurs</h2></div><span className="text-xs text-neutral-400">{reviews.length} avis</span></div>
          {userState?.installed && <div className="mt-5 rounded-2xl border border-neutral-200 bg-neutral-50 p-4"><div className="flex items-center gap-1">{[1,2,3,4,5].map((star) => <button key={star} onClick={() => setRating(star)} aria-label={`${star} étoiles`} className={star <= rating ? "text-amber-700" : "text-neutral-300"}>★</button>)}</div><textarea value={reviewBody} onChange={(e) => setReviewBody(e.target.value)} placeholder="Partagez votre expérience…" className="mt-3 min-h-24 w-full rounded-xl border border-neutral-200 bg-white p-3 text-sm outline-none placeholder:text-neutral-400"/><button disabled={busy || reviewBody.trim().length < 4} onClick={submitReview} className="mt-3 rounded-full bg-neutral-900 px-4 py-2.5 text-xs font-semibold text-white hover:bg-neutral-800 disabled:opacity-40">Publier mon avis</button></div>}
          <div className="mt-5 grid gap-3 md:grid-cols-2">{reviews.map((review, index) => <article key={`${review.createdAt}-${index}`} className="rounded-2xl border border-neutral-200 bg-neutral-50 p-4"><div className="flex items-center justify-between gap-3 text-xs"><span className="text-neutral-400">Utilisateur vérifié</span><span className="text-amber-700">{"★".repeat(Math.max(0, Math.min(5, review.rating)))}</span></div>{review.title && <h3 className="mt-2 text-sm font-semibold">{review.title}</h3>}<p className="mt-2 text-sm leading-6 text-neutral-500">{review.body}</p></article>)}{reviews.length === 0 && <p className="text-sm text-neutral-400">Aucun avis pour le moment.</p>}</div>
        </section>
      </div>
    </div>
  );
}
