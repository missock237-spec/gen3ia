"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MarkdownContent } from "@/components/workspace/markdown";
import { authFetch, readJsonSafely } from "@/lib/firebase/auth-client";
import { uploadPermanentFiles } from "@/lib/storage/upload-client";
import { ATTACHMENT_MAX_FILES, validateAttachment } from "@/lib/files/attachment-policy";
import { COMPOSER_MODEL_OPTIONS, findModelOption } from "@/lib/ui/composer-models";
import type { Conversation, ConversationMessage, MessageAttachment } from "@/lib/domain/conversations/types";
import type { ConversationStreamEvent } from "@/lib/domain/conversations/stream-events";
import { safeClientTimezone, streamConversationTurn } from "@/lib/domain/conversations/stream-client";
import { isInsufficientFundsError, errorFromResponse } from "@/lib/billing/insufficient-funds-client";

import {
  CarteAuth,
  CarteSysteme,
  Icones,
  WelcomeAurora,
  formaterTaille,
  groupeDe,
  heureFr,
  iconePourNom,
  suggestionsPour,
} from "./aurora-widgets";
import { useVoiceInput } from "./use-voice-input";
import { cancelSpeech, speakFr } from "./voice-speak";
import "./aurora-chat.css";

/**
 * CHAT AURORA (/chat) — interface de conversation directe fournie par
 * l'utilisateur (« gen3ia-chat-v4 »), portée en React et re-skinnée sur
 * le design system Aurora OS du projet :
 *
 *  · conversations RÉELLES (mémoire serveur par utilisateur) : liste,
 *    recherche, renommage, suppression, export Markdown ;
 *  · réponse en STREAMING NDJSON (mêmes événements que le workspace) :
 *    phases de travail, fragments de texte, état final ;
 *  · pièces jointes réelles (stockage permanent R2, multipart presigné) ;
 *  · sélecteur de modèle réel (routeur multi-fournisseurs Gen3ia) ;
 *  · connecteurs d'applications externes (Composio) activables par
 *    message — le système de plugins déployé en Task 162 ;
 *  · thèmes sombre/clair via les tokens --g3-* (aucune couleur en dur).
 */

interface ConversationDetail {
  conversation: Conversation;
  project: { id: string; name: string } | null;
  messages: ConversationMessage[];
  runs: unknown[];
  artifacts: unknown[];
  approvals: unknown[];
}

/** Tour en cours rendu en direct dans le fil (même contrat que le workspace). */
interface LiveTurn {
  status: string;
  content: string;
  imageUrl?: string;
  error?: boolean;
}

/** Pièce jointe en préparation dans le composer (avant upload). */
interface PiecePreparation {
  nom: string;
  taille: number;
  type: string;
  fichier: File;
  apercu: string | null;
}

interface ProfilInfo {
  nom: string;
  initiale: string;
  sousTitre: string;
}

interface ConnexionActive {
  id: string;
  toolkit: string;
  label: string;
  category: string;
  status: string;
  enabled: boolean;
  verified: boolean;
}

/** Mêmes services populaires que le picker du workspace (Task 143). */
const TOOLKITS_SUGGERES = ["gmail", "googledrive", "googlecalendar", "slack", "notion", "github", "whatsapp", "telegram"] as const;

const MAX_CARACTERES = 4000;
const SEUIL_COMPTEUR = 3000;

const MESSAGE_RESEAU_COUPE = "Connexion interrompue — nouvelle tentative dès le retour du réseau.";

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof TypeError ||
    /failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(error.message)
  );
}

function emptyLive(): LiveTurn {
  return { status: "", content: "" };
}

