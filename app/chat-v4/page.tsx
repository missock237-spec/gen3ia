"use client";

/**
 * Page « Chat v4 » — port React de la maquette standalone
 * gen3ia-chat-v4.html de l'utilisateur, avec les couleurs du design
 * system AURORA OS V5 (tokens --g3-*) et le BACKEND RÉEL de chat.
 *
 * Ce qui est branché sur l'API réelle :
 *  · Streaming NDJSON : POST /api/workspace/conversations/{id}/messages/stream
 *    (fragments message_delta → rendu token par token, bouton Arrêter via
 *    AbortController, événements status affichés dans la barre du haut).
 *  · Création / suppression / renommage de conversation côté serveur
 *    (POST/DELETE/PATCH /api/workspace/conversations[...]).
 *  · Sélecteur de modèle (Rapide/Équilibré/Expert) → couple provider/model
 *    réel (aligné sur lib/ui/composer-models.ts) envoyé au tour.
 *  · Pièces jointes : téléversement réel via uploadPermanentFiles puis
 *    passées au tour (chips locales + validation conservées de la v4).
 *  · Régénération : renvoie le dernier message utilisateur (comportement
 *    canonique de conversation-workspace.tsx). Édition : remet le dernier
 *    message dans le composer.
 *
 * Système de plugins ACTIVÉ (Task 151 — agents IA ⇄ apps externes) :
 *  · Le popover « Outils » liste les VRAIES applications connectées
 *    (connecteurs Composio vérifiés + API personnelles) : les slugs
 *    sélectionnés partent dans le corps du tour (champ « connectors ») et
 *    le moteur conversationnel injecte au planificateur les actions
 *    disponibles sur ces toolkits (outil composio.execute) — l'agent
 *    peut AGIR dans les apps externes (envoi Gmail, événement Calendar,
 *    ticket Zendesk…), avec validation humaine pour les actions à risque.
 *  · Sans connexion : services populaires connectables en un clic (OAuth
 *    Composio, redirection) et lien vers /integrations. Web, analyse de
 *    fichiers, image et code restent des capacités permanentes de
 *    l'agent (outils du registre — aucun sélecteur requis).
 *
 * Persistance UI : localStorage clé « gen3ia-chat-v4 » (conversations,
 * modèle choisi, conversation active) — le serveur reste l'autorité des
 * messages. Auth : cookie de session same-origin (même pattern que
 * conversation-workspace.tsx). Thème : ThemeToggle réutilisé (data-theme).
 */

import * as React from "react";

import { ThemeToggle } from "@/components/ui/theme-toggle";
import { safeClientTimezone } from "@/lib/domain/conversations/stream-client";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import type { ConversationStreamEvent } from "@/lib/domain/conversations/stream-events";
import "./chat-v4.css";

/* ================= Configuration ================= */

const CFG = {
  cle: "gen3ia-chat-v4",
  maxCaracteres: 4000,
  seuilCompteur: 3000,
  maxFichiers: 10,
  maxFichierMo: 20,
  maxConvs: 60,
};

type TierId = "rapide" | "equilibre" | "expert";

interface ModeleDef {
  nom: string;
  ico: string;
  sub: string;
  /** Couple provider/model réel (undefined = routage automatique Gen3ia). */
  provider?: string;
  model?: string;
}

/** Tiers v4 → moteurs réels, alignés sur lib/ui/composer-models.ts :
 *  Rapide = GPT-OSS 120B via Groq (« réponses éclair »), Équilibré = routeur
 *  automatique, Expert = Claude 3.5 Sonnet (« analyse approfondie »). */
const MODELES: Record<TierId, ModeleDef> = {
  rapide: {
    nom: "Gen3ia Rapide",
    ico: "⚡",
    sub: "Réponses instantanées, questions simples",
    provider: "groq",
    model: "openai/gpt-oss-120b",
  },
  equilibre: {
    nom: "Gen3ia Équilibré",
    ico: "🎯",
    sub: "Bon compromis vitesse et qualité",
  },
  expert: {
    nom: "Gen3ia Expert",
    ico: "🧠",
    sub: "Raisonnement avancé, analyses longues",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
  },
};

/** Icônes des applications populaires (repli : emoji générique « ⧉ »). */
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

