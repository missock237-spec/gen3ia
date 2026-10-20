"use client";

/**
 * NOVA CHAT — le dashboard EST le chat IA Gen3ia (/dashboard).
 *
 * Toutes nouvelles UI demandée par l'utilisateur, avec les 5 commandes du
 * composer :
 *  1. Bouton d'ENVOI du prompt (devient Arrêter pendant la génération) ;
 *  2. Bouton d'IMPORT DE FICHIERS (upload réel R2 + drag & drop + coller) ;
 *  3. Bouton d'OUTILS (plugins : applications connectées Composio + API
 *     personnelles — les slugs sélectionnés partent dans le tour) ;
 *  4. Bouton de SÉLECTION D'EFFORT (Rapide ⚡ / Équilibré 🎯 / Expert 🧠 —
 *     budget de réflexion du moteur neuronal Gen3) ;
 *  5. Bouton de RECHERCHE WEB (toggle : force une recherche réelle
 *     web.search pour le tour — champ « webSearch » de l'API).
 *
 * Toutes les fonctionnalités d'agents IA passent sous la commande de l'IA :
 * l'utilisateur DEMANDE en langage naturel (« crée un agent commercial
 * nommé Alex », « planifie une tâche chaque lundi », « crée un workflow… »)
 * et le moteur conversationnel exécute réellement (détecteurs
 * déterministes → outils réels → validations humaines si nécessaire).
 *
 * ÉCRITURE PROGRESSIVE : chaque mot écrit par l'IA apparaît
 * progressivement (tampon lissé côté client) — l'IA « écrit » sa réponse
 * au lieu de l'afficher d'un bloc, comme demandé.
 *
 * Backend identique au workspace : POST /api/workspace/conversations[…]
 * (création paresseuse) puis flux NDJSON /messages/stream
 * (message_delta → tampon d'écriture, statuts, résultat, arrêt via
 * AbortController). Le serveur reste l'autorité des messages.
 */

import * as React from "react";

import { ThemeToggle } from "@/components/ui/theme-toggle";
import CarteAutoApprentissage from "@/components/chat/auto-apprentissage-carte";
import { safeClientTimezone } from "@/lib/domain/conversations/stream-client";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import type { ConversationStreamEvent } from "@/lib/domain/conversations/stream-events";
import "./nova-chat.css";

/* ================= Configuration ================= */

const CFG = {
  cle: "gen3ia-nova-chat",
  maxCaracteres: 4000,
  seuilCompteur: 3000,
  maxFichiers: 10,
  maxFichierMo: 20,
  maxConvs: 60,
  /** Cadence du tampon d'écriture progressive (ms). */
  cadenceEcriture: 24,
};

type EffortId = "rapide" | "equilibre" | "expert";

interface EffortDef {
  nom: string;
  ico: string;
  sub: string;
  /** Couple provider/model réel (undefined = routage automatique Gen3). */
  provider?: string;
  model?: string;
}

/** Effort → MOTEUR NEURONAL UNIQUE Gen3 : les trois niveaux ajustent le
 * budget de réflexion du SNN — la même intelligence, trois cadences. */
const EFFORTS: Record<EffortId, EffortDef> = {
  rapide: {
    nom: "Effort rapide",
    ico: "⚡",
    sub: "Réponses instantanées, questions simples",
    provider: "gen3-snn",
    model: "gen3-snn-v1",
  },
  equilibre: {
    nom: "Effort équilibré",
    ico: "🎯",
    sub: "Bon compromis vitesse et qualité",
  },
  expert: {
    nom: "Effort expert",
    ico: "🧠",
    sub: "Raisonnement avancé, analyses longues",
    provider: "gen3-snn",
    model: "gen3-snn-v1",
  },
};

const EFFORT_LABEL_COURT: Record<EffortId, string> = {
  rapide: "Rapide",
  equilibre: "Équilibré",
  expert: "Expert",
};

/** Icônes des applications populaires (repli : « ⧉ »). */
const ICONES_APPS: Record<string, string> = {
  gmail: "✉️",
  googlecalendar: "📅",
  googledrive: "📁",
  googlesheets: "📊",
  slack: "💬",
  notion: "📓",
  github: "🐙",
  whatsapp: "🟢",
  telegram: "✈️",
  discord: "🎧",
  hubspot: "🧲",
  zendesk: "🎫",
  salesforce: "☁️",
  trello: "📋",
  asana: "📐",
  jira: "🧭",
  calendly: "🗓️",
  mailchimp: "🐵",
  stripe: "💳",
  twilio: "📞",
  airtable: "🗂️",
  dropbox: "📦",
  linear: "📏",
  n8n: "⚡",
};

const APPS_SUGGEREES = ["gmail", "googledrive", "googlecalendar", "slack", "notion", "github"] as const;

const iconeApp = (slug: string) => ICONES_APPS[slug] ?? "⧉";

const CARTES_ACCUEIL = [
  {
    ico: "✦",
    titre: "Créer un agent",
    desc: "L'IA crée votre agent spécialisé",
    sugg: "Crée un agent commercial nommé Alex",
  },
  {
    ico: "⏱",
    titre: "Automatiser",
    desc: "Tâche planifiée en langage naturel",
    sugg: "Chaque lundi à 9h, prépare-moi un rapport des actualités IA",
  },
  {
    ico: "🌐",
    titre: "Chercher sur le web",
    desc: "Recherche réelle, sources citées",
    sugg: "Fais une recherche web sur les dernières avancées en IA",
  },
  {
    ico: "🎨",
    titre: "Générer une image",
    desc: "Visuels sur l'infrastructure Gen3ia",
    sugg: "Génère une image d'une ville futuriste au coucher du soleil",
  },
];

/* ================= Types locaux ================= */

interface NovaFichierMsg {
  nom: string;
  taille: number;
  type: string;
}

interface NovaMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  date: number;
  modele?: string;
  erreur?: boolean;
  enCours?: boolean;
  imageUrl?: string;
  fichiers?: NovaFichierMsg[];
}

interface NovaConversation {
  id: string;
  /** Identifiant de la conversation côté serveur (créée au 1er message). */
  serverId?: string;
  titre: string;
  messages: NovaMessage[];
  maj: number;
  /** Suggestions de suivi renvoyées par le serveur (événement « done »). */
  suggestions?: string[];
}

interface NovaPiece {
  nom: string;
  taille: number;
  type: string;
  fichier: File;
  apercu: string | null;
}

/** Application externe connectée (connecteur Composio vérifié). */
interface NovaAppConnectee {
  id: string;
  toolkit: string;
  label: string;
}

/** API personnelle déclarée par l'utilisateur (slug « api-<id> »). */
interface NovaApiPerso {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
}

/* ================= Utilitaires ================= */