export function AuroraChat() {
  /* ───────────────── État ───────────────── */
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [authRequise, setAuthRequise] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [erreur, setErreur] = useState("");

  const [query, setQuery] = useState("");
  const [saisie, setSaisie] = useState("");
  const [indexSaisie, setIndexSaisie] = useState(-1);
  const [pieces, setPieces] = useState<PiecePreparation[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragActif, setDragActif] = useState(false);

  const [modelId, setModelId] = useState("auto");
  const [connecteurs, setConnecteurs] = useState<string[]>([]);
  const [connexions, setConnexions] = useState<ConnexionActive[] | null>(null);
  const [chargementConnexions, setChargementConnexions] = useState(false);
  const [enConnexion, setEnConnexion] = useState<string | null>(null);

  const [popOutils, setPopOutils] = useState(false);
  const [popModele, setPopModele] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [profil, setProfil] = useState<ProfilInfo | null>(null);
  const [toastTexte, setToastTexte] = useState("");
  const [toastVisible, setToastVisible] = useState(false);
  const [procheBas, setProcheBas] = useState(true);
  /* Chat voix : indicateur « lecture vocale en cours » de la réponse IA. */
  const [lectureVocale, setLectureVocale] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  /* Chat voix : le tour courant a-t-il été initié par la voix (dictée) ?
   * Consumé à la réponse (message_complete → TTS) puis réarmé. */
  const dernierTourVocalRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const saisieRef = useRef<HTMLTextAreaElement>(null);
  const inputFichierRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  /* ───────────────── Utilitaires ───────────────── */

  const afficherToast = useCallback((texte: string) => {
    setToastTexte(texte);
    setToastVisible(true);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastVisible(false), 2400);
  }, []);

  const procheDuBas = useCallback(() => {
    const zone = messagesRef.current;
    if (!zone) return true;
    return zone.scrollHeight - zone.scrollTop - zone.clientHeight < 160;
  }, []);

  const descendre = useCallback((force = false) => {
    const zone = messagesRef.current;
    if (!zone) return;
    if (force || procheDuBas()) zone.scrollTop = zone.scrollHeight;
  }, [procheDuBas]);

  const redimensionner = useCallback(() => {
    const zone = saisieRef.current;
    if (!zone) return;
    zone.style.height = "auto";
    zone.style.height = `${Math.min(zone.scrollHeight, 200)}px`;
  }, []);

  const copier = useCallback(
    (texte: string, message = "Copié dans le presse-papiers") => {
      const fallback = () => afficherToast("Copie impossible");
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(texte).then(() => afficherToast(message), fallback);
      } else {
        fallback();
      }
    },
    [afficherToast],
  );

  /* ───────────────── Chargements ───────────────── */

  const chargerListes = useCallback(async () => {
    try {
      const response = await fetch("/api/workspace/conversations?limit=50", { cache: "no-store" });
      if (response.status === 401 || response.status === 403) {
        setAuthRequise(true);
        return;
      }
      if (response.ok) {
        const data = (await response.json()) as { conversations?: Conversation[] };
        setConversations(Array.isArray(data.conversations) ? data.conversations : []);
        setAuthRequise(false);
      }
    } catch {
      /* réseau indisponible : liste conservée */
    } finally {
      setLoadingList(false);
    }
  }, []);

  const chargerDetail = useCallback(async (id: string, silencieux = false) => {
    if (!silencieux) setLoadingDetail(true);
    try {
      const response = await fetch(`/api/workspace/conversations/${id}`, { cache: "no-store" });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Conversation introuvable.");
      }
      const data = (await response.json()) as ConversationDetail;
      setDetail(data);
      setErreur("");
    } catch (err) {
      setErreur(err instanceof Error ? err.message : "Conversation introuvable.");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  /** Profil (sidebar) : best-effort — sans profil, identité neutre. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/auth/profile", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as {
          identity?: { displayName?: string | null; email?: string | null; plan?: string };
        };
        if (cancelled || !data.identity) return;
        const nom = data.identity.displayName || data.identity.email || "Gen3ia";
        const plan = data.identity.plan ? data.identity.plan : "free";
        setProfil({
          nom,
          initiale: (nom.trim()[0] ?? "G").toUpperCase(),
          sousTitre: `Plan ${plan === "free" ? "Découverte" : plan === "pro" ? "Pro" : "Enterprise"}`,
        });
      } catch {
        /* profil indisponible : identité neutre conservée */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Lien direct ?c=<id> : ouvre la conversation demandée au chargement. */
  useEffect(() => {
    void chargerListes();
    try {
      const param = new URLSearchParams(window.location.search).get("c");
      if (param) {
        setActiveId(param);
        void chargerDetail(param);
      }
    } catch {
      /* URL illisible : écran d'accueil */
    }
  }, [chargerListes, chargerDetail]);

  /* ───────────────── Popover « Outils » : connecteurs réels ───────────────── */

  const chargerConnexions = useCallback(async () => {
    if (connexions !== null) return;
    setChargementConnexions(true);
    try {
      const response = await authFetch("/api/integrations/composio/connections", { cache: "no-store" });
      const data = await readJsonSafely<{ connections?: ConnexionActive[] }>(response);
      setConnexions(Array.isArray(data?.connections) ? data!.connections! : []);
    } catch {
      setConnexions([]);
    } finally {
      setChargementConnexions(false);
    }
  }, [connexions]);

  useEffect(() => {
    if (popOutils) void chargerConnexions();
  }, [popOutils, chargerConnexions]);

  const connexionsActives = useMemo(
    () => (connexions ?? []).filter((connexion) => connexion.enabled && connexion.verified),
    [connexions],
  );

  const suggestionsConnexion = useMemo(() => {
    if (connexionsActives.length > 0) return [];
    return TOOLKITS_SUGGERES.filter((toolkit) => !connexionsActives.some((c) => c.toolkit === toolkit)).slice(0, 4);
  }, [connexionsActives]);

  /** Lance l'OAuth Composio d'un service directement depuis le chat. */
  const connecterService = useCallback(
    async (toolkit: string) => {
      if (enConnexion) return;
      setEnConnexion(toolkit);
      try {
        const response = await authFetch("/api/integrations/composio/connect", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ toolkit }),
        });
        const body = await readJsonSafely<{ authorizationUrl?: string }>(response);
        if (response.ok && body?.authorizationUrl) {
          window.location.assign(body.authorizationUrl);
          return;
        }
      } catch {
        /* redirection impossible : on reste sur place */
      }
      setEnConnexion(null);
      afficherToast("Connexion impossible pour le moment.");
    },
    [enConnexion, afficherToast],
  );

  const basculerConnecteur = useCallback((toolkit: string) => {
    setConnecteurs((courant) =>
      courant.includes(toolkit) ? courant.filter((item) => item !== toolkit) : [...courant, toolkit].slice(0, 8),
    );
  }, []);

  /* ───────────────── Streaming ───────────────── */

  const consommerEvenement = useCallback((event: ConversationStreamEvent) => {
    switch (event.type) {
      case "turn_started":
        setDetail((courant) => {
          if (!courant) return courant;
          const sansOptimiste = courant.messages.filter((m) => !m.id.startsWith("local-"));
          return { ...courant, messages: [...sansOptimiste, event.userMessage] };
        });
        break;
      case "status":
        setLive((courant) => ({ ...(courant ?? emptyLive()), status: event.label }));
        break;
      case "message_delta":
        setLive((courant) => ({ ...(courant ?? emptyLive()), content: (courant?.content ?? "") + event.delta }));
        break;
      case "message_complete":
        setLive((courant) => ({
          ...(courant ?? emptyLive()),
          content: event.message.content,
          imageUrl: event.message.imageUrl ?? courant?.imageUrl,
          status: "",
        }));
        /* Chat voix : réponse LUE uniquement si le tour a été dicté — les
         * tours écrits normaux restent silencieux (pas de TTS intrusif). */
        if (dernierTourVocalRef.current) {
          dernierTourVocalRef.current = false;
          const contenuVocal = event.message.content ?? "";
          if (contenuVocal.trim()) {
            setLectureVocale(true);
            const parle = speakFr(contenuVocal, { onFin: () => setLectureVocale(false) });
            if (!parle) setLectureVocale(false); // synthèse indisponible : reste textuel
          }
        }
        break;
      case "error":
        throw new Error(event.message);
      default:
        break;
    }
  }, []);

  /* ───────────────── Envoi d'un message ───────────────── */

  const envoyer = useCallback(
    async (texteBrut?: string, piecesForcees?: PiecePreparation[]) => {
      if (generating) return;
      const message = (texteBrut ?? saisie).trim();
      const piecesMessage = piecesForcees ?? pieces;
      if ((!message && piecesMessage.length === 0) || message.length > MAX_CARACTERES) return;

      setGenerating(true);
      setErreur("");
      setLive(emptyLive());

      /* 1) Conversation : la créée au premier message (titre dérivé). */
      let conversationId = activeId;
      if (!conversationId) {
        try {
          const response = await fetch("/api/workspace/conversations", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: (message || piecesMessage[0]?.nom || "Nouvelle conversation").slice(0, 60) }),
          });
          if (response.status === 401 || response.status === 403) {
            setAuthRequise(true);
            setGenerating(false);
            return;
          }
          if (!response.ok) throw new Error("Création impossible.");
          const data = (await response.json()) as { conversation: Conversation };
          conversationId = data.conversation.id;
          setActiveId(conversationId);
          setDetail({ conversation: data.conversation, project: null, messages: [], runs: [], artifacts: [], approvals: [] });
        } catch (err) {
          setErreur(err instanceof Error ? err.message : "Création impossible.");
          setGenerating(false);
          return;
        }
      }

      /* 2) Pièces jointes réelles : upload vers le stockage permanent. */
      let attachments: MessageAttachment[] = [];
      if (piecesMessage.length > 0) {
        setUploading(true);
        try {
          const batch = await uploadPermanentFiles(piecesMessage.map((piece) => piece.fichier));
          attachments = batch.uploaded.map((fichier) => ({
            filename: fichier.filename,
            path: fichier.path,
            contentType: fichier.contentType,
            sizeBytes: fichier.sizeBytes,
          }));
          if (batch.failed.length > 0) {
            afficherToast(`${batch.failed.length} fichier(s) non importé(s).`);
          }
        } catch {
          afficherToast("Import des fichiers impossible.");
        } finally {
          setUploading(false);
        }
      }

      /* 3) Message optimiste (remplacé par la version persistée du flux). */
      const optimiste: ConversationMessage = {
        id: `local-${Date.now()}`,
        conversationId,
        userId: "",
        role: "user",
        content: message,
        ...(attachments.length > 0 ? { attachments } : {}),
        generationStatus: "complete",
        createdAt: new Date().toISOString(),
      };
      setDetail((courant) =>
        courant ? { ...courant, messages: [...courant.messages, optimiste] } : courant,
      );
      setSaisie("");
      setIndexSaisie(-1);
      setPieces([]);
      redimensionner();

      const choixModele = findModelOption(modelId);
      const controller = new AbortController();
      abortRef.current = controller;

      const finDeTour = async () => {
        setLive(null);
        setGenerating(false);
        abortRef.current = null;
        dernierTourVocalRef.current = false; // tour terminé : réarmement voix
        await chargerDetail(conversationId!, true);
        void chargerListes();
        saisieRef.current?.focus();
      };

      try {
        await streamConversationTurn({
          conversationId: conversationId!,
          message,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(connecteurs.length > 0 ? { connectors: connecteurs } : {}),
          ...(choixModele?.provider ? { provider: choixModele.provider, model: choixModele.model } : {}),
          timezone: safeClientTimezone(),
          signal: controller.signal,
          onEvent: consommerEvenement,
        });
        await finDeTour();
      } catch (erreurFlux) {
        /* Arrêt demandé : le travail déjà persisté est rechargé tel quel. */
        if (controller.signal.aborted) {
          await finDeTour();
          return;
        }
        /* Solde insuffisant (402) : blocage définitif, message clair. */
        if (isInsufficientFundsError(erreurFlux)) {
          setDetail((courant) =>
            courant ? { ...courant, messages: courant.messages.filter((m) => m.id !== optimiste.id) } : courant,
          );
          setErreur(erreurFlux instanceof Error ? erreurFlux.message : "Solde insuffisant pour continuer.");
          setLive(null);
          setGenerating(false);
          abortRef.current = null;
          dernierTourVocalRef.current = false;
          return;
        }
        /* Repli : route classique (même persistance serveur). */
        try {
          const response = await fetch(`/api/workspace/conversations/${conversationId}/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message,
              ...(attachments.length > 0 ? { attachments } : {}),
              ...(connecteurs.length > 0 ? { connectors: connecteurs } : {}),
              ...(choixModele?.provider ? { provider: choixModele.provider, model: choixModele.model } : {}),
              ...(safeClientTimezone() ? { timezone: safeClientTimezone() } : {}),
            }),
          });
          if (!response.ok) {
            throw await errorFromResponse(
              response,
              erreurFlux instanceof Error ? erreurFlux.message : "Le message n'a pas pu être traité.",
            );
          }
          await finDeTour();
        } catch (erreurRepli) {
          if (isInsufficientFundsError(erreurRepli)) {
            setDetail((courant) =>
              courant ? { ...courant, messages: courant.messages.filter((m) => m.id !== optimiste.id) } : courant,
            );
            setErreur(
              erreurRepli instanceof Error ? erreurRepli.message : "Solde insuffisant pour continuer.",
            );
          } else {
            setErreur(
              isNetworkError(erreurFlux) || isNetworkError(erreurRepli)
                ? MESSAGE_RESEAU_COUPE
                : erreurRepli instanceof Error
                  ? erreurRepli.message
                  : "Le message n'a pas pu être traité.",
            );
          }
          setLive(null);
          setGenerating(false);
          abortRef.current = null;
          dernierTourVocalRef.current = false;
        }
      }
    },
    [
      generating,
      saisie,
      pieces,
      activeId,
      modelId,
      connecteurs,
      consommerEvenement,
      chargerDetail,
      chargerListes,
      afficherToast,
      redimensionner,
    ],
  );

  const arreter = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /* ───────────────── Chat voix (envoi sans prompt écrit) ─────────────────
   * Envoi vide + bouton d'envoi → le bouton devient un micro : le transcript
   * final est injecté puis ENVOYÉ automatiquement, et la réponse IA est lue
   * (voir consommerEvenement). Re-clic pendant l'écoute = annulation. */
  const saisieVocale = useVoiceInput({
    onTranscript: (texte) => {
      dernierTourVocalRef.current = true;
      setSaisie(texte); // injection dans l'état de saisie
      void envoyer(texte); // envoi automatique sans seconde action
    },
    onErreur: (message) => afficherToast(message),
  });

  /** Régénère la dernière réponse : renvoie le dernier message utilisateur. */
  const regenerer = useCallback(() => {
    if (generating || !detail) return;
    const dernierUser = [...detail.messages].reverse().find((m) => m.role === "user");
    if (!dernierUser) return;
    void envoyer(dernierUser.content, []);
  }, [generating, detail, envoyer]);

  /** Pré-remplit la saisie avec le dernier message utilisateur. */
  const modifierDernier = useCallback(() => {
    if (generating || !detail) return;
    const dernierUser = [...detail.messages].reverse().find((m) => m.role === "user");
    if (!dernierUser) return;
    setSaisie(dernierUser.content);
    redimensionner();
    saisieRef.current?.focus();
  }, [generating, detail, redimensionner]);

  /* ───────────────── Actions conversations ───────────────── */

  const ouvrirConversation = useCallback(
    (id: string) => {
      if (id === activeId) {
        setSidebarOpen(false);
        return;
      }
      if (generating) arreter();
      setActiveId(id);
      setDetail(null);
      setPieces([]);
      setErreur("");
      setSidebarOpen(false);
      void chargerDetail(id);
    },
    [activeId, generating, arreter, chargerDetail],
  );

  const nouvelleConversation = useCallback(() => {
    if (generating) arreter();
    if (detail && detail.messages.length === 0) {
      saisieRef.current?.focus();
      setSidebarOpen(false);
      return;
    }
    setActiveId(null);
    setDetail(null);
    setPieces([]);
    setErreur("");
    setSidebarOpen(false);
    saisieRef.current?.focus();
  }, [generating, arreter, detail]);

  const supprimerConversation = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      if (!window.confirm(`Supprimer « ${conv?.title ?? "cette conversation"} » ?`)) return;
      if (generating && id === activeId) arreter();
      try {
        const response = await fetch(`/api/workspace/conversations/${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error("Suppression impossible.");
        afficherToast("Conversation supprimée");
        if (id === activeId) {
          setActiveId(null);
          setDetail(null);
        }
        await chargerListes();
      } catch {
        afficherToast("Suppression impossible.");
      }
    },
    [conversations, generating, activeId, arreter, afficherToast, chargerListes],
  );

  const renommerConversation = useCallback(
    async (id: string) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return;
      const nouveau = window.prompt("Nouveau titre de la conversation :", conv.title);
      if (!nouveau || !nouveau.trim()) return;
      try {
        const response = await fetch(`/api/workspace/conversations/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: nouveau.trim().slice(0, 120) }),
        });
        if (!response.ok) throw new Error("Renommage impossible.");
        afficherToast("Conversation renommée");
        await chargerListes();
        if (id === activeId) void chargerDetail(id, true);
      } catch {
        afficherToast("Renommage impossible.");
      }
    },
    [conversations, afficherToast, chargerListes, chargerDetail, activeId],
  );

  /** Export Markdown de la conversation ouverte (généré côté client). */
  const exporterConversation = useCallback(() => {
    if (!detail || detail.messages.length === 0) {
      afficherToast("Rien à exporter pour le moment");
      return;
    }
    const corps = detail.messages
      .map(
        (m) =>
          `**${m.role === "user" ? "Vous" : "Gen3ia"}** · ${new Date(m.createdAt).toLocaleString("fr-FR")}\n\n${m.content}`,
      )
      .join("\n\n---\n\n");
    const contenu = `# ${detail.conversation.title}\n\n${corps}\n`;
    const nomFichier =
      (detail.conversation.title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "conversation").slice(0, 50) +
      ".md";
    const url = URL.createObjectURL(new Blob([contenu], { type: "text/markdown;charset=utf-8" }));
    const lien = document.createElement("a");
    lien.href = url;
    lien.download = nomFichier;
    document.body.appendChild(lien);
    lien.click();
    lien.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    afficherToast("Conversation exportée");
  }, [detail, afficherToast]);

  /* ───────────────── Pièces jointes ───────────────── */

  const ajouterFichiers = useCallback(
    (liste: FileList | File[]) => {
      for (const fichier of Array.from(liste)) {
        if (pieces.length >= ATTACHMENT_MAX_FILES) {
          afficherToast(`Maximum ${ATTACHMENT_MAX_FILES} fichiers par message.`);
          break;
        }
        const validation = validateAttachment({ name: fichier.name, size: fichier.size });
        if (!validation.ok) {
          afficherToast(`« ${fichier.name} » : ${validation.reason}`);
          continue;
        }
        const image = fichier.type.startsWith("image/");
        setPieces((courant) => [
          ...courant,
          {
            nom: fichier.name,
            taille: fichier.size,
            type: fichier.type,
            fichier,
            apercu: image ? URL.createObjectURL(fichier) : null,
          },
        ]);
      }
    },
    [pieces.length, afficherToast],
  );

  const retirerPiece = useCallback((index: number) => {
    setPieces((courant) => {
      const nouveau = [...courant];
      const [retiree] = nouveau.splice(index, 1);
      if (retiree?.apercu) URL.revokeObjectURL(retiree.apercu);
      return nouveau;
    });
  }, []);

  /* ───────────────── Historique de saisie (↑ / ↓) ───────────────── */

  const naviguerHistorique = useCallback(
    (sens: 1 | -1) => {
      const saisies = detail ? detail.messages.filter((m) => m.role === "user").map((m) => m.content) : [];
      if (saisies.length === 0) return false;
      const index = Math.max(-1, Math.min(saisies.length - 1, indexSaisie + sens));
      setIndexSaisie(index);
      setSaisie(index === -1 ? "" : saisies[saisies.length - 1 - index]);
      return true;
    },
    [detail, indexSaisie],
  );

  /* ───────────────── Effets d'interface ───────────────── */

  /* Défilement automatique pendant l'écriture en direct. */
  useEffect(() => {
    descendre();
  }, [detail?.messages.length, live?.content, live?.status, descendre]);

  /* Bouton « revenir en bas » selon la position de défilement. */
  useEffect(() => {
    const zone = messagesRef.current;
    if (!zone) return;
    const onScroll = () => setProcheBas(procheDuBas());
    zone.addEventListener("scroll", onScroll, { passive: true });
    return () => zone.removeEventListener("scroll", onScroll);
  }, [procheDuBas]);

  /* Bouton « Copier » sur les blocs de code (injection fidèle à l'UI d'origine). */
  useEffect(() => {
    const zone = messagesRef.current;
    if (!zone) return;
    zone.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copier-code")) return;
      pre.insertAdjacentHTML("beforeend", '<button class="copier-code" data-action="copier-code" type="button">Copier</button>');
    });
  }, [detail?.messages.length, live?.content, detail]);

  /* Raccourcis globaux : Ctrl+K nouvelle conversation, Échap ferme tout. */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === "k") {
        event.preventDefault();
        nouvelleConversation();
      }
      if (event.key === "Escape") {
        setPopOutils(false);
        setPopModele(false);
        setSidebarOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [nouvelleConversation]);

  /* Nettoyage des aperçus d'images à la destruction du composant. */
  const piecesRef = useRef<PiecePreparation[]>([]);
  useEffect(() => {
    piecesRef.current = pieces;
  }, [pieces]);
  useEffect(() => {
    return () => {
      piecesRef.current.forEach((piece) => piece.apercu && URL.revokeObjectURL(piece.apercu));
    };
  }, []);

  /* Focus initial et auto-dimensionnement du champ de saisie. */
  useEffect(() => {
    saisieRef.current?.focus();
  }, []);
  useEffect(() => {
    redimensionner();
  }, [saisie, redimensionner]);

  /* ───────────────── Dérivés de rendu ───────────────── */

  const conversationsFiltrees = useMemo(() => {
    const filtre = query.trim().toLowerCase();
    return conversations.filter((conv) => conv.title.toLowerCase().includes(filtre));
  }, [conversations, query]);

  const groupesSidebar = useMemo(() => {
    const groupes: Array<{ titre: string; items: Conversation[] }> = [];
    for (const conv of conversationsFiltrees) {
      const titre = groupeDe(conv.updatedAt);
      const dernier = groupes[groupes.length - 1];
      if (dernier && dernier.titre === titre) dernier.items.push(conv);
      else groupes.push({ titre, items: [conv] });
    }
    return groupes;
  }, [conversationsFiltrees]);

  const messages = detail?.messages ?? [];
  const indexDernierBot = messages.map((m) => m.role).lastIndexOf("assistant");
  const indexDernierUser = messages.map((m) => m.role).lastIndexOf("user");
  const dernierMessage = messages[messages.length - 1];
  const suggestionsSuivi = useMemo(() => {
    if (!dernierMessage || dernierMessage.role !== "assistant" || generating) return [];
    if (dernierMessage.suggestions && dernierMessage.suggestions.length > 0) return dernierMessage.suggestions;
    return suggestionsPour(dernierMessage.content);
  }, [dernierMessage, generating]);

  const envoiVide = !saisie.trim() && pieces.length === 0;
  const tropLong = saisie.length > MAX_CARACTERES;
  const statutAgent = generating ? live?.status || "Gen3ia écrit…" : "Prêt à répondre";
  const choixModele = findModelOption(modelId);

  /* ───────────────── Rendu ───────────────── */

  return (
    <div className="aurora-chat">
      <div className={`overlay${sidebarOpen ? " open" : ""}`} onClick={() => setSidebarOpen(false)} />

      {/* ── Sidebar : historique des conversations ── */}
      <aside className={`sidebar${sidebarOpen ? " open" : ""}`} aria-label="Historique des conversations">
        <div className="brand">
          <div className="logo-mark">G</div>
          <div className="logo">Gen3ia</div>
        </div>
        <button
          type="button"
          className="btn-nouveau"
          onClick={nouvelleConversation}
          title="Nouvelle conversation (Ctrl+K)"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden>
            <path d="M12 5v14M5 12h14" />
          </svg>
          Nouvelle conversation
        </button>
        <input
          className="search-conv"
          type="search"
          placeholder="Rechercher une conversation…"
          aria-label="Rechercher une conversation"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <nav className="liste-convs" aria-label="Conversations">
          {loadingList && <div className="vide-liste">Chargement…</div>}
          {!loadingList && conversations.length === 0 && (
            <div className="vide-liste">Aucune conversation pour le moment</div>
          )}
          {!loadingList && conversations.length > 0 && conversationsFiltrees.length === 0 && (
            <div className="vide-liste">Aucun résultat</div>
          )}
          {groupesSidebar.map((groupe) => (
            <Fragment key={groupe.titre}>
              <div className="groupe-titre">{groupe.titre}</div>
              {groupe.items.map((conv) => (
                <div
                  key={conv.id}
                  className={`conv${conv.id === activeId ? " active" : ""}`}
                  tabIndex={0}
                  role="button"
                  aria-current={conv.id === activeId || undefined}
                  onClick={() => ouvrirConversation(conv.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") ouvrirConversation(conv.id);
                  }}
                >
                  <span className="conv-titre">{conv.title}</span>
                  <span className="conv-actions">
                    <button
                      type="button"
                      className="edit"
                      aria-label="Renommer"
                      title="Renommer"
                      onClick={(event) => {
                        event.stopPropagation();
                        void renommerConversation(conv.id);
                      }}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="del"
                      aria-label="Supprimer"
                      title="Supprimer"
                      onClick={(event) => {
                        event.stopPropagation();
                        void supprimerConversation(conv.id);
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
              ))}
            </Fragment>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="avatar-user">{profil?.initiale ?? "G"}</div>
          <div className="user-info">
            <strong>{profil?.nom ?? "Gen3ia"}</strong>
            <span>{profil?.sousTitre ?? "Espace personnel"}</span>
          </div>
        </div>
      </aside>

      {/* ── Zone principale ── */}
      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn-icon menu-burger"
            onClick={() => setSidebarOpen(true)}
            aria-label="Ouvrir l'historique"
          >
            {Icones.burger}
          </button>
          <div className="agent-avatar" aria-hidden>
            🤖
          </div>
          <div>
            <div className="agent-name">Assistant Gen3ia</div>
            <div className="agent-status">{statutAgent}</div>
          </div>
          <div className="topbar-actions">
            <button
              type="button"
              className="btn-icon"
              onClick={exporterConversation}
              aria-label="Exporter la conversation en Markdown"
              title="Exporter (.md)"
            >
              {Icones.exportMd}
            </button>
            <BoutonTheme />
          </div>
        </header>

        <section
          className="messages"
          ref={messagesRef}
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          onClick={(event) => {
            const bouton = (event.target as HTMLElement).closest('[data-action="copier-code"]');
            if (bouton) {
              const code = bouton.closest("pre")?.querySelector("code")?.textContent ?? "";
              copier(code, "Code copié");
            }
          }}
        >
          {authRequise ? (
            <CarteAuth />
          ) : !detail || messages.length === 0 ? (
            <WelcomeAurora onSuggestion={(texte) => void envoyer(texte)} />
          ) : (
            <>
              {loadingDetail && <div className="vide-liste" style={{ textAlign: "center" }}>Chargement…</div>}
              {messages.map((message, index) => (
                <BulleMessage
                  key={message.id}
                  message={message}
                  dernierBot={index === indexDernierBot}
                  dernierUser={index === indexDernierUser && indexDernierUser > indexDernierBot}
                  initiale={profil?.initiale ?? "G"}
                  occupe={generating}
                  onCopier={copier}
                  onRegenerer={regenerer}
                  onModifier={modifierDernier}
                />
              ))}

              {/* Tour en cours : bulle de streaming avec statut en direct. */}
              {generating && live && (
                <div className="msg bot">
                  <div className="msg-avatar" aria-hidden>
                    🤖
                  </div>
                  <div className="bubble-wrap">
                    {live.status && (
                      <div className="ligne-statut">
                        <span className="pastille" aria-hidden />
                        {live.status}
                      </div>
                    )}
                    <div className="bubble">
                      {live.content ? (
                        <>
                          <MarkdownContent content={live.content} />
                          <span className="g3-caret" aria-hidden />
                        </>
                      ) : (
                        <div className="frappe" aria-label="Gen3ia réfléchit">
                          <span className="dot" />
                          <span className="dot" />
                          <span className="dot" />
                        </div>
                      )}
                      {live.imageUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element -- URL du CDN d'images générées, domaine non fixe */
                        <img src={live.imageUrl} alt="Image générée par Gen3ia" className="max-h-96 w-auto max-w-full rounded-xl object-contain" loading="lazy" />
                      )}
                    </div>
                  </div>
                </div>
              )}

              {erreur && (
                <CarteSysteme ico="⚠️" erreur>
                  {erreur}
                </CarteSysteme>
              )}

              {suggestionsSuivi.length > 0 && (
                <div className="suggestions">
                  {suggestionsSuivi.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      className="chip-sugg"
                      onClick={() => void envoyer(suggestion)}
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <button
          type="button"
          className={`btn-bas${procheBas ? "" : " visible"}`}
          onClick={() => descendre(true)}
          aria-label="Aller au dernier message"
        >
          {Icones.bas}
        </button>

        {/* ── Composer ── */}
        <footer className="composer">
          <div className="composer-inner">
            <div
              className={`composer-box${dragActif ? " drop" : ""}`}
              onDragOver={(event) => {
                if (Array.from(event.dataTransfer.types).includes("Files")) {
                  event.preventDefault();
                  setDragActif(true);
                }
              }}
              onDragLeave={() => setDragActif(false)}
              onDragEnd={() => setDragActif(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragActif(false);
                ajouterFichiers(event.dataTransfer.files);
              }}
            >
              <div className="pieces">
                {uploading && (
                  <div className="piece" style={{ opacity: 0.75 }} aria-live="polite">
                    <div className="piece-vignette" aria-hidden>
                      ⏳
                    </div>
                    <div className="piece-info">
                      <div className="piece-nom">Import en cours…</div>
                      <div className="piece-taille">vers ton stockage Gen3ia</div>
                    </div>
                  </div>
                )}
                {pieces.map((piece, index) => (
                  <div className="piece" key={`${piece.nom}-${piece.taille}-${index}`}>
                    <div className="piece-vignette">
                      {piece.apercu ? (
                        /* eslint-disable-next-line @next/next/no-img-element -- aperçu local blob, pas un asset Next */
                        <img src={piece.apercu} alt="" />
                      ) : (
                        iconePourNom(piece.nom)
                      )}
                    </div>
                    <div className="piece-info">
                      <div className="piece-nom">{piece.nom}</div>
                      <div className="piece-taille">{formaterTaille(piece.taille)}</div>
                    </div>
                    <button
                      type="button"
                      className="piece-retirer"
                      aria-label="Retirer le fichier"
                      onClick={() => retirerPiece(index)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>

              <div className="outils-actifs">
                {connecteurs.map((slug) => {
                  const connexion = connexionsActives.find((item) => item.toolkit === slug);
                  return (
                    <span className="outil-chip" key={slug}>
                      {connexion?.label ?? slug}
                      <button type="button" aria-label="Désactiver" onClick={() => basculerConnecteur(slug)}>
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>

              {/* Chat voix : lecture vocale de la réponse (tours dictés uniquement). */}
              {lectureVocale && (
                <div className="lecture-vocale">
                  <span className="point-lecture" aria-hidden />
                  <span>Lecture vocale en cours…</span>
                  <button
                    type="button"
                    onClick={() => {
                      cancelSpeech();
                      setLectureVocale(false);
                    }}
                  >
                    Couper
                  </button>
                </div>
              )}

              <textarea
                ref={saisieRef}
                className="saisie"
                rows={1}
                value={saisie}
                placeholder={
                  saisieVocale.etat === "ecoute"
                    ? saisieVocale.texteInterim
                      ? `Écoute en cours… « ${saisieVocale.texteInterim} »`
                      : "Écoute en cours… parlez maintenant"
                    : "Écris ton message… (↑ pour rappeler le dernier message)"
                }
                aria-label="Message"
                onChange={(event) => {
                  setSaisie(event.target.value);
                  setIndexSaisie(-1);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void envoyer();
                  } else if (event.key === "ArrowUp" && !saisie.trim()) {
                    if (naviguerHistorique(1)) event.preventDefault();
                  } else if (event.key === "ArrowDown" && indexSaisie >= 0) {
                    if (naviguerHistorique(-1)) event.preventDefault();
                  }
                }}
                onPaste={(event) => {
                  const fichiers = Array.from(event.clipboardData?.files ?? []);
                  if (fichiers.length > 0) {
                    event.preventDefault();
                    ajouterFichiers(fichiers);
                  }
                }}
              />

              <div className="barre">
                <div className="barre-gauche">
                  <button
                    type="button"
                    className="btn-icon"
                    onClick={() => inputFichierRef.current?.click()}
                    aria-label="Joindre un fichier"
                    title="Joindre un fichier"
                  >
                    {Icones.trombone}
                  </button>
                  <input
                    ref={inputFichierRef}
                    type="file"
                    hidden
                    multiple
                    accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.json,.png,.jpg,.jpeg,.webp"
                    onChange={(event) => {
                      ajouterFichiers(event.target.files ?? []);
                      event.target.value = "";
                    }}
                  />

                  {/* Popover « Outils » : applications externes connectées (Composio). */}
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="pill"
                      aria-haspopup="menu"
                      aria-expanded={popOutils}
                      onClick={() => {
                        setPopOutils((ouvert) => !ouvert);
                        setPopModele(false);
                      }}
                      title="Applications pour ce message"
                    >
                      {Icones.outils}
                      <span className="txt-long">Outils</span>
                      {connecteurs.length > 0 && <span className="tag">{connecteurs.length}</span>}
                    </button>
                    <div className={`popover${popOutils ? " open" : ""}`} role="menu" aria-label="Applications pour ce message">
                      <div className="pop-titre">Applications</div>
                      {chargementConnexions && <div className="pop-vide">Chargement de vos connexions…</div>}
                      {!chargementConnexions && connexionsActives.length === 0 && (
                        <div className="pop-vide">
                          Aucune application connectée. Connecte un service pour que l&apos;agent agisse dessus :
                          <div className="pop-connexion">
                            {suggestionsConnexion.map((toolkit) => (
                              <button
                                key={toolkit}
                                type="button"
                                onClick={() => void connecterService(toolkit)}
                                disabled={enConnexion !== null}
                                title={`Connecter ${toolkit} — redirection vers la page d'autorisation`}
                              >
                                {enConnexion === toolkit ? "…" : `+ ${toolkit}`}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {connexionsActives.map((connexion) => {
                        const actif = connecteurs.includes(connexion.toolkit);
                        return (
                          <button
                            key={connexion.id}
                            type="button"
                            className={`pop-item${actif ? " selected" : ""}`}
                            role="menuitemcheckbox"
                            aria-checked={actif}
                            onClick={() => basculerConnecteur(connexion.toolkit)}
                          >
                            <span className="ico" aria-hidden>
                              ⧉
                            </span>
                            <span className="txt">
                              {connexion.label}
                              <span className="sub">{connexion.toolkit}</span>
                            </span>
                            <span className="coche" aria-hidden />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                <div className="barre-droite">
                  {saisie.length >= SEUIL_COMPTEUR && (
                    <span className={`compteur${tropLong ? " alerte" : ""}`}>
                      {saisie.length}/{MAX_CARACTERES}
                    </span>
                  )}

                  {/* Popover modèle : moteurs réels du routeur Gen3ia. */}
                  <div style={{ position: "relative" }}>
                    <button
                      type="button"
                      className="pill pill-modele"
                      aria-haspopup="menu"
                      aria-expanded={popModele}
                      onClick={() => {
                        setPopModele((ouvert) => !ouvert);
                        setPopOutils(false);
                      }}
                      title="Moteur IA de ce tour"
                    >
                      <span>{choixModele?.label ?? "Automatique"}</span>
                      {Icones.chevron}
                    </button>
                    <div className={`popover right${popModele ? " open" : ""}`} role="menu" aria-label="Modèle" style={{ minWidth: 280 }}>
                      <div className="pop-titre">Modèle</div>
                      {COMPOSER_MODEL_OPTIONS.map((option, index) => {
                        const actif = modelId === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={`pop-item modele-item${actif ? " selected" : ""}`}
                            role="menuitemradio"
                            aria-checked={actif}
                            onClick={() => {
                              setModelId(option.id);
                              setPopModele(false);
                            }}
                          >
                            <span className="ico" aria-hidden>
                              {["⚡", "🎯", "🧠", "✍️", "🚀"][index] ?? "⭐"}
                            </span>
                            <span className="txt">
                              {option.label}
                              <span className="sub">{option.description}</span>
                            </span>
                            <span className="coche" aria-hidden />
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Chat voix : envoi vide + clic = dictée (transcript envoyé
                      automatiquement) ; re-clic pendant l'écoute = annulation. */}
                  <button
                    type="button"
                    className={`btn-envoi${generating ? " stop" : ""}${saisieVocale.etat === "ecoute" ? " voix-active" : ""}`}
                    onClick={() => {
                      if (generating) {
                        arreter();
                        return;
                      }
                      if (saisieVocale.etat === "ecoute") {
                        saisieVocale.annuler();
                        return;
                      }
                      if (envoiVide) {
                        saisieVocale.demarrer();
                        return;
                      }
                      void envoyer();
                    }}
                    disabled={generating ? false : tropLong || (envoiVide && !saisieVocale.supported)}
                    aria-label={
                      generating
                        ? "Arrêter la génération"
                        : saisieVocale.etat === "ecoute"
                          ? "Annuler l'écoute vocale"
                          : envoiVide
                            ? saisieVocale.supported
                              ? "Chat voix — dicter votre message"
                              : "Reconnaissance vocale non supportée par ce navigateur"
                            : "Envoyer"
                    }
                    title={
                      generating
                        ? "Arrêter"
                        : saisieVocale.etat === "ecoute"
                          ? "Annuler l'écoute vocale"
                          : envoiVide
                            ? saisieVocale.supported
                              ? "Chat voix — dictez votre message (re-clic pour annuler)"
                              : "Reconnaissance vocale non supportée par ce navigateur"
                            : "Envoyer (Entrée)"
                    }
                  >
                    {generating ? (
                      Icones.stop
                    ) : saisieVocale.etat === "ecoute" ? (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="9" y="2" width="6" height="12" rx="3" />
                        <path d="M5 10a7 7 0 0 0 14 0M12 19v3" />
                      </svg>
                    ) : (
                      Icones.envoi
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="pied">
            Entrée pour envoyer · Maj + Entrée pour aller à la ligne · Gen3ia peut faire des erreurs, vérifie les infos
            importantes.
          </div>
        </footer>
      </div>

      <div className={`toast${toastVisible ? " visible" : ""}`} role="status">
        {toastTexte}
      </div>
    </div>
  );
}

/* ───────────────── Sous-composants locaux ───────────────── */

/** Bascule de thème du chat : même contrat que ThemeToggle (localStorage
 * « gen3ia-theme » + data-theme sur <html>) + persistance serveur
 * fire-and-forget (contrat lot 108-b : PUT /api/auth/profile { theme }). */
function BoutonTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [monte, setMonte] = useState(false);

  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    setMonte(true);
  }, []);

  const basculer = useCallback(() => {
    const prochain: "dark" | "light" = theme === "dark" ? "light" : "dark";
    setTheme(prochain);
    document.documentElement.setAttribute("data-theme", prochain);
    try {
      localStorage.setItem("gen3ia-theme", prochain);
    } catch {
      /* stockage indisponible : le thème reste appliqué pour la session */
    }
    void fetch("/api/auth/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: prochain }),
      credentials: "same-origin",
    }).catch(() => undefined);
  }, [theme]);

  const libelle = theme === "dark" ? "Passer en thème clair" : "Passer en thème sombre";

  return (
    <button type="button" className="btn-icon" onClick={basculer} aria-label={libelle} title={libelle}>
      {monte && theme === "light" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      )}
    </button>
  );
}

/** Une ligne du fil : avatar, pièces jointes, bulle (markdown côté Gen3ia),
 * métadonnées et actions (copier, régénérer, modifier). */
function BulleMessage({
  message,
  dernierBot,
  dernierUser,
  initiale,
  occupe,
  onCopier,
  onRegenerer,
  onModifier,
}: {
  message: ConversationMessage;
  dernierBot: boolean;
  dernierUser: boolean;
  initiale: string;
  occupe: boolean;
  onCopier: (texte: string, message?: string) => void;
  onRegenerer: () => void;
  onModifier: () => void;
}) {
  const bot = message.role === "assistant";
  return (
    <div className={`msg ${bot ? "bot" : "user"}`}>
      <div className="msg-avatar" aria-hidden>
        {bot ? "🤖" : initiale}
      </div>
      <div className="bubble-wrap">
        {message.attachments && message.attachments.length > 0 && (
          <div className="msg-files">
            {message.attachments.map((piece, index) => (
              <span className="msg-file" key={`${piece.filename}-${index}`}>
                {iconePourNom(piece.filename)} {piece.filename}
              </span>
            ))}
          </div>
        )}
        <div className="bubble">
          {bot ? (
            <>
              <MarkdownContent content={message.content || ""} />
              {message.imageUrl && (
                /* eslint-disable-next-line @next/next/no-img-element -- URL du CDN d'images générées, domaine non fixe */
                <img
                  src={message.imageUrl}
                  alt="Image générée par Gen3ia"
                  className="mt-2 max-h-96 w-auto max-w-full rounded-xl object-contain"
                  loading="lazy"
                />
              )}
            </>
          ) : (
            message.content || ""
          )}
        </div>
        <div className="msg-meta">
          {bot ? (
            <>
              {message.model && <span className="modele">{message.model}</span>}
              <span className="heure">{heureFr(message.createdAt)}</span>
              <button type="button" className="act" aria-label="Copier la réponse" onClick={() => onCopier(message.content)}>
                {Icones.copie} Copier
              </button>
              {dernierBot && !occupe && (
                <button type="button" className="act" aria-label="Régénérer la réponse" onClick={onRegenerer}>
                  {Icones.regen} Régénérer
                </button>
              )}
            </>
          ) : (
            <>
              <span className="heure">{heureFr(message.createdAt)}</span>
              <button type="button" className="act" aria-label="Copier le message" onClick={() => onCopier(message.content)}>
                {Icones.copie} Copier
              </button>
              {dernierUser && !occupe && (
                <button type="button" className="act" aria-label="Modifier le message" onClick={onModifier}>
                  {Icones.edit} Modifier
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