/** Services populaires proposés à la connexion OAuth directe depuis le chat
 * (même liste que le sélecteur de connecteurs du composer workspace). */
const APPS_SUGGEREES = ["gmail", "googledrive", "googlecalendar", "slack", "notion", "github"] as const;

const iconeApp = (slug: string) => ICONES_APPS[slug] ?? "⧉";

const CARTES_ACCUEIL = [
  { ico: "✉️", titre: "Relance client", desc: "Un message court et poli", sugg: "Rédige un message de relance client poli pour un restaurant" },
  { ico: "⚡", titre: "Workflow n8n", desc: "Automatiser en 3 étapes", sugg: "Crée un workflow n8n simple qui enregistre les leads dans Google Sheets" },
  { ico: "🎬", titre: "Idées TikTok", desc: "Hooks et formats viraux", sugg: "Propose 3 idées de vidéos TikTok sur l'IA pour débutants" },
  { ico: "🚀", titre: "Présenter Gen3ia", desc: "Un résumé clair du produit", sugg: "Résume ce que fait Gen3ia en quelques phrases" },
];

/* ================= Types locaux ================= */

interface V4FichierMsg {
  nom: string;
  taille: number;
  type: string;
}

interface V4Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  date: number;
  modele?: string;
  erreur?: boolean;
  enCours?: boolean;
  imageUrl?: string;
  fichiers?: V4FichierMsg[];
}

interface V4Conversation {
  id: string;
  /** Identifiant de la conversation côté serveur (créée au 1er message). */
  serverId?: string;
  titre: string;
  messages: V4Message[];
  maj: number;
  /** Suggestions de suivi renvoyées par le serveur (événement « done »). */
  suggestions?: string[];
}

interface V4Piece {
  nom: string;
  taille: number;
  type: string;
  fichier: File;
  apercu: string | null;
}

/** Application externe connectée (connecteur Composio vérifié). */
interface V4AppConnectee {
  id: string;
  toolkit: string;
  label: string;
}

/** API personnelle déclarée par l'utilisateur (slug « api-<id> »). */
interface V4ApiPerso {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
}

/* ================= Utilitaires (portés de la v4) ================= */

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

/** Markdown léger et sûr de la v4 : le texte est échappé AVANT toute
 *  transformation — aucun HTML brut n'est injecté. */
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
  if (t.includes("n8n") || t.includes("workflow")) return ["Ajoute une étape de notification", "Exporte ce workflow en JSON", "Explique chaque nœud"];
  if (t.includes("tiktok") || t.includes("vidéo")) return ["Écris le script complet de la vidéo 1", "Propose 5 légendes", "Quel format pour les Shorts ?"];
  if (t.includes("relance") || t.includes("message")) return ["Version plus courte", "Version plus ferme", "Ajoute une relance J+7"];
  return ["Résume en 3 points", "Donne-moi un exemple concret", "Quelle est la prochaine étape ?"];
}

function idSuivant(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}

/** Charge l'état persisté (clé v4) — tolérant aux données absentes/corrompues. */
function chargerEtat(): { convs: V4Conversation[]; activeId: string | null; modele: TierId } {
  const vide = { convs: [] as V4Conversation[], activeId: null, modele: "equilibre" as TierId };
  try {
    const brut = localStorage.getItem(CFG.cle);
    if (!brut) return vide;
    const d = JSON.parse(brut) as {
      convs?: V4Conversation[];
      activeId?: string | null;
      modele?: string;
    };
    const convs = Array.isArray(d.convs) ? d.convs : [];
    const modeleBrut = d.modele;
    const modele: TierId = modeleBrut === "rapide" || modeleBrut === "expert" ? modeleBrut : "equilibre";
    return { convs, activeId: d.activeId ?? null, modele };
  } catch {
    return vide;
  }
}

/* ================= Sous-composants ================= */

function BlocCode({ code }: { code: string }) {
  const [copie, setCopie] = React.useState(false);
  return (
    <pre>
      <button
        type="button"
        className="copier-code"
        onClick={() => {
          const ok = copierTexte(code);
          setCopie(ok);
          window.setTimeout(() => setCopie(false), 1600);
        }}
      >
        {copie ? "Copié ✓" : "Copier"}
      </button>
      <code>{code}</code>
    </pre>
  );
}

