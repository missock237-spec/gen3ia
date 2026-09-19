"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/firebase/auth-client";

interface VoiceNumber {
  id: string;
  phoneNumber: string;
  twilioSid: string;
  source: "gen3ia" | "own";
  status: string;
}

interface Props {
  agentId: string;
  onDone: () => void | Promise<void>;
}

export function VoiceAgentSetup({ agentId, onDone }: Props) {
  const [numbers, setNumbers] = useState<VoiceNumber[]>([]);
  const [available, setAvailable] = useState<Array<{ phoneNumber: string; friendlyName: string; locality: string; region: string }>>([]);
  const [country, setCountry] = useState("US");
  const [areaCode, setAreaCode] = useState("");
  const [ownNumber, setOwnNumber] = useState("");
  const [target, setTarget] = useState("");
  const [greeting, setGreeting] = useState("Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?");
  const [language, setLanguage] = useState("fr-FR");
  const [maxDurationSeconds, setMaxDurationSeconds] = useState(300);
  const [maxTurns, setMaxTurns] = useState(20);
  const [inboundEnabled, setInboundEnabled] = useState(true);
  const [outboundEnabled, setOutboundEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [priceMinor, setPriceMinor] = useState<number | null>(null);
  const [currency, setCurrency] = useState("XAF");

  const load = async () => {
    const [numberResponse, voiceResponse] = await Promise.all([
      authFetch("/api/voice/numbers?agentId=" + encodeURIComponent(agentId), { cache: "no-store" }),
      authFetch("/api/agents/" + encodeURIComponent(agentId) + "/voice", { cache: "no-store" }),
    ]);
    if (numberResponse.ok) {
      const data = await numberResponse.json();
      setNumbers(data.numbers ?? []);
    }
    if (voiceResponse.ok) {
      const data = await voiceResponse.json();
      const voice = data.voice;
      if (voice) {
        setGreeting(voice.greeting ?? "Bonjour, je suis l'agent IA de Gen3ia. Comment puis-je vous aider ?");
        setLanguage(voice.language ?? "fr-FR");
        setMaxTurns(Number(voice.maxTurns ?? 20));
        setMaxDurationSeconds(Number(voice.maxDurationSeconds ?? 300));
        setInboundEnabled(voice.inboundEnabled !== false);
        setOutboundEnabled(voice.outboundEnabled !== false);
      }
    }
  };

  useEffect(() => { void load(); }, [agentId]);

  const search = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const query = "/api/voice/numbers?country=" + encodeURIComponent(country) + (areaCode.trim() ? "&areaCode=" + encodeURIComponent(areaCode.trim()) : "");
      const response = await authFetch(query, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Recherche impossible.");
      setAvailable(data.numbers ?? []);
      setPriceMinor(Number(data.monthlyPriceMinor ?? 0));
      setCurrency(String(data.currency ?? "XAF"));
      setMessage("Numéros disponibles chargés.");
    } catch (e) { setError(e instanceof Error ? e.message : "Recherche impossible."); }
    finally { setBusy(false); }
  };

  const buy = async (phoneNumber: string) => {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/voice/numbers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, phoneNumber }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Achat impossible.");
      setMessage("Numéro acheté et attribué à l'agent.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Achat impossible."); }
    finally { setBusy(false); }
  };

  const attach = async () => {
    if (!/^\+[1-9]\d{7,14}$/.test(ownNumber.trim())) {
      setError("Utilisez un numéro au format E.164, par exemple +14155551234.");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/voice/numbers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId, phoneNumber: ownNumber.trim(), source: "own" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Attribution impossible.");
      setMessage("Votre numéro Twilio a été attribué à l'agent.");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Attribution impossible."); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/agents/" + agentId + "/voice", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voiceEnabled: true, language, greeting, maxTurns, maxDurationSeconds, inboundEnabled, outboundEnabled }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Enregistrement impossible.");
      setMessage("Personnalisation vocale enregistrée.");
    } catch (e) { setError(e instanceof Error ? e.message : "Enregistrement impossible."); }
    finally { setBusy(false); }
  };

  const testCall = async () => {
    if (!/^\+[1-9]\d{7,14}$/.test(target.trim())) {
      setError("Numéro de destination invalide.");
      return;
    }
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/agents/" + agentId + "/voice/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: target.trim(), objective: "Présente-toi et demande au correspondant comment tu peux l'aider." }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Appel impossible.");
      setMessage("Appel lancé depuis " + data.from + " vers " + data.to + ".");
    } catch (e) { setError(e instanceof Error ? e.message : "Appel impossible."); }
    finally { setBusy(false); }
  };

  return (
    <section className="g3-card anim-slide-up p-5 md:p-7">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="g3-eyebrow">AGENT D’APPEL</div>
          <h3 className="mt-1 text-xl font-bold">Attribuer un vrai numéro</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-neutral-500">L’agent reste entièrement personnalisable comme les autres agents. Le numéro sert aux appels entrants et sortants selon les réglages ci-dessous.</p>
        </div>
        <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">Voix active</span>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 p-4">
            <h4 className="font-semibold">1. Acheter un numéro Gen3ia</h4>
            {priceMinor !== null && <p className="mt-1 text-xs font-semibold text-sky-700">Prix d’attribution Gen3ia configuré : {(priceMinor / 100).toFixed(2)} {currency}</p>}
            <p className="mt-1 text-xs leading-5 text-neutral-500">Gen3ia cherche un numéro Twilio disponible puis l’attribue à cet agent. Le prix Gen3ia est débité du wallet.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <input className="g3-input" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} placeholder="US" maxLength={2} />
              <input className="g3-input" value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 5))} placeholder="Area code (optionnel)" />
            </div>
            <button type="button" className="g3-btn g3-btn-primary mt-3" disabled={busy || country.length !== 2} onClick={search}>{busy ? "Recherche…" : "Rechercher des numéros"}</button>
            {available.length > 0 && <div className="mt-3 max-h-48 space-y-2 overflow-auto">{available.map((item) => <div key={item.phoneNumber} className="flex items-center justify-between gap-2 rounded-xl border bg-white p-3"><div><div className="font-semibold">{item.phoneNumber}</div><div className="text-[11px] text-neutral-500">{item.locality}{item.region ? ", " + item.region : ""}</div></div><button type="button" className="g3-btn g3-btn-cyan !px-3 !py-2 text-xs" disabled={busy} onClick={() => buy(item.phoneNumber)}>Acheter</button></div>)}</div>}
          </div>

          <div className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-4">
            <h4 className="font-semibold">2. Utiliser votre propre numéro</h4>
            <p className="mt-1 text-xs leading-5 text-neutral-500">Pour que Gen3ia reçoive directement les appels, le numéro doit être déjà dans le compte Twilio Gen3ia, ou être porté/hébergé chez Twilio. Un simple Caller ID vérifié ne suffit pas pour recevoir les appels.</p>
            <div className="mt-3 flex gap-2"><input className="g3-input flex-1" value={ownNumber} onChange={(e) => setOwnNumber(e.target.value)} placeholder="+14155551234" /><button type="button" className="g3-btn g3-btn-ghost" disabled={busy} onClick={attach}>Attribuer</button></div>
          </div>

          {numbers.map((number) => <div key={number.id} className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div><div className="font-semibold text-emerald-800">{number.phoneNumber}</div><div className="text-xs text-emerald-700">{number.source === "gen3ia" ? "Numéro acheté par Gen3ia" : "Votre numéro"} · actif</div></div><span className="text-lg">📞</span></div>)}
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-[rgba(23,23,20,0.09)] bg-white p-4">
            <h4 className="font-semibold">3. Personnaliser l’agent vocal</h4>
            <div className="mt-4 space-y-3">
              <label className="g3-label">Langue<select className="g3-select mt-1" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="fr-FR">Français</option><option value="en-US">English US</option><option value="en-GB">English UK</option><option value="es-ES">Español</option><option value="de-DE">Deutsch</option></select></label>
              <label className="g3-label">Phrase d’accueil<textarea className="g3-textarea mt-1 min-h-24" value={greeting} onChange={(e) => setGreeting(e.target.value)} maxLength={800} /></label>
              <div className="grid grid-cols-2 gap-2"><label className="g3-label">Tours max<input className="g3-input mt-1" type="number" min={1} max={40} value={maxTurns} onChange={(e) => setMaxTurns(Number(e.target.value))} /></label><label className="g3-label">Durée max (s)<input className="g3-input mt-1" type="number" min={30} max={1800} value={maxDurationSeconds} onChange={(e) => setMaxDurationSeconds(Number(e.target.value))} /></label></div>
              <div className="grid grid-cols-2 gap-2"><Toggle label="Appels entrants" checked={inboundEnabled} onChange={setInboundEnabled} /><Toggle label="Appels sortants" checked={outboundEnabled} onChange={setOutboundEnabled} /></div>
              <button type="button" className="g3-btn g3-btn-primary" disabled={busy} onClick={save}>Enregistrer la personnalisation</button>
            </div>
          </div>

          <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4">
            <h4 className="font-semibold text-sky-900">4. Tester un vrai appel</h4>
            <p className="mt-1 text-xs leading-5 text-sky-800">Le test utilise le numéro attribué à l’agent comme numéro appelant.</p>
            <div className="mt-3 flex gap-2"><input className="g3-input flex-1" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="+14155551234" /><button type="button" className="g3-btn g3-btn-primary" disabled={busy || numbers.length === 0} onClick={testCall}>Appeler</button></div>
          </div>
        </div>
      </div>

      {message && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{message}</div>}
      {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      <div className="mt-5 flex justify-end"><button type="button" className="g3-btn g3-btn-ghost" onClick={() => void onDone()}>Terminer</button></div>
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex cursor-pointer items-center justify-between rounded-xl border border-[rgba(23,23,20,0.09)] bg-neutral-50 px-3 py-2.5 text-sm"><span>{label}</span><button type="button" role="switch" aria-checked={checked} data-on={checked} className="g3-switch" onClick={() => onChange(!checked)} /></label>;
}
