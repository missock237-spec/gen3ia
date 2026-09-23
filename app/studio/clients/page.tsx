"use client";

import { useEffect, useState } from "react";

import { authFetch } from "@/lib/firebase/auth-client";
import { StudioHeader } from "@/components/studio/studio-header";

/**
 * Client ID (/studio/clients) — personnalisation des agents commerciaux.
 *
 * L'utilisateur choisit un agent, fournit TOUTES les informations de son
 * entreprise (fiche complète), et obtient un LIEN CLIENT unique où ses
 * clients conversent avec l'agent commercial à sa place.
 */

interface CommercialConfig {
  id: string;
  agentId: string;
  companyName: string;
  sector?: string;
  products: string[];
  pricing: string[];
  faq: Array<{ question: string; answer: string }>;
  tone?: string;
  language: string;
  contactInfo?: { phone?: string; email?: string; website?: string; address?: string };
  openingHours?: string;
  welcomeMessage?: string;
  escalationContact?: string;
  clientSlug: string;
  active: boolean;
}

interface ClientChat {
  id: string;
  clientName?: string;
  clientContact?: string;
  messages: Array<{ role: string; content: string; at: number }>;
  updatedAt: number;
}

interface AgentOption {
  id: string;
  name: string;
  type: string;
}

const EMPTY_FORM = {
  agentId: "",
  companyName: "",
  sector: "",
  products: "",
  pricing: "",
  faq: "",
  tone: "Professionnel, chaleureux et efficace",
  language: "fr-FR",
  phone: "",
  email: "",
  website: "",
  address: "",
  openingHours: "",
  welcomeMessage: "Bonjour ! Je suis l'assistant de votre entreprise. Comment puis-je vous aider ?",
  escalationContact: "",
  active: true,
};

type FormState = typeof EMPTY_FORM;

function parseLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function parseFaq(value: string): Array<{ question: string; answer: string }> {
  const blocks = value.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const items: Array<{ question: string; answer: string }> = [];
  for (const block of blocks) {
    const [question, ...rest] = block.split("\n");
    const answer = rest.join(" ").trim();
    if (question?.trim() && answer) items.push({ question: question.replace(/^Q\s*:\s*/i, "").trim(), answer: answer.replace(/^R\s*:\s*/i, "") });
  }
  return items;
}