interface MessageViewProps {
  m: V4Message;
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
    <div className={`msg ${bot ? "bot" : "user"}`}>
      <div className="msg-avatar" aria-hidden="true">{bot ? "🤖" : "J"}</div>
      <div className="bubble-wrap">
        {m.fichiers && m.fichiers.length > 0 ? (
          <div className="msg-files">
            {m.fichiers.map((f, i) => (
              <span key={i} className="msg-file">{iconePour(f.nom)} {f.nom}</span>
            ))}
          </div>
        ) : null}

        <div className="bubble">
          {bot ? (
            m.enCours && !m.content ? (
              <div className="frappe" aria-label="Gen3ia prépare une réponse">
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
                  <img
                    src={m.imageUrl}
                    alt="Image générée par Gen3ia"
                    style={{ maxWidth: "100%", borderRadius: "12px", marginTop: "0.6em", display: "block" }}
                  />
                ) : null}
                {m.enCours ? <span className="curseur" aria-hidden="true" /> : null}
              </>
            )
          ) : (
            m.content
          )}
        </div>

        {!m.enCours ? (
          <div className="msg-meta">
            {bot && m.modele ? <span className="modele">{m.modele}</span> : null}
            <span className="heure">{heure(m.date)}</span>
            {bot ? (
              <button type="button" className="act" aria-label="Copier la réponse" onClick={() => onCopier(m.content)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                Copier
              </button>
            ) : (
              <button type="button" className="act" aria-label="Copier le message" onClick={() => onCopier(m.content)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                Copier
              </button>
            )}
            {bot && dernierBot ? (
              <button type="button" className="act" aria-label="Régénérer la réponse" onClick={onRegenerer}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
                {m.erreur ? "Réessayer" : "Régénérer"}
              </button>
            ) : null}
            {!bot && dernierUser ? (
              <button type="button" className="act" aria-label="Modifier le message" onClick={onModifier}>
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

/* ================= Presse-papiers / toasts ================= */

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

/* ================= Page ================= */

export default function ChatV4Page() {
  /* ---- État React (miroirs refs pour les flux async) ---- */
  const [convs, setConvs] = React.useState<V4Conversation[]>([]);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [modele, setModele] = React.useState<TierId>("equilibre");
  const [outils, setOutils] = React.useState<string[]>([]);
  const [fichiers, setFichiers] = React.useState<V4Piece[]>([]);
  const [saisie, setSaisie] = React.useState("");
  const [recherche, setRecherche] = React.useState("");
  const [enCours, setEnCours] = React.useState(false);
  const [statut, setStatut] = React.useState("Prêt à répondre");
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [popOutils, setPopOutils] = React.useState(false);
  const [popModele, setPopModele] = React.useState(false);
  /* Applications connectées (plugins) : chargées à la 1re ouverture du
   * popover — null = pas encore chargé, [] = aucune connexion. */
  const [apps, setApps] = React.useState<V4AppConnectee[] | null>(null);
  const [apisPersos, setApisPersos] = React.useState<V4ApiPerso[]>([]);
  const [chargementApps, setChargementApps] = React.useState(false);
  const [connexionApp, setConnexionApp] = React.useState<string | null>(null);
  const [basVisible, setBasVisible] = React.useState(false);
  const [toast, setToast] = React.useState<{ texte: string; cle: number } | null>(null);
  const [charge, setCharge] = React.useState(false);

  const convsRef = React.useRef<V4Conversation[]>([]);
  const activeIdRef = React.useRef<string | null>(null);
  const modeleRef = React.useRef<TierId>("equilibre");
  const outilsRef = React.useRef<Set<string>>(new Set());
  const controleurRef = React.useRef<AbortController | null>(null);
  const saisieRef = React.useRef<HTMLTextAreaElement | null>(null);
  const messagesRef = React.useRef<HTMLDivElement | null>(null);
  const procheBasRef = React.useRef(true);
  const indexSaisieRef = React.useRef(-1);
  const toastTimerRef = React.useRef<number | null>(null);

  /* ---- Synchronisation refs ⇄ state ---- */
  const majConvs = React.useCallback((next: V4Conversation[]) => {
    convsRef.current = next;
    setConvs(next);
  }, []);
  const majActiveId = React.useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);
  const majModele = React.useCallback((id: TierId) => {
    modeleRef.current = id;
    setModele(id);
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

  /* ---- Persistance (clé v4 inchangée) ---- */
  const sauvegarder = React.useCallback(() => {
    try {
      const tries = [...convsRef.current].sort((a, b) => b.maj - a.maj).slice(0, CFG.maxConvs);
      localStorage.setItem(
        CFG.cle,
        JSON.stringify({ convs: tries, activeId: activeIdRef.current, modele: modeleRef.current }),
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
    modeleRef.current = etat.modele;
    setConvs(etat.convs);
    setActiveId(actif);
    setModele(etat.modele);
    setCharge(true);
  }, []);

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

  const nouvelleConversation = React.useCallback((): V4Conversation => {
    const conv: V4Conversation = { id: idSuivant(), titre: "Nouvelle conversation", messages: [], maj: Date.now() };
    majConvs([conv, ...convsRef.current]);
    majActiveId(conv.id);
    return conv;
  }, [majActiveId, majConvs]);

  /* ---- Fichiers (chips locales + validation v4) ---- */
  const viderFichiers = React.useCallback((liste: V4Piece[]) => {
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

  /* ---- Génération réelle (streaming NDJSON) ---- */

  const majMessage = React.useCallback(
    (convId: string, msgId: string, maj: (m: V4Message) => V4Message) => {
      majConvs(
        convsRef.current.map((c) =>
          c.id !== convId ? c : { ...c, maj: Date.now(), messages: c.messages.map((m) => (m.id === msgId ? maj(m) : m)) },
        ),
      );
    },
    [majConvs],
  );

  /** Exécute un tour réel : crée la conversation serveur si besoin, puis
   *  consomme le flux NDJSON du tour (fragments, statuts, résultat). */
  const lancerGeneration = React.useCallback(
    async (conv: V4Conversation, message: string, pieces: V4Piece[]) => {
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

      const def = MODELES[modeleRef.current];
      // Task 151 — système de plugins : les connecteurs activés (slugs
      // d'apps externes / « api-<id> ») accompagnent le tour ; le moteur les
      // injecte au planificateur (actions composio.execute / custom_api.*).
      const connecteurs = [...outilsRef.current].slice(0, 8);
      const corps: Record<string, unknown> = {
        message,
        timezone: safeClientTimezone(),
        ...(piecesApi.length > 0 ? { attachments: piecesApi } : {}),
        ...(def.provider && def.model ? { provider: def.provider, model: def.model } : {}),
        ...(connecteurs.length > 0 ? { connectors: connecteurs } : {}),
      };

      const streamId = idSuivant();
      majConvs(
        convsRef.current.map((c) =>
          c.id !== conv.id ? c : { ...c, messages: [...c.messages, { id: streamId, role: "assistant", content: "", date: Date.now(), enCours: true }] },
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
              majMessage(conv.id, streamId, (m) => ({ ...m, content: contenu }));
              descendre();
              break;
            case "message_complete":
              recu = true;
              contenu = event.message.content || contenu;
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
              // run_created / step_update / approval_created / artifact_created :
              // non rendus dans cette UI épurée — la persistance serveur reste
              // consultable dans /workspace/conversations.
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
        majMessage(conv.id, streamId, (m) => ({ ...m, enCours: false, modele: m.modele || def.nom }));
      } catch (err) {
        const interrompu = controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError");
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
        setStatut("Prêt à répondre");
        sauvegarder();
      }
    },
    [descendre, majConvs, majMessage, sauvegarder],
  );

  /* ---- Envoi d'un message ---- */
  const envoyer = React.useCallback(
    async (texteBrut?: string) => {
      if (controleurRef.current) return; // une génération à la fois (v4)

      const message = (texteBrut ?? saisie).trim();
      const pieces = fichiers;
      if ((!message && pieces.length === 0) || message.length > CFG.maxCaracteres) return;

      const conv = conversationActive() || nouvelleConversation();
      if (!conv.messages.length) {
        conv.titre = (message || pieces[0]?.nom || "Nouvelle conversation").slice(0, 45);
      }
      conv.suggestions = undefined;

      const userMsg: V4Message = {
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
      descendre(true);

      // L'API exige un message non vide : un envoi « fichiers seuls » porte
      // une consigne par défaut, les pièces jointes voyageant à part.
      const messageApi = message || (pieces.length > 1 ? "Analyse les fichiers joints." : "Analyse le fichier joint.");

      try {
        await lancerGeneration(conv, messageApi, pieces);
        viderFichiers(pieces);
      } catch (err) {
        // Erreur SANS contenu reçu : le message utilisateur revient dans le
        // composer (rien n'est perdu) + toast. Avec contenu partiel : le fil
        // conserve l'échange (comportement v4) et le toast suffit.
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
        setSidebarOpen(false);
        return;
      }
      controleurRef.current?.abort();
      controleurRef.current = null;
      setFichiers((courants) => {
        viderFichiers(courants);
        return [];
      });
      majActiveId(id);
      setSidebarOpen(false);
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

  /* ---- Outils / modèle ---- */
  const basculerOutil = React.useCallback((id: string) => {
    const next = new Set(outilsRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    outilsRef.current = next;
    setOutils([...next]);
  }, []);

  /** Libellé français d'un connecteur sélectionné (chip au-dessus du composer). */
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

  /** Charge les applications connectées (connecteurs Composio vérifiés) et
   * les API personnelles — dégradation silencieuse : sans clé Composio ou
   * session expirée, la liste reste vide et le chat fonctionne normalement. */
  const chargerApps = React.useCallback(async () => {
    if (apps !== null || chargementApps) return;
    setChargementApps(true);
    try {
      const [repConns, repApis] = await Promise.all([
        fetch("/api/integrations/composio/connections", { cache: "no-store" }).catch(() => null),
        fetch("/api/custom-apis", { cache: "no-store" }).catch(() => null),
      ]);
      const connectees: V4AppConnectee[] = [];
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
        const data = (await repApis.json().catch(() => ({}))) as { apis?: V4ApiPerso[] };
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

  /** Lance la connexion OAuth d'une application depuis le chat (redirection). */
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

  const changerModele = React.useCallback(
    (id: TierId) => {
      majModele(id);
      setPopModele(false);
      sauvegarder();
    },
    [majModele, sauvegarder],
  );

  /* ---- Nouvelle conversation (bouton / Ctrl+K) ---- */
  const boutonNouvelle = React.useCallback(() => {
    controleurRef.current?.abort();
    const conv = conversationActive();
    if (conv && !conv.messages.length) {
      saisieRef.current?.focus();
      setSidebarOpen(false);
      return;
    }
    nouvelleConversation();
    setFichiers((courants) => {
      viderFichiers(courants);
      return [];
    });
    sauvegarder();
    setSidebarOpen(false);
    saisieRef.current?.focus();
  }, [conversationActive, nouvelleConversation, sauvegarder, viderFichiers]);

  /* ---- Raccourcis clavier globaux (v4) ---- */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        boutonNouvelle();
      }
      if (e.key === "Escape") {
        setPopOutils(false);
        setPopModele(false);
        setSidebarOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [boutonNouvelle]);

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

  /* ---- Drag & drop pièces jointes ---- */
  const [dropActif, setDropActif] = React.useState(false);
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

  const groupes: Array<{ titre: string; convs: V4Conversation[] }> = [];
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
    <div className="chat-v4">
      <div className={`overlay${sidebarOpen ? " open" : ""}`} onClick={() => setSidebarOpen(false)} />

      {/* ================= Sidebar ================= */}
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`} aria-label="Historique des conversations">
        <div className="brand">
          <div className="logo-mark" aria-hidden="true">G</div>
          <div className="logo">Gen3ia</div>
        </div>
        <button type="button" className="btn-nouveau" onClick={boutonNouvelle} title="Nouvelle conversation (Ctrl+K)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Nouvelle conversation
        </button>
        <input
          className="search-conv"
          type="search"
          placeholder="Rechercher une conversation…"
          aria-label="Rechercher une conversation"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
        />
        <nav className="liste-convs" aria-label="Conversations">
          {charge && groupes.length === 0 ? (
            <div className="vide-liste">{convs.length ? "Aucun résultat" : "Aucune conversation pour le moment"}</div>
          ) : null}
          {groupes.map((g) => (
            <React.Fragment key={g.titre}>
              <div className="groupe-titre">{g.titre}</div>
              {g.convs.map((c) => (
                <div
                  key={c.id}
                  className={`conv${c.id === activeId ? " active" : ""}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => selectionnerConversation(c.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") selectionnerConversation(c.id);
                  }}
                >
                  <span className="conv-titre">{c.titre}</span>
                  <span className="conv-actions">
                    <button
                      type="button"
                      className="edit"
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
                      className="del"
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
        <div className="sidebar-foot">
          <div className="avatar-user" aria-hidden="true">J</div>
          <div className="user-info">
            <strong>Vous</strong>
            <span>Gen3ia Chat</span>
          </div>
        </div>
      </aside>

      {/* ================= Zone principale ================= */}
      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn-icon menu-burger"
            aria-label="Ouvrir l'historique"
            onClick={() => setSidebarOpen(true)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
          </button>
          <div className="agent-avatar" aria-hidden="true">🤖</div>
          <div>
            <div className="agent-name">Assistant Gen3ia</div>
            <div className="agent-status" role="status">{statut}</div>
          </div>
          <div className="topbar-actions">
            <button type="button" className="btn-icon" onClick={exporterConversation} aria-label="Exporter la conversation en Markdown" title="Exporter (.md)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            </button>
            <ThemeToggle compact />
          </div>
        </header>

        <section
          className="messages"
          ref={messagesRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          aria-busy={enCours}
          onScroll={onScrollMessages}
        >
          {messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-logo" aria-hidden="true">✨</div>
              <h2>Comment puis-je t&apos;aider ?</h2>
              <p>Pose une question, joins un fichier ou choisis une suggestion.</p>
              <div className="cartes">
                {CARTES_ACCUEIL.map((carte) => (
                  <button type="button" key={carte.titre} className="carte" onClick={() => void envoyer(carte.sugg)}>
                    <div className="carte-ico" aria-hidden="true">{carte.ico}</div>
                    <div className="carte-titre">{carte.titre}</div>
                    <div className="carte-desc">{carte.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
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
            ))
          )}

          {suggestions ? (
            <div className="suggestions">
              {suggestions.map((texte) => (
                <button type="button" key={texte} className="chip-sugg" onClick={() => void envoyer(texte)}>
                  {texte}
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <button
          type="button"
          className={`btn-bas${basVisible ? " visible" : ""}`}
          aria-label="Aller au dernier message"
          onClick={() => descendre(true)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
        </button>

        <footer className="composer">
          <div className="composer-inner">
            <div
              className={`composer-box${dropActif ? " drop" : ""}`}
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
              {fichiers.length > 0 ? (
                <div className="pieces">
                  {fichiers.map((f, i) => (
                    <div className="piece" key={`${f.nom}-${i}`}>
                      <div className="piece-vignette">
                        {f.apercu ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={f.apercu} alt="" />
                        ) : (
                          iconePour(f.nom)
                        )}
                      </div>
                      <div className="piece-info">
                        <div className="piece-nom">{f.nom}</div>
                        <div className="piece-taille">{formaterTaille(f.taille)}</div>
                      </div>
                      <button type="button" className="piece-retirer" aria-label="Retirer le fichier" onClick={() => retirerFichier(i)}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              {outils.length > 0 ? (
                <div className="outils-actifs">
                  {outils.map((id) => (
                    <span className="outil-chip" key={id} title="Application activée pour vos prochains messages">
                      {libelleOutil(id)}
                      <button type="button" aria-label="Désactiver" onClick={() => basculerOutil(id)}>×</button>
                    </span>
                  ))}
                </div>
              ) : null}

              <textarea
                ref={saisieRef}
                rows={1}
                placeholder="Écris ton message… (↑ pour rappeler le dernier message)"
                aria-label="Message"
                value={saisie}
                onChange={(e) => {
                  indexSaisieRef.current = -1;
                  setSaisie(e.target.value);
                }}
                onKeyDown={onKeyDownSaisie}
                onPaste={onPasteSaisie}
              />

              <div className="barre">
                <div className="barre-gauche">
                  <label className="btn-icon" title="Joindre un fichier" aria-label="Joindre un fichier">
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

                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="pill"
                      aria-haspopup="true"
                      aria-expanded={popOutils}
                      onClick={() => {
                        setPopModele(false);
                        setPopOutils((o) => !o);
                        void chargerApps();
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.1-.6-.6-2.1 2.5-2.5z" /></svg>
                      <span className="txt-long">Outils</span>
                      {outils.length > 0 ? <span className="tag">{outils.length}</span> : null}
                    </button>
                    {popOutils ? (
                      <div className="popover" role="menu">
                        <div className="pop-titre">Applications pour ce message</div>
                        {chargementApps ? (
                          <div className="pop-item" style={{ cursor: "default" }}>
                            <span className="ico" aria-hidden="true">⏳</span>
                            <span className="txt">Chargement de vos connexions…</span>
                          </div>
                        ) : (apps ?? []).length === 0 && apisPersos.length === 0 ? (
                          <div className="pop-vide">
                            <p className="pop-vide-txt">Aucune application connectée — l&apos;agent peut agir dans vos apps (Gmail, Calendar, Slack, Notion, Zendesk…) dès qu&apos;elles sont reliées à Gen3ia.</p>
                            <p className="pop-vide-sous">Services populaires :</p>
                            <div className="pop-suggestions">
                              {APPS_SUGGEREES.map((toolkit) => (
                                <button
                                  type="button"
                                  key={toolkit}
                                  className="pop-sugg-chip"
                                  disabled={connexionApp !== null}
                                  onClick={() => void connecterApp(toolkit)}
                                  title={`Connecter ${toolkit} — page d'autorisation`}
                                >
                                  {connexionApp === toolkit ? "…" : `${iconeApp(toolkit)} ${toolkit}`}
                                </button>
                              ))}
                            </div>
                            <a className="pop-lien" href="/integrations">Gérer toutes les connexions →</a>
                          </div>
                        ) : (
                          <>
                            {(apps ?? []).map((app) => (
                              <button
                                type="button"
                                key={app.id}
                                className={`pop-item outil-item${outils.includes(app.toolkit) ? " selected" : ""}`}
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
                                <div className="pop-sep">Mes API personnelles</div>
                                {apisPersos.map((api) => {
                                  const slug = `api-${api.id}`;
                                  return (
                                    <button
                                      type="button"
                                      key={api.id}
                                      className={`pop-item outil-item${outils.includes(slug) ? " selected" : ""}`}
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
                        <div className="pop-note">Web, analyse de fichiers, image et code : toujours disponibles, sans sélection.</div>
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="barre-droite">
                  {longueur >= CFG.seuilCompteur ? (
                    <span className={`compteur${longueur > CFG.maxCaracteres ? " alerte" : ""}`}>{longueur}/{CFG.maxCaracteres}</span>
                  ) : null}

                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="pill pill-modele"
                      aria-haspopup="true"
                      aria-expanded={popModele}
                      onClick={() => {
                        setPopOutils(false);
                        setPopModele((o) => !o);
                      }}
                    >
                      <span>{MODELES[modele].nom}</span>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                    </button>
                    {popModele ? (
                      <div className="popover right" role="menu" style={{ minWidth: 280 }}>
                        <div className="pop-titre">Modèle</div>
                        {(Object.keys(MODELES) as TierId[]).map((id) => (
                          <button
                            type="button"
                            key={id}
                            className={`pop-item modele-item${modele === id ? " selected" : ""}`}
                            role="menuitemradio"
                            aria-checked={modele === id}
                            onClick={() => changerModele(id)}
                          >
                            <span className="ico" aria-hidden="true">{MODELES[id].ico}</span>
                            <span className="txt">
                              {MODELES[id].nom}
                              <span className="sub">{MODELES[id].sub}</span>
                            </span>
                            <span className="coche" />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <button
                    type="button"
                    className={`btn-envoi${enCours ? " stop" : ""}`}
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
          <div className="pied">Entrée pour envoyer · Maj + Entrée pour aller à la ligne · Gen3ia peut faire des erreurs, vérifie les infos importantes.</div>
        </footer>
      </main>

      {toast ? (
        <div className="toast visible" role="status" key={toast.cle}>
          {toast.texte}
        </div>
      ) : null}
    </div>
  );
}

/* Copie presse-papiers partagée (boutons de bloc de code) — le retour
 * visuel est l'état « Copié ✓ » du bouton lui-même. */
function copierTexte(texte: string): boolean {
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(texte).catch(() => {
      fallbackCopier(texte);
    });
    return true;
  }
  return fallbackCopier(texte);
}