function echapper(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

function paragraphes(texte: string): string {
  return texte
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((par) => {
      const lignes = par.split("\n");
      if (lignes.every((l) => /^\s*[-•]\s+/.test(l))) {
        return "<ul>" + lignes.map((l) => `<li>${inline(l.replace(/^\s*[-•]\s+/, ""))}</li>`).join("") + "</ul>";
      }
      if (lignes.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        return "<ol>" + lignes.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("") + "</ol>";
      }
      return "<p>" + lignes.map(inline).join("<br>") + "</p>";
    })
    .join("");
}

type Bloc = { type: "code"; code: string } | { type: "texte"; html: string };

/** Markdown léger et sûr : le texte est échappé AVANT toute transformation —
 *  aucun HTML brut n'est injecté. */
function blocsMarkdown(texte: string): Bloc[] {
  return texte.split("```").map((bloc, i): Bloc => {
    if (i % 2 === 1) {
      const nl = bloc.indexOf("\n");
      const code = (nl >= 0 ? bloc.slice(nl + 1) : bloc).replace(/\n$/, "");
      return { type: "code", code };
    }
    return { type: "texte", html: paragraphes(echapper(bloc)) };
  });
}

function heure(ts: number): string {
  return new Date(ts).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function formaterTaille(o: number): string {
  if (o < 1024) return o + " o";
  if (o < 1024 * 1024) return Math.round(o / 1024) + " Ko";
  return (o / (1024 * 1024)).toFixed(1) + " Mo";
}

function iconePour(nom: string): string {
  const ext = (nom.split(".").pop() || "").toLowerCase();
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["xlsx", "csv"].includes(ext)) return "📊";
  if (ext === "docx") return "📘";
  if (["json", "md", "txt"].includes(ext)) return "📝";
  return "📎";
}

function groupeDe(ts: number): string {
  const d = new Date();
  const aujourdhui = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const jour = 86400000;
  if (ts >= aujourdhui) return "Aujourd'hui";
  if (ts >= aujourdhui - jour) return "Hier";
  if (ts >= aujourdhui - 7 * jour) return "7 derniers jours";
  return "Plus ancien";
}

function suggestionsPour(texte = ""): string[] {
  const t = texte.toLowerCase();
  if (t.includes("agent")) return ["Liste mes agents", "Confie-lui une mission", "Crée un autre agent"];
  if (t.includes("planifi") || t.includes("récurren")) return ["Change l'heure de la tâche", "Liste mes tâches planifiées", "Désactive la tâche"];
  if (t.includes("recherche") || t.includes("web")) return ["Résume les sources en 3 points", "Va plus loin sur le 1er résultat", "Trouve des sources francophones"];
  return ["Résume en 3 points", "Donne-moi un exemple concret", "Quelle est la prochaine étape ?"];
}

function idSuivant(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

function fallbackCopier(texte: string): boolean {
  try {
    const t = document.createElement("textarea");
    t.value = texte;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Charge l'état persisté — tolérant aux données absentes/corrompues. */
function chargerEtat(): { convs: NovaConversation[]; activeId: string | null; effort: EffortId } {
  const vide = { convs: [] as NovaConversation[], activeId: null, effort: "equilibre" as EffortId };
  try {
    const brut = localStorage.getItem(CFG.cle);
    if (!brut) return vide;
    const d = JSON.parse(brut) as {
      convs?: NovaConversation[];
      activeId?: string | null;
      effort?: string;
    };
    const convs = Array.isArray(d.convs) ? d.convs : [];
    const effort: EffortId = d.effort === "rapide" || d.effort === "expert" ? d.effort : "equilibre";
    return { convs, activeId: d.activeId ?? null, effort };
  } catch {
    return vide;
  }
}

/* ================= Sous-composants ================= */

function BlocCode({ code }: { code: string }) {
  const [copie, setCopie] = React.useState(false);
  const copier = React.useCallback(() => {
    const ok = navigator.clipboard?.writeText
      ? (navigator.clipboard.writeText(code).catch(() => fallbackCopier(code)), true)
      : fallbackCopier(code);
    setCopie(ok);
    window.setTimeout(() => setCopie(false), 1600);
  }, [code]);
  return (
    <pre className="nova-pre">
      <button type="button" className="nova-copier-code" onClick={copier}>
        {copie ? "Copié ✓" : "Copier"}
      </button>
      <code>{code}</code>
    </pre>
  );
}

interface MessageViewProps {
  m: NovaMessage;
  dernierBot: boolean;
  dernierUser: boolean;
  onCopier: (texte: string) => void;
  onRegenerer: () => void;
  onModifier: () => void;
}

const MessageView = React.memo(function MessageView({ m, dernierBot, dernierUser, onCopier, onRegenerer, onModifier }: MessageViewProps) {
  const bot = m.role === "assistant";
  const blocs = React.useMemo(() => (bot ? blocsMarkdown(m.content || "") : []), [bot, m.content]);

  return (
    <div className={`nova-msg ${bot ? "assistant" : "utilisateur"}`}>
      <div className="nova-avatar" aria-hidden="true">{bot ? "✦" : "J"}</div>
      <div className="nova-colonne">
        {m.fichiers && m.fichiers.length > 0 ? (
          <div className="nova-fichiers-msg">
            {m.fichiers.map((f, i) => (
              <span key={i} className="nova-fichier-msg">{iconePour(f.nom)} {f.nom}</span>
            ))}
          </div>
        ) : null}

        <div className="nova-bulle">
          {bot ? (
            m.enCours && !m.content ? (
              <div className="nova-frappe" aria-label="Gen3ia prépare une réponse">
                <span className="dot" />
                <span className="dot" />
                <span className="dot" />
              </div>
            ) : (
              <>
                {blocs.map((bloc, i) =>
                  bloc.type === "code" ? (
                    <BlocCode key={i} code={bloc.code} />
                  ) : (
                    <div key={i} dangerouslySetInnerHTML={{ __html: bloc.html }} />
                  ),
                )}
                {m.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={m.imageUrl} alt="Image générée par Gen3ia" className="nova-image-generee" />
                ) : null}
                {m.enCours ? <span className="nova-curseur" aria-hidden="true" /> : null}
              </>
            )
          ) : (
            m.content
          )}
        </div>

        {!m.enCours ? (
          <div className="nova-meta">
            {bot && m.modele ? <span className="modele">{m.modele}</span> : null}
            <span>{heure(m.date)}</span>
            <button type="button" aria-label="Copier le message" onClick={() => onCopier(m.content)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
              Copier
            </button>
            {bot && dernierBot ? (
              <button type="button" aria-label="Régénérer la réponse" onClick={onRegenerer}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
                {m.erreur ? "Réessayer" : "Régénérer"}
              </button>
            ) : null}
            {!bot && dernierUser ? (
              <button type="button" aria-label="Modifier le message" onClick={onModifier}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>
                Modifier
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

/* ================= Page ================= */

export default function NovaChat() {
  /* ---- État React (miroirs refs pour les flux async) ---- */
  const [convs, setConvs] = React.useState<NovaConversation[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [effort, setEffort] = React.useState<EffortId>("equilibre");
  const [outils, setOutils] = React.useState<string[]>([]);
  const [rechercheWeb, setRechercheWeb] = React.useState(false);
  const [fichiers, setFichiers] = React.useState<NovaPiece[]>([]);
  const [saisie, setSaisie] = React.useState("");
  const [recherche, setRecherche] = React.useState("");
  const [enCours, setEnCours] = React.useState(false);
  const [statut, setStatut] = React.useState("Prête — demandez-lui tout");
  const [sidebarOuverte, setSidebarOuverte] = React.useState(false);
  const [popOutils, setPopOutils] = React.useState(false);
  const [popEffort, setPopEffort] = React.useState(false);
  const [apps, setApps] = React.useState<NovaAppConnectee[] | null>(null);
  const [apisPersos, setApisPersos] = React.useState<NovaApiPerso[]>([]);
  const [chargementApps, setChargementApps] = React.useState(false);
  const [connexionApp, setConnexionApp] = React.useState<string | null>(null);
  const [basVisible, setBasVisible] = React.useState(false);
  const [toast, setToast] = React.useState<{ texte: string; cle: number } | null>(null);
  const [charge, setCharge] = React.useState(false);
  const [dropActif, setDropActif] = React.useState(false);

  const convsRef = React.useRef<NovaConversation[]>([]);
  const activeIdRef = React.useRef<string | null>(null);
  const effortRef = React.useRef<EffortId>("equilibre");
  const outilsRef = React.useRef<Set<string>>(new Set());
  const rechercheWebRef = React.useRef(false);
  const controleurRef = React.useRef<AbortController | null>(null);
  const saisieRef = React.useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = React.useRef<HTMLDivElement | null>(null);
  const procheBasRef = React.useRef(true);
  const indexSaisieRef = React.useRef(-1);
  const toastTimerRef = React.useRef<number | null>(null);
  const convCouranteRef = React.useRef<string | null>(null);
  const majMessageRef = React.useRef<
    ((convId: string, msgId: string, maj: (m: NovaMessage) => NovaMessage) => void) | null
  >(null);

  /* ---- Synchronisation refs ⇄ state ---- */
  const majConvs = React.useCallback((next: NovaConversation[]) => {
    convsRef.current = next;
    setConvs(next);
  }, []);

  const majActiveId = React.useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);

  const majEffort = React.useCallback((id: EffortId) => {
    effortRef.current = id;
    setEffort(id);
  }, []);

  const basculerRechercheWeb = React.useCallback(() => {
    rechercheWebRef.current = !rechercheWebRef.current;
    setRechercheWeb(rechercheWebRef.current);
  }, []);

  const afficherToast = React.useCallback((texte: string, duree = 2400) => {
    setToast({ texte, cle: Date.now() });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), duree);
  }, []);

  const copierPressePapiers = React.useCallback(
    (texte: string, message = "Copié dans le presse-papiers") => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(texte).then(
          () => afficherToast(message),
          () => {
            if (fallbackCopier(texte)) afficherToast(message);
            else afficherToast("Copie impossible");
          },
        );
      } else if (fallbackCopier(texte)) afficherToast(message);
      else afficherToast("Copie impossible");
    },
    [afficherToast],
  );

  /* ---- Persistance ---- */
  const sauvegarder = React.useCallback(() => {
    try {
      const tries = [...convsRef.current].sort((a, b) => b.maj - a.maj).slice(0, CFG.maxConvs);
      localStorage.setItem(
        CFG.cle,
        JSON.stringify({ convs: tries, activeId: activeIdRef.current, effort: effortRef.current }),
      );
    } catch {
      /* stockage plein ou indisponible : on continue en mémoire */
    }
  }, []);

  /* ---- Chargement initial ---- */
  React.useEffect(() => {
    const etat = chargerEtat();
    let actif = etat.activeId;
    if (!etat.convs.some((c) => c.id === actif)) actif = etat.convs[0]?.id ?? null;
    convsRef.current = etat.convs;
    activeIdRef.current = actif;
    effortRef.current = etat.effort;
    setConvs(etat.convs);
    setActiveId(actif);
    setEffort(etat.effort);
    setCharge(true);
  }, []);

  /* ---- ÉCRITURE PROGRESSIVE (tampon lissé) ----
   * Le flux NDJSON livre des deltas par paquets ; ce tampon révèle le texte
   * PROGRESSIVEMENT (mot à mot visuellement) : l'IA « écrit » sa réponse au
   * lieu de l'afficher d'un bloc. La cadence s'adapte au retard :
   * rattrapage fluide si le backlog grandit, aucun blocage si le flux finit. */
  const fluxEcritureRef = React.useRef<Map<string, { cible: string; montre: number }>>(new Map());
  const ecritureTimerRef = React.useRef<number | null>(null);

  const arreterHorlogeEcriture = React.useCallback(() => {
    if (ecritureTimerRef.current !== null) {
      window.clearInterval(ecritureTimerRef.current);
      ecritureTimerRef.current = null;
    }
  }, []);

  const tickEcriture = React.useCallback(() => {
    const flux = fluxEcritureRef.current;
    if (flux.size === 0) {
      arreterHorlogeEcriture();
      return;
    }
    for (const [msgId, etat] of flux) {
      const restant = etat.cible.length - etat.montre;
      if (restant <= 0) continue;
      // Palier adaptatif : petit retard → mot à mot ; gros backlog → rattrapage.
      const palier = Math.max(1, Math.ceil(restant / 28));
      let prochaine = etat.montre + palier;
      // Coupure « mot » : si un espace tombe dans la fenêtre révélée, y couper.
      if (restant > 10) {
        const fenetre = etat.cible.slice(Math.max(etat.montre, prochaine - 14), prochaine + 1);
        const espace = fenetre.lastIndexOf(" ");
        if (espace >= 0) {
          const coupure = Math.max(etat.montre, prochaine - 14) + espace;
          if (coupure > etat.montre && coupure <= etat.cible.length) prochaine = coupure;
        }
      }
      etat.montre = Math.min(prochaine, etat.cible.length);
      const convId = convCouranteRef.current;
      if (convId) {
        majMessageRef.current?.(convId, msgId, (m) => ({ ...m, content: etat.cible.slice(0, etat.montre) }));
      }
    }
  }, [arreterHorlogeEcriture]);

  const demarrerHorlogeEcriture = React.useCallback(() => {
    if (ecritureTimerRef.current === null) {
      ecritureTimerRef.current = window.setInterval(tickEcriture, CFG.cadenceEcriture);
    }
  }, [tickEcriture]);

  /** Empile un delta reçu du flux dans le tampon d'écriture. */
  const empilerDelta = React.useCallback(
    (msgId: string, delta: string) => {
      const flux = fluxEcritureRef.current;
      const etat = flux.get(msgId) ?? { cible: "", montre: 0 };
      etat.cible += delta;
      flux.set(msgId, etat);
      demarrerHorlogeEcriture();
    },
    [demarrerHorlogeEcriture],
  );

  /** Termine l'écriture d'un message : révèle immédiatement tout le reste. */
  const terminerEcriture = React.useCallback(
    (msgId: string) => {
      const etat = fluxEcritureRef.current.get(msgId);
      if (etat) {
        const convId = convCouranteRef.current;
        if (convId && etat.montre < etat.cible.length) {
          majMessageRef.current?.(convId, msgId, (m) => ({ ...m, content: etat.cible }));
        }
        fluxEcritureRef.current.delete(msgId);
      }
      if (fluxEcritureRef.current.size === 0) arreterHorlogeEcriture();
    },
    [arreterHorlogeEcriture],
  );

  React.useEffect(() => () => arreterHorlogeEcriture(), [arreterHorlogeEcriture]);

  /* ---- Aides ---- */
  const conversationActive = React.useCallback(
    () => convsRef.current.find((c) => c.id === activeIdRef.current) || null,
    [],
  );

  const proche = React.useCallback(() => {
    const m = messagesRef.current;
    if (!m) return true;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 160;
  }, []);

  const descendre = React.useCallback((force = false) => {
    const m = messagesRef.current;
    if (!m) return;
    if (force || procheBasRef.current) m.scrollTop = m.scrollHeight;
  }, []);

  React.useEffect(() => {
    descendre();
  }, [convs, descendre]);

  const nouvelleConversation = React.useCallback((): NovaConversation => {
    const conv: NovaConversation = { id: idSuivant(), titre: "Nouvelle conversation", messages: [], maj: Date.now() };
    majConvs([conv, ...convsRef.current]);
    majActiveId(conv.id);
    return conv;
  }, [majActiveId, majConvs]);

  /* ---- Fichiers (chips locales + validation) ---- */
  const viderFichiers = React.useCallback((liste: NovaPiece[]) => {
    liste.forEach((f) => f.apercu && URL.revokeObjectURL(f.apercu));
  }, []);

  const ajouterFichiers = React.useCallback(
    (liste: FileList | File[]) => {
      const max = CFG.maxFichierMo * 1024 * 1024;
      setFichiers((courants) => {
        const suivants = [...courants];
        for (const f of Array.from(liste)) {
          if (suivants.length >= CFG.maxFichiers) {
            afficherToast(`Maximum ${CFG.maxFichiers} fichiers par message.`);
            break;
          }
          if (f.size > max) {
            afficherToast(`« ${f.name} » dépasse ${CFG.maxFichierMo} Mo.`);
            continue;
          }
          const image = f.type.startsWith("image/");
          suivants.push({
            nom: f.name,
            taille: f.size,
            type: f.type,
            fichier: f,
            apercu: image ? URL.createObjectURL(f) : null,
          });
        }
        return suivants;
      });
    },
    [afficherToast],
  );

  const retirerFichier = React.useCallback((index: number) => {
    setFichiers((courants) => {
      if (courants[index]?.apercu) URL.revokeObjectURL(courants[index].apercu as string);
      return courants.filter((_, i) => i !== index);
    });
  }, []);

  /* ---- Plugins : applications connectées + API personnelles ---- */
  const chargerApps = React.useCallback(async () => {
    if (apps !== null || chargementApps) return;
    setChargementApps(true);
    try {
      const [repConns, repApis] = await Promise.all([
        fetch("/api/integrations/composio/connections", { cache: "no-store" }).catch(() => null),
        fetch("/api/custom-apis", { cache: "no-store" }).catch(() => null),
      ]);
      const connectees: NovaAppConnectee[] = [];
      if (repConns?.ok) {
        const data = (await repConns.json().catch(() => ({}))) as {
          connections?: Array<{ id: string; toolkit: string; label: string; enabled: boolean; verified: boolean }>;
        };
        for (const c of Array.isArray(data.connections) ? data.connections : []) {
          if (c?.toolkit && c?.enabled && c?.verified) {
            connectees.push({ id: c.id, toolkit: c.toolkit, label: c.label || c.toolkit });
          }
        }
      }
      setApps(connectees);
      if (repApis?.ok) {
        const data = (await repApis.json().catch(() => ({}))) as { apis?: NovaApiPerso[] };
        setApisPersos(Array.isArray(data.apis) ? data.apis.filter((a) => a?.enabled) : []);
      } else {
        setApisPersos([]);
      }
    } catch {
      setApps([]);
    } finally {
      setChargementApps(false);
    }
  }, [apps, chargementApps]);

  /** Connexion OAuth d'une application depuis le chat (redirection). */
  const connecterApp = React.useCallback(
    async (toolkit: string) => {
      if (connexionApp) return;
      setConnexionApp(toolkit);
      try {
        const rep = await fetch("/api/integrations/composio/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolkit }),
        });
        if (rep.ok) {
          const data = (await rep.json().catch(() => ({}))) as { authorizationUrl?: string };
          if (data.authorizationUrl) {
            window.location.assign(data.authorizationUrl);
            return;
          }
        }
      } catch {
        /* redirection impossible : on reste sur place */
      }
      setConnexionApp(null);
      afficherToast("Connexion impossible pour le moment");
    },
    [afficherToast, connexionApp],
  );

  const basculerOutil = React.useCallback((id: string) => {
    const next = new Set(outilsRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    outilsRef.current = next;
    setOutils([...next]);
  }, []);

  const libelleOutil = React.useCallback(
    (slug: string) => {
      if (slug.startsWith("api-")) {
        const api = apisPersos.find((a) => `api-${a.id}` === slug);
        if (api) return `🔗 ${api.name}`;
      }
      const app = apps?.find((a) => a.toolkit === slug);
      return app ? `${iconeApp(slug)} ${app.label}` : slug;
    },
    [apisPersos, apps],
  );

  const changerEffort = React.useCallback(
    (id: EffortId) => {
      majEffort(id);
      setPopEffort(false);
      sauvegarder();
    },
    [majEffort, sauvegarder],
  );

  /* ---- Génération réelle (streaming NDJSON + écriture progressive) ---- */

  const majMessage = React.useCallback(
    (convId: string, msgId: string, maj: (m: NovaMessage) => NovaMessage) => {
      majConvs(
        convsRef.current.map((c) =>
          c.id !== convId ? c : { ...c, maj: Date.now(), messages: c.messages.map((m) => (m.id === msgId ? maj(m) : m)) },
        ),
      );
    },
    [majConvs],
  );

  // Le tampon d'écriture appelle majMessage via une ref (pas de dépendance circulaire).
  React.useEffect(() => {
    majMessageRef.current = majMessage;
  }, [majMessage]);

  /** Exécute un tour réel : conversation serveur paresseuse, téléversement,
   *  puis consommation du flux NDJSON (écriture progressive via le tampon). */
  const lancerGeneration = React.useCallback(
    async (conv: NovaConversation, message: string, pieces: NovaPiece[]) => {
      convCouranteRef.current = conv.id;

      // 1) Conversation serveur (paresseuse : créée au premier message).
      if (!conv.serverId) {
        try {
          const r = await fetch("/api/workspace/conversations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: conv.titre }),
          });
          if (!r.ok) {
            const d = (await r.json().catch(() => ({}))) as { error?: string };
            throw new Error(d.error ?? "Impossible de créer la conversation.");
          }
          const d = (await r.json()) as { conversation: { id: string } };
          conv.serverId = d.conversation.id;
          majConvs(convsRef.current.slice());
        } catch (e) {
          throw e instanceof Error ? e : new Error("Impossible de créer la conversation.");
        }
      }

      // 2) Pièces jointes : téléversement réel, puis descripteur du tour.
      let piecesApi: Array<{ filename: string; path: string; contentType: string; sizeBytes: number }> = [];
      if (pieces.length > 0) {
        setStatut("Téléversement des pièces jointes…");
        const resultat = await uploadPermanentFiles(pieces.map((p) => p.fichier));
        if (resultat.uploaded.length === 0) {
          throw new Error(resultat.failed[0]?.error || "Le téléversement des fichiers a échoué.");
        }
        piecesApi = resultat.uploaded.map((u) => ({
          filename: u.filename,
          path: u.path,
          contentType: u.contentType,
          sizeBytes: u.sizeBytes,
        }));
      }

      // 3) Flux NDJSON du tour.
      const controller = new AbortController();
      controleurRef.current = controller;
      setEnCours(true);
      setStatut("Gen3ia écrit…");

      const def = EFFORTS[effortRef.current];
      // Plugins : les connecteurs activés (apps externes + « api-<id> »)
      // accompagnent le tour — le moteur injecte les actions réelles au
      // planificateur (composio.execute / custom_api.*).
      const connecteurs = [...outilsRef.current].slice(0, 8);
      const corps: Record<string, unknown> = {
        message,
        timezone: safeClientTimezone(),
        ...(piecesApi.length > 0 ? { attachments: piecesApi } : {}),
        ...(def.provider && def.model ? { provider: def.provider, model: def.model } : {}),
        ...(connecteurs.length > 0 ? { connectors: connecteurs } : {}),
        // Bouton « Recherche web » : la recherche réelle est FORCÉE côté serveur.
        ...(rechercheWebRef.current ? { webSearch: true } : {}),
      };

      const streamId = idSuivant();
      majConvs(
        convsRef.current.map((c) =>
          c.id !== conv.id
            ? c
            : { ...c, messages: [...c.messages, { id: streamId, role: "assistant", content: "", date: Date.now(), enCours: true }] },
        ),
      );
      descendre(true);

      let contenu = "";
      let recu = false;
      const echec = new Error();
      try {
        const response = await fetch(`/api/workspace/conversations/${conv.serverId}/messages/stream`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(corps),
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) {
          const d = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error ?? "Le message n'a pas pu être traité.");
        }
        if (!response.body) throw new Error("Flux indisponible.");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        const dispatch = (ligne: string) => {
          const trimmed = ligne.trim();
          if (!trimmed) return;
          let event: ConversationStreamEvent;
          try {
            event = JSON.parse(trimmed) as ConversationStreamEvent;
          } catch {
            return; // ligne partielle/invalide : ignorée
          }
          switch (event.type) {
            case "status":
              setStatut(event.label);
              break;
            case "message_delta":
              recu = true;
              contenu += event.delta;
              // Écriture progressive : le delta entre dans le tampon, le
              // texte est révélé mot à mot par l'horloge (pas d'un bloc).
              empilerDelta(streamId, event.delta);
              break;
            case "message_complete":
              recu = true;
              contenu = event.message.content || contenu;
              terminerEcriture(streamId);
              majMessage(conv.id, streamId, (m) => ({
                ...m,
                content: contenu,
                modele: event.message.model || m.modele,
                ...(event.message.imageUrl ? { imageUrl: event.message.imageUrl } : {}),
              }));
              break;
            case "done": {
              const final = event.assistantMessage;
              const suggestions = final.suggestions ?? [];
              terminerEcriture(streamId);
              majMessage(conv.id, streamId, (m) => ({
                ...m,
                content: final.content || contenu,
                modele: final.model || def.nom,
                enCours: false,
                ...(final.imageUrl ? { imageUrl: final.imageUrl } : {}),
              }));
              if (suggestions.length > 0) {
                majConvs(
                  convsRef.current.map((c) =>
                    c.id !== conv.id ? c : { ...c, suggestions: suggestions.slice(0, 4) },
                  ),
                );
              }
              break;
            }
            case "error":
              throw new Error(event.message || "Erreur en cours de génération.");
            default:
              // run_created / step_update / approval_created / artifact_created /
              // billing : non rendus dans cette UI épurée — la persistance
              // serveur reste consultable dans /workspace/conversations.
              break;
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lignes = buffer.split("\n");
          buffer = lignes.pop() ?? "";
          for (const ligne of lignes) dispatch(ligne);
        }
        dispatch(buffer);

        // Sécurité : le flux s'est refermé sans « done » → on fige le message.
        terminerEcriture(streamId);
        majMessage(conv.id, streamId, (m) => ({ ...m, enCours: false, modele: m.modele || def.nom }));
      } catch (err) {
        const interrompu = controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
        terminerEcriture(streamId);
        if (interrompu) {
          majMessage(conv.id, streamId, (m) => ({
            ...m,
            content: contenu.trim() ? `${contenu}\n\n⏹ *Génération arrêtée.*` : "⏹ *Génération arrêtée.*",
            enCours: false,
            modele: def.nom,
          }));
        } else {
          echec.message = err instanceof Error ? err.message : "Erreur de génération.";
          (echec as Error & { partiel?: boolean }).partiel = recu || contenu.trim().length > 0;
          if (recu || contenu.trim()) {
            majMessage(conv.id, streamId, (m) => ({
              ...m,
              content: `${contenu}\n\n⚠️ ${echec.message}`,
              erreur: true,
              enCours: false,
            }));
          } else {
            // Rien reçu : la bulle fantôme disparaît, le message utilisateur
            // est restitué au composer par l'appelant.
            majConvs(
              convsRef.current.map((c) =>
                c.id !== conv.id ? c : { ...c, messages: c.messages.filter((m) => m.id !== streamId) },
              ),
            );
          }
          throw echec; // remonté à envoyer() pour le repli composer + toast
        }
      } finally {
        controleurRef.current = null;
        setEnCours(false);
        setStatut("Prête — demandez-lui tout");
        sauvegarder();
      }
    },
    [descendre, empilerDelta, majConvs, majMessage, sauvegarder, terminerEcriture],
  );

  /* ---- Envoi d'un message ---- */
  const envoyer = React.useCallback(
    async (texteBrut?: string) => {
      if (controleurRef.current) return; // une génération à la fois

      const message = (texteBrut ?? saisie).trim();
      const pieces = fichiers;
      if ((!message && pieces.length === 0) || message.length > CFG.maxCaracteres) return;

      const conv = conversationActive() || nouvelleConversation();
      if (!conv.messages.length) {
        conv.titre = (message || pieces[0]?.nom || "Nouvelle conversation").slice(0, 45);
      }
      conv.suggestions = undefined;

      const userMsg: NovaMessage = {
        id: idSuivant(),
        role: "user",
        content: message,
        date: Date.now(),
        fichiers: pieces.map((f) => ({ nom: f.nom, taille: f.taille, type: f.type })),
      };
      conv.messages = [...conv.messages, userMsg];
      conv.maj = Date.now();
      majConvs(convsRef.current.slice());

      setSaisie("");
      indexSaisieRef.current = -1;
      setFichiers([]);
      // La recherche web est une option PAR MESSAGE : elle se désactive après l'envoi.
      rechercheWebRef.current = false;
      setRechercheWeb(false);
      descendre(true);

      // L'API exige un message non vide : un envoi « fichiers seuls » porte
      // une consigne par défaut, les pièces jointes voyageant à part.
      const messageApi = message || (pieces.length > 1 ? "Analyse les fichiers joints." : "Analyse le fichier joint.");

      try {
        await lancerGeneration(conv, messageApi, pieces);
        viderFichiers(pieces);
      } catch (err) {
        // Erreur SANS contenu reçu : le message utilisateur revient dans le
        // composer (rien n'est perdu). Avec contenu partiel : le fil conserve
        // l'échange et le toast suffit.
        const partiel = (err as { partiel?: boolean }).partiel === true;
        if (!partiel) {
          majConvs(
            convsRef.current.map((c) =>
              c.id !== conv.id ? c : { ...c, messages: c.messages.filter((m) => m.id !== userMsg.id) },
            ),
          );
          setSaisie(message);
          setFichiers(pieces);
          afficherToast("Erreur de génération — le message est conservé dans la zone de saisie.");
        } else {
          viderFichiers(pieces);
          afficherToast("Erreur de génération");
        }
        sauvegarder();
        saisieRef.current?.focus();
      }
    },
    [afficherToast, conversationActive, descendre, fichiers, lancerGeneration, majConvs, nouvelleConversation, saisie, sauvegarder, viderFichiers],
  );

  /* ---- Régénération : renvoie le dernier message utilisateur ---- */
  const regenerer = React.useCallback(async () => {
    const conv = conversationActive();
    if (!conv || controleurRef.current) return;
    while (conv.messages.length && conv.messages[conv.messages.length - 1].role === "assistant") {
      conv.messages = conv.messages.slice(0, -1);
    }
    const dernierUser = conv.messages[conv.messages.length - 1];
    if (!dernierUser || dernierUser.role !== "user") {
      majConvs(convsRef.current.slice());
      return;
    }
    majConvs(convsRef.current.slice());
    try {
      await lancerGeneration(conv, dernierUser.content, []);
    } catch {
      afficherToast("Erreur de génération");
    }
  }, [afficherToast, conversationActive, lancerGeneration, majConvs]);

  /* ---- Édition du dernier message utilisateur ---- */
  const modifierDernier = React.useCallback(() => {
    const conv = conversationActive();
    if (!conv || controleurRef.current) return;
    const idx = conv.messages.map((m) => m.role).lastIndexOf("user");
    if (idx < 0) return;
    const m = conv.messages[idx];
    conv.messages = conv.messages.slice(0, idx);
    setSaisie(m.content);
    indexSaisieRef.current = -1;
    majConvs(convsRef.current.slice());
    sauvegarder();
    saisieRef.current?.focus();
  }, [conversationActive, majConvs, sauvegarder]);

  /* ---- Conversations : sélection, suppression, renommage, export ---- */
  const selectionnerConversation = React.useCallback(
    (id: string) => {
      if (id === activeIdRef.current) {
        setSidebarOuverte(false);
        return;
      }
      controleurRef.current?.abort();
      controleurRef.current = null;
      setFichiers((courants) => {
        viderFichiers(courants);
        return [];
      });
      majActiveId(id);
      setSidebarOuverte(false);
      sauvegarder();
    },
    [majActiveId, sauvegarder, viderFichiers],
  );

  const supprimerConversation = React.useCallback(
    (id: string) => {
      const conv = convsRef.current.find((c) => c.id === id);
      if (id === activeIdRef.current) controleurRef.current?.abort();
      const restantes = convsRef.current.filter((c) => c.id !== id);
      if (conv?.serverId) {
        void fetch(`/api/workspace/conversations/${conv.serverId}`, { method: "DELETE" }).catch(() => undefined);
      }
      if (activeIdRef.current === id) majActiveId(restantes[0]?.id ?? null);
      majConvs(restantes);
      sauvegarder();
      afficherToast("Conversation supprimée");
    },
    [afficherToast, majActiveId, majConvs, sauvegarder],
  );

  const renommerConversation = React.useCallback(
    (id: string) => {
      const conv = convsRef.current.find((c) => c.id === id);
      if (!conv) return;
      const nouveau = window.prompt("Nouveau titre de la conversation :", conv.titre);
      if (!nouveau || !nouveau.trim()) return;
      conv.titre = nouveau.trim().slice(0, 60);
      majConvs(convsRef.current.slice());
      sauvegarder();
      if (conv.serverId) {
        void fetch(`/api/workspace/conversations/${conv.serverId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: conv.titre }),
        }).catch(() => undefined);
      }
    },
    [majConvs, sauvegarder],
  );

  const exporterConversation = React.useCallback(() => {
    const conv = conversationActive();
    if (!conv || !conv.messages.length) {
      afficherToast("Rien à exporter pour le moment");
      return;
    }
    const corps = conv.messages
      .map((m) => {
        const auteur = m.role === "user" ? "Vous" : "Gen3ia";
        return `**${auteur}** · ${new Date(m.date).toLocaleString("fr-FR")}\n\n${m.content}`;
      })
      .join("\n\n---\n\n");
    const contenu = `# ${conv.titre}\n\n${corps}\n`;
    const nomFichier = (conv.titre.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "conversation").slice(0, 50) + ".md";
    const url = URL.createObjectURL(new Blob([contenu], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = nomFichier;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    afficherToast("Conversation exportée");
  }, [afficherToast, conversationActive]);

  /* ---- Nouvelle conversation (bouton / Ctrl+K) ---- */
  const boutonNouveau = React.useCallback(() => {
    controleurRef.current?.abort();
    const conv = conversationActive();
    if (conv && !conv.messages.length) {
      saisieRef.current?.focus();
      setSidebarOuverte(false);
      return;
    }
    nouvelleConversation();
    setFichiers((courants) => {
      viderFichiers(courants);
      return [];
    });
    sauvegarder();
    setSidebarOuverte(false);
    saisieRef.current?.focus();
  }, [conversationActive, nouvelleConversation, sauvegarder, viderFichiers]);

  /* ---- Raccourcis clavier globaux ---- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        boutonNouveau();
      }
      if (e.key === "Escape") {
        setPopOutils(false);
        setPopEffort(false);
        setSidebarOuverte(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [boutonNouveau]);

  /* ---- Défilement : bouton « en bas » ---- */
  const onScrollMessages = React.useCallback(() => {
    const p = proche();
    procheBasRef.current = p;
    setBasVisible(!p);
  }, [proche]);

  /* ---- Saisie : redimensionnement + historique ↑/↓ ---- */
  const redimensionner = React.useCallback(() => {
    const t = saisieRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 200) + "px";
  }, []);

  React.useEffect(() => {
    redimensionner();
  }, [saisie, redimensionner]);

  const naviguerHistorique = React.useCallback(
    (sens: 1 | -1) => {
      const conv = conversationActive();
      const saisiesUtil = conv ? conv.messages.filter((m) => m.role === "user").map((m) => m.content) : [];
      if (!saisiesUtil.length) return false;
      indexSaisieRef.current = Math.max(-1, Math.min(saisiesUtil.length - 1, indexSaisieRef.current + sens));
      const texte = indexSaisieRef.current === -1 ? "" : saisiesUtil[saisiesUtil.length - 1 - indexSaisieRef.current];
      setSaisie(texte);
      return true;
    },
    [conversationActive],
  );

  const onKeyDownSaisie = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void envoyer();
      } else if (e.key === "ArrowUp" && !saisie.trim()) {
        if (naviguerHistorique(1)) e.preventDefault();
      } else if (e.key === "ArrowDown" && indexSaisieRef.current >= 0) {
        if (naviguerHistorique(-1)) e.preventDefault();
      }
    },
    [envoyer, naviguerHistorique, saisie],
  );

  const onPasteSaisie = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const fs = Array.from(e.clipboardData?.files ?? []);
      if (fs.length) {
        e.preventDefault();
        ajouterFichiers(fs);
      }
    },
    [ajouterFichiers],
  );

  const onDrop = React.useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDropActif(false);
      ajouterFichiers(e.dataTransfer.files);
    },
    [ajouterFichiers],
  );

  /* ---- Rendu dérivé ---- */
  const conv = convs.find((c) => c.id === activeId) ?? null;
  const filtre = recherche.trim().toLowerCase();
  const listeFiltree = convs
    .filter((c) => c.titre.toLowerCase().includes(filtre))
    .sort((a, b) => b.maj - a.maj);

  const groupes: Array<{ titre: string; convs: NovaConversation[] }> = [];
  for (const c of listeFiltree) {
    const g = groupeDe(c.maj);
    const dernier = groupes[groupes.length - 1];
    if (dernier && dernier.titre === g) dernier.convs.push(c);
    else groupes.push({ titre: g, convs: [c] });
  }

  const messages = conv?.messages ?? [];
  const idxBot = messages.map((m) => m.role).lastIndexOf("assistant");
  const idxUser = messages.map((m) => m.role).lastIndexOf("user");
  const dernierMessage = messages[messages.length - 1];
  const suggestions =
    dernierMessage && dernierMessage.role === "assistant" && !dernierMessage.erreur && !dernierMessage.enCours
      ? conv?.suggestions?.length
        ? conv.suggestions
        : suggestionsPour(dernierMessage.content)
      : null;

  const longueur = saisie.length;
  const envoiDesactive = enCours ? false : ((!saisie.trim() && fichiers.length === 0) || longueur > CFG.maxCaracteres);

  return (
    <div className="nova">
      <div className={`nova-overlay${sidebarOuverte ? " ouvert" : ""}`} onClick={() => setSidebarOuverte(false)} />

      {/* ================= Sidebar historique ================= */}
      <aside className={`nova-sidebar${sidebarOuverte ? " ouvert" : ""}`} aria-label="Historique des conversations">
        <div className="nova-brand">
          <div className="nova-logo" aria-hidden="true">G</div>
          <div className="nova-brand-nom">
            Gen3ia
            <small>Dashboard · Chat IA</small>
          </div>
        </div>
        <button type="button" className="nova-nouveau" onClick={boutonNouveau} title="Nouvelle conversation (Ctrl+K)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" width="15" height="15"><path d="M12 5v14M5 12h14" /></svg>
          Nouvelle conversation
        </button>
        <input
          className="nova-recherche"
          type="search"
          placeholder="Rechercher une conversation…"
          aria-label="Rechercher une conversation"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
        />
        <nav className="nova-liste" aria-label="Conversations">
          {charge && groupes.length === 0 ? (
            <div className="nova-vide">{convs.length ? "Aucun résultat" : "Aucune conversation pour le moment"}</div>
          ) : null}
          {groupes.map((g) => (
            <React.Fragment key={g.titre}>
              <div className="nova-groupe">{g.titre}</div>
              {g.convs.map((c) => (
                <div
                  key={c.id}
                  className={`nova-conv${c.id === activeId ? " actif" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectionnerConversation(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") selectionnerConversation(c.id);
                  }}
                >
                  <span className="nova-conv-titre">{c.titre}</span>
                  <span className="nova-conv-actions">
                    <button
                      type="button"
                      aria-label="Renommer"
                      onClick={(e) => {
                        e.stopPropagation();
                        renommerConversation(c.id);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      aria-label="Supprimer"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Supprimer « ${c.titre} » ?`)) supprimerConversation(c.id);
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </React.Fragment>
          ))}
        </nav>
        <CarteAutoApprentissage />
        <div className="nova-sidebar-pied">
          <a href="/workspace">Conversations serveur</a>
          <a href="/settings">Paramètres</a>
        </div>
      </aside>

      {/* ================= Zone principale ================= */}
      <main className="nova-main">
        <header className="nova-topbar">
          <button
            type="button"
            className="nova-bouton-ico nova-burger"
            aria-label="Ouvrir l'historique"
            onClick={() => setSidebarOuverte(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <div className="nova-topbar-logo" aria-hidden="true">✦</div>
          <div>
            <div className="nova-titre">Gen3ia</div>
            <div className="nova-statut" role="status">{statut}</div>
          </div>
          <div className="nova-topbar-actions">
            <button type="button" className="nova-bouton-ico" onClick={exporterConversation} aria-label="Exporter la conversation en Markdown" title="Exporter (.md)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            </button>
            <ThemeToggle compact />
          </div>
        </header>

        <section
          className="nova-messages"
          ref={messagesRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          aria-busy={enCours}
          onScroll={onScrollMessages}
        >
          {messages.length === 0 ? (
            <div className="nova-accueil">
              <div className="nova-accueil-logo" aria-hidden="true">✦</div>
              <h2>
                Que puis-je faire <span className="gradient-text">pour vous ?</span>
              </h2>
              <p>
                Je pilote toute la plateforme : demandez-moi de créer un agent, de planifier une tâche, de générer
                une image, une vidéo, un document — ou choisissez un départ ci-dessous.
              </p>
              <div className="nova-cartes">
                {CARTES_ACCUEIL.map((carte) => (
                  <button type="button" key={carte.titre} className="nova-carte" onClick={() => void envoyer(carte.sugg)}>
                    <div className="nova-carte-ico" aria-hidden="true">{carte.ico}</div>
                    <div className="nova-carte-titre">{carte.titre}</div>
                    <div className="nova-carte-desc">{carte.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="nova-fil">
              {messages.map((m, i) => (
                <MessageView
                  key={m.id}
                  m={m}
                  dernierBot={i === idxBot}
                  dernierUser={i === idxUser && idxUser > idxBot}
                  onCopier={copierPressePapiers}
                  onRegenerer={() => {
                    void regenerer();
                  }}
                  onModifier={modifierDernier}
                />
              ))}
              {suggestions ? (
                <div className="nova-suggestions">
                  {suggestions.map((texte) => (
                    <button type="button" key={texte} className="nova-chip-sugg" onClick={() => void envoyer(texte)}>
                      {texte}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </section>

        <button
          type="button"
          className={`nova-bas${basVisible ? " visible" : ""}`}
          aria-label="Aller au dernier message"
          onClick={() => descendre(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" width="15" height="15"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
        </button>

        {/* ================= Composer — 5 commandes ================= */}
        <footer className="nova-composer">
          <div className="nova-zone-relative">
            <div
              className={`nova-composer-boite${dropActif ? " drop" : ""}`}
              onDragEnter={(e) => {
                if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) {
                  e.preventDefault();
                  setDropActif(true);
                }
              }}
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
              }}
              onDragLeave={() => setDropActif(false)}
              onDragEnd={() => setDropActif(false)}
              onDrop={onDrop}
            >
              <div className="nova-lignes-haut">
                {fichiers.length > 0 ? (
                  <div className="nova-pieces">
                    {fichiers.map((f, i) => (
                      <div className="nova-piece" key={`${f.nom}-${i}`}>
                        <div className="nova-piece-vignette">
                          {f.apercu ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={f.apercu} alt="" />
                          ) : (
                            iconePour(f.nom)
                          )}
                        </div>
                        <div>
                          <div className="nova-piece-nom">{f.nom}</div>
                          <div className="nova-piece-taille">{formaterTaille(f.taille)}</div>
                        </div>
                        <button type="button" className="nova-piece-retirer" aria-label="Retirer le fichier" onClick={() => retirerFichier(i)}>
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}

                {outils.length > 0 ? (
                  <div className="nova-outils-actifs">
                    {outils.map((id) => (
                      <span className="nova-outil-chip" key={id} title="Application activée pour vos prochains messages">
                        {libelleOutil(id)}
                        <button type="button" aria-label="Désactiver" onClick={() => basculerOutil(id)}>×</button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <textarea
                ref={saisieRef}
                className="nova-saisie"
                rows={1}
                placeholder="Demandez tout à Gen3ia… (↑ pour rappeler le dernier message)"
                aria-label="Message"
                value={saisie}
                onChange={(e) => {
                  indexSaisieRef.current = -1;
                  setSaisie(e.target.value);
                }}
                onKeyDown={onKeyDownSaisie}
                onPaste={onPasteSaisie}
              />

              <div className="nova-barre">
                <div className="nova-barre-gauche">
                  {/* 2) IMPORT DE FICHIERS */}
                  <label className="nova-pill" title="Joindre des fichiers" aria-label="Joindre des fichiers">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                    <input
                      type="file"
                      hidden
                      multiple
                      accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.webp"
                      onChange={(e) => {
                        ajouterFichiers(e.target.files ?? []);
                        e.target.value = "";
                      }}
                    />
                  </label>

                  {/* 3) OUTILS (plugins) */}
                  <div className="nova-zone-relative">
                    <button
                      type="button"
                      className="nova-pill"
                      aria-haspopup="true"
                      aria-expanded={popOutils}
                      onClick={() => {
                        setPopEffort(false);
                        setPopOutils((o) => !o);
                        void chargerApps();
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.1-.6-.6-2.1 2.5-2.5z" /></svg>
                      <span className="txt-long">Outils</span>
                      {outils.length > 0 ? <span className="tag">{outils.length}</span> : null}
                    </button>
                    {popOutils ? (
                      <div className="nova-popover" role="menu">
                        <div className="nova-pop-titre">Applications pour ce message</div>
                        {chargementApps ? (
                          <div className="nova-pop-item" style={{ cursor: "default" }}>
                            <span className="ico" aria-hidden="true">⏳</span>
                            <span className="txt">Chargement de vos connexions…</span>
                          </div>
                        ) : (apps ?? []).length === 0 && apisPersos.length === 0 ? (
                          <div className="nova-pop-vide">
                            <p className="nova-pop-vide-txt">
                              Aucune application connectée — l&apos;IA peut agir dans vos apps (Gmail, Calendar, Slack, Notion, Zendesk…) dès qu&apos;elles sont reliées à Gen3ia.
                            </p>
                            <div className="nova-pop-suggestions">
                              {APPS_SUGGEREES.map((toolkit) => (
                                <button
                                  type="button"
                                  key={toolkit}
                                  className="nova-pop-chip"
                                  disabled={connexionApp !== null}
                                  onClick={() => void connecterApp(toolkit)}
                                  title={`Connecter ${toolkit} — page d'autorisation`}
                                >
                                  {connexionApp === toolkit ? "…" : `${iconeApp(toolkit)} ${toolkit}`}
                                </button>
                              ))}
                            </div>
                            <a className="nova-pop-lien" href="/integrations">Gérer toutes les connexions →</a>
                          </div>
                        ) : (
                          <>
                            {(apps ?? []).map((app) => (
                              <button
                                type="button"
                                key={app.id}
                                className={`nova-pop-item${outils.includes(app.toolkit) ? " selected" : ""}`}
                                role="menuitemcheckbox"
                                aria-checked={outils.includes(app.toolkit)}
                                onClick={() => basculerOutil(app.toolkit)}
                              >
                                <span className="ico" aria-hidden="true">{iconeApp(app.toolkit)}</span>
                                <span className="txt">
                                  {app.label}
                                  <span className="sub">Actions réelles dans cette application</span>
                                </span>
                                <span className="coche" />
                              </button>
                            ))}
                            {apisPersos.length > 0 ? (
                              <>
                                <div className="nova-pop-sep">Mes API personnelles</div>
                                {apisPersos.map((api) => {
                                  const slug = `api-${api.id}`;
                                  return (
                                    <button
                                      type="button"
                                      key={api.id}
                                      className={`nova-pop-item${outils.includes(slug) ? " selected" : ""}`}
                                      role="menuitemcheckbox"
                                      aria-checked={outils.includes(slug)}
                                      onClick={() => basculerOutil(slug)}
                                    >
                                      <span className="ico" aria-hidden="true">🔗</span>
                                      <span className="txt">
                                        {api.name}
                                        <span className="sub">Appels HTTP réels vers votre API</span>
                                      </span>
                                      <span className="coche" />
                                    </button>
                                  );
                                })}
                              </>
                            ) : null}
                          </>
                        )}
                        <div className="nova-pop-note">Web, analyse de fichiers, image, vidéo et code : toujours disponibles, sans sélection.</div>
                      </div>
                    ) : null}
                  </div>

                  {/* 4) SÉLECTION D'EFFORT */}
                  <div className="nova-zone-relative">
                    <button
                      type="button"
                      className="nova-pill point-effort"
                      aria-haspopup="true"
                      aria-expanded={popEffort}
                      onClick={() => {
                        setPopOutils(false);
                        setPopEffort((o) => !o);
                      }}
                      title="Niveau d'effort de l'IA"
                    >
                      <span aria-hidden="true">{EFFORTS[effort].ico}</span>
                      <span className="txt-long">{EFFORT_LABEL_COURT[effort]}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true" width="12" height="12"><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                    {popEffort ? (
                      <div className="nova-popover droite" role="menu" style={{ minWidth: 280 }}>
                        <div className="nova-pop-titre">Effort de réflexion</div>
                        {(Object.keys(EFFORTS) as EffortId[]).map((id) => (
                          <button
                            type="button"
                            key={id}
                            className={`nova-pop-item${effort === id ? " selected" : ""}`}
                            role="menuitemradio"
                            aria-checked={effort === id}
                            onClick={() => changerEffort(id)}
                          >
                            <span className="ico" aria-hidden="true">{EFFORTS[id].ico}</span>
                            <span className="txt">
                              {EFFORTS[id].nom}
                              <span className="sub">{EFFORTS[id].sub}</span>
                            </span>
                            <span className="coche" />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {/* 5) RECHERCHE WEB (toggle) */}
                  <button
                    type="button"
                    className={`nova-pill${rechercheWeb ? " actif" : ""}`}
                    aria-pressed={rechercheWeb}
                    onClick={basculerRechercheWeb}
                    title={rechercheWeb ? "Recherche web activée pour le prochain message" : "Activer la recherche web pour le prochain message"}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" /></svg>
                    <span className="txt-long">Recherche web</span>
                  </button>
                </div>

                <div className="nova-barre-gauche" style={{ marginLeft: "auto" }}>
                  {longueur >= CFG.seuilCompteur ? (
                    <span className={`nova-compteur${longueur > CFG.maxCaracteres ? " alerte" : ""}`}>{longueur}/{CFG.maxCaracteres}</span>
                  ) : null}

                  {/* 1) ENVOI DU PROMPT (⇄ Arrêter) */}
                  <button
                    type="button"
                    className={`nova-envoi${enCours ? " stop" : ""}`}
                    aria-label={enCours ? "Arrêter la génération" : "Envoyer"}
                    title={enCours ? "Arrêter" : "Envoyer (Entrée)"}
                    disabled={envoiDesactive}
                    onClick={() => {
                      if (controleurRef.current) controleurRef.current.abort();
                      else void envoyer();
                    }}
                  >
                    {enCours ? (
                      <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                    ) : (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="nova-pied">
            Entrée pour envoyer · Maj + Entrée pour aller à la ligne · Gen3ia pilote toute la plateforme : agents, automatisations, médias, documents.
          </div>
        </footer>
      </main>

      {toast ? (
        <div className="nova-toast visible" role="status" key={toast.cle}>
          {toast.texte}
        </div>
      ) : null}
    </div>
  );
}