export default function StudioClientsPage() {
  const [configs, setConfigs] = useState<CommercialConfig[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [chats, setChats] = useState<ClientChat[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function reload() {
    setLoading(true);
    setError("");
    try {
      const [configResponse, agentResponse] = await Promise.all([
        authFetch("/api/commercial", { cache: "no-store" }),
        authFetch("/api/agents", { cache: "no-store" }),
      ]);
      const configData = await configResponse.json();
      const agentData = await agentResponse.json();
      if (!configResponse.ok) throw new Error(configData.error || "Chargement impossible.");
      if (agentResponse.ok) setAgents((agentData.agents ?? []).map((a: { id: string; name: string; type: string }) => ({ id: a.id, name: a.name, type: a.type })));
      setConfigs(configData.configs ?? []);
      if (configData.configs?.length > 0 && !selectedId) await selectConfig(configData.configs[0]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible.");
    } finally {
      setLoading(false);
    }
  }

  // Effet placé après les déclarations de fonctions (règle react-hooks).
  useEffect(() => { void reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps -- chargement initial uniquement

  async function selectConfig(config: CommercialConfig) {
    setSelectedId(config.id);
    setChats([]);
    try {
      const response = await authFetch("/api/commercial/" + encodeURIComponent(config.id), { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chargement impossible.");
      fillForm(data.config);
      setChats(data.chats ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chargement impossible.");
    }
  }

  function fillForm(config: CommercialConfig) {
    setForm({
      agentId: config.agentId,
      companyName: config.companyName ?? "",
      sector: config.sector ?? "",
      products: (config.products ?? []).join("\n"),
      pricing: (config.pricing ?? []).join("\n"),
      faq: (config.faq ?? []).map((item) => `Q : ${item.question}\nR : ${item.answer}`).join("\n\n"),
      tone: config.tone ?? "",
      language: config.language ?? "fr-FR",
      phone: config.contactInfo?.phone ?? "",
      email: config.contactInfo?.email ?? "",
      website: config.contactInfo?.website ?? "",
      address: config.contactInfo?.address ?? "",
      openingHours: config.openingHours ?? "",
      welcomeMessage: config.welcomeMessage ?? "",
      escalationContact: config.escalationContact ?? "",
      active: config.active,
    });
  }

  async function createConfig() {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const payload = {
        agentId: form.agentId || agents[0]?.id,
        companyName: form.companyName,
        sector: form.sector || undefined,
        products: parseLines(form.products),
        pricing: parseLines(form.pricing),
        faq: parseFaq(form.faq),
        tone: form.tone || undefined,
        language: form.language,
        contactInfo: {
          phone: form.phone || undefined,
          email: form.email || undefined,
          website: form.website || undefined,
          address: form.address || undefined,
        },
        openingHours: form.openingHours || undefined,
        welcomeMessage: form.welcomeMessage || undefined,
        escalationContact: form.escalationContact || undefined,
        active: form.active,
      };
      const response = await authFetch("/api/commercial", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Création impossible.");
      setMessage("Agent commercial créé. Partagez le lien client !");
      await reload();
      if (data.config) await selectConfig(data.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!selectedId || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const payload = {
        companyName: form.companyName,
        sector: form.sector || undefined,
        products: parseLines(form.products),
        pricing: parseLines(form.pricing),
        faq: parseFaq(form.faq),
        tone: form.tone || undefined,
        language: form.language,
        contactInfo: {
          phone: form.phone || undefined,
          email: form.email || undefined,
          website: form.website || undefined,
          address: form.address || undefined,
        },
        openingHours: form.openingHours || undefined,
        welcomeMessage: form.welcomeMessage || undefined,
        escalationContact: form.escalationContact || undefined,
        active: form.active,
      };
      const response = await authFetch("/api/commercial/" + encodeURIComponent(selectedId), {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Mise à jour impossible.");
      setMessage("Fiche entreprise enregistrée.");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Mise à jour impossible.");
    } finally {
      setBusy(false);
    }
  }

  async function rotateSlug() {
    if (!selectedId || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await authFetch("/api/commercial/" + encodeURIComponent(selectedId), {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ rotateSlug: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Rotation impossible.");
      setMessage("Nouveau lien client généré (l'ancien ne fonctionne plus).");
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rotation impossible.");
    } finally {
      setBusy(false);
    }
  }

  const selectedConfig = configs.find((config) => config.id === selectedId) ?? null;
  const clientLink = selectedConfig ? `${typeof window !== "undefined" ? window.location.origin : ""}/client/c/${selectedConfig.clientSlug}` : "";

  function copyLink() {
    if (!clientLink) return;
    void navigator.clipboard.writeText(clientLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2_000);
  }

  const inputClass = "w-full rounded-xl border border-[rgba(23,23,20,0.12)] bg-white px-3 py-2 text-sm";
  const labelClass = "block text-xs font-semibold text-neutral-500 mb-1";

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <StudioHeader
        eyebrow="STUDIO · CLIENTS"
        title="Client ID — agents commerciaux"
        description="Personnalisez un agent avec les informations de votre entreprise, puis partagez son lien client : vos clients discutent avec lui à votre place, avec exactitude."
      />

      {error && <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{error}</div>}
      {message && <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">{message}</div>}

      {loading ? (
        <p className="text-sm text-neutral-500">Chargement…</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <aside className="flex flex-col gap-3">
            <div className="rounded-2xl border border-[var(--g3-border)] bg-white p-4">
              <h2 className="mb-2 text-sm font-bold">Mes agents commerciaux</h2>
              {configs.length === 0 && <p className="text-xs text-neutral-500">Aucun agent commercial. Créez-en un ci-contre.</p>}
              <div className="flex flex-col gap-2">
                {configs.map((config) => (
                  <button
                    key={config.id}
                    type="button"
                    onClick={() => void selectConfig(config)}
                    className={"rounded-xl border px-3 py-2 text-left text-sm " + (selectedId === config.id ? "border-neutral-900 bg-neutral-900 text-white" : "border-[rgba(23,23,20,0.1)] bg-[#fafaf8]")}
                  >
                    <span className="block font-semibold">{config.companyName}</span>
                    <span className={"text-xs " + (selectedId === config.id ? "text-neutral-300" : "text-neutral-500")}>{config.active ? "actif" : "désactivé"}</span>
                  </button>
                ))}
              </div>
            </div>

            {selectedConfig && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                <h3 className="text-sm font-bold text-emerald-800">Lien client</h3>
                <code className="mt-2 block break-all rounded-lg bg-white px-2 py-2 text-[11px] text-emerald-900">{clientLink}</code>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={copyLink} className="flex-1 rounded-xl bg-emerald-700 px-3 py-2 text-xs font-bold text-white">{copied ? "Copié !" : "Copier le lien"}</button>
                  <a href={clientLink} target="_blank" rel="noreferrer" className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-bold text-emerald-800">Ouvrir</a>
                </div>
                <button type="button" onClick={() => void rotateSlug()} disabled={busy} className="mt-2 w-full rounded-xl border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800">
                  Régénérer le lien
                </button>
              </div>
            )}
          </aside>

          <section className="rounded-2xl border border-[var(--g3-border)] bg-white p-5">
            {configs.length === 0 ? (
              <div className="flex flex-col gap-4">
                <h2 className="text-base font-bold">Nouvel agent commercial</h2>
                <div>
                  <label className={labelClass}>Agent Gen3ia à transformer</label>
                  <select className={inputClass} value={form.agentId || (agents[0]?.id ?? "")} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.type})</option>)}
                  </select>
                  {agents.length === 0 && <p className="mt-1 text-xs text-red-600">Créez d&apos;abord un agent dans le Studio.</p>}
                </div>
                {sharedFields()}
                <button type="button" onClick={() => void createConfig()} disabled={busy || !form.companyName.trim() || !form.agentId} className="self-start rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                  {busy ? "Création…" : "Créer l'agent commercial"}
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <h2 className="text-base font-bold">Fiche entreprise — {selectedConfig?.companyName}</h2>
                {sharedFields()}
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void saveConfig()} disabled={busy} className="rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                    {busy ? "Enregistrement…" : "Enregistrer la fiche"}
                  </button>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                    Salon client actif
                  </label>
                </div>

                {chats.length > 0 && (
                  <div className="mt-2 border-t border-[rgba(23,23,20,0.08)] pt-4">
                    <h3 className="mb-2 text-sm font-bold">Conversations clients récentes</h3>
                    <div className="flex flex-col gap-2">
                      {chats.map((chat) => (
                        <details key={chat.id} className="rounded-xl border border-[rgba(23,23,20,0.1)] bg-[#fafaf8] px-3 py-2">
                          <summary className="cursor-pointer text-sm font-semibold">
                            {chat.clientName || "Client"} {chat.clientContact ? `· ${chat.clientContact}` : ""} — {new Date(chat.updatedAt).toLocaleString("fr-FR")}
                          </summary>
                          <div className="mt-2 flex max-h-56 flex-col gap-1 overflow-auto text-xs">
                            {chat.messages.slice(-12).map((entry, index) => (
                              <p key={index} className={entry.role === "client" ? "text-neutral-800" : "text-emerald-800"}>
                                <strong>{entry.role === "client" ? "Client" : "Agent"} :</strong> {entry.content.slice(0, 400)}
                              </p>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );

  function sharedFields(): React.JSX.Element {
    return (
      <>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass}>Nom de l&apos;entreprise *</label>
            <input className={inputClass} value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} maxLength={160} />
          </div>
          <div>
            <label className={labelClass}>Secteur d&apos;activité</label>
            <input className={inputClass} value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })} maxLength={200} placeholder="Restaurant, immobilier, artisan…" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass}>Produits / services (un par ligne)</label>
            <textarea className={inputClass} rows={4} value={form.products} onChange={(e) => setForm({ ...form, products: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Tarifs (un par ligne — l&apos;agent ne fera jamais d&apos;autres prix)</label>
            <textarea className={inputClass} rows={4} value={form.pricing} onChange={(e) => setForm({ ...form, pricing: e.target.value })} placeholder="Menu du jour : 12€&#10;Livraison : 3€" />
          </div>
        </div>
        <div>
          <label className={labelClass}>FAQ officielle (format : Q : question / R : réponse, un bloc vide entre chaque)</label>
          <textarea className={inputClass} rows={4} value={form.faq} onChange={(e) => setForm({ ...form, faq: e.target.value })} placeholder={"Q : Livrez-vous le soir ?\nR : Oui, de 18h à 22h dans tout le centre-ville."} />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass}>Téléphone</label>
            <input className={inputClass} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Email</label>
            <input className={inputClass} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Site web</label>
            <input className={inputClass} value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Adresse</label>
            <input className={inputClass} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </div>
          <div>
            <label className={labelClass}>Horaires</label>
            <input className={inputClass} value={form.openingHours} onChange={(e) => setForm({ ...form, openingHours: e.target.value })} placeholder="Lun-Sam 9h-19h" />
          </div>
          <div>
            <label className={labelClass}>Escalade (contact humain)</label>
            <input className={inputClass} value={form.escalationContact} onChange={(e) => setForm({ ...form, escalationContact: e.target.value })} placeholder="commercial@entreprise.com" />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelClass}>Ton de l&apos;agent</label>
            <input className={inputClass} value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} maxLength={300} />
          </div>
          <div>
            <label className={labelClass}>Langue</label>
            <select className={inputClass} value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
              <option value="fr-FR">Français</option>
              <option value="en-US">English</option>
              <option value="es-ES">Español</option>
              <option value="de-DE">Deutsch</option>
            </select>
          </div>
        </div>
        <div>
          <label className={labelClass}>Message d&apos;accueil</label>
          <input className={inputClass} value={form.welcomeMessage} onChange={(e) => setForm({ ...form, welcomeMessage: e.target.value })} maxLength={800} />
        </div>
      </>
    );
  }
}
