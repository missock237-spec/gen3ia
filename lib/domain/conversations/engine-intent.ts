import "server-only";

/**
 * Détection d'intention : schémas Zod, intentions d'outils explicites (email, document, API, recherche) et prompt système d'intention. Extrait de engine.ts — code déplacé tel quel.
 */

import { isDraftEmailRequest } from "./service-intents";
import type { ComplexityAssessment } from "@/lib/ai/auto-improvement";
import { languageDirective } from "@/lib/ai/prompt-enhancer";
import { generate } from "@/lib/ai/router";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";
import { extractApiUsageName, looksLikeApiUsageRequest } from "@/lib/integrations/custom-apis/detect";
import type { CustomApiRecord } from "@/lib/integrations/custom-apis/repository";
import { z } from "zod";
import type { ToolCatalogEntry } from "./engine-tools";

/* ------------------------------------------------------------------ */
/* Décision d'intention : chat direct ou plan d'exécution              */
/* ------------------------------------------------------------------ */

const IntentStepSchema = z.object({
  title: z.string().min(1).max(200),
  detail: z.string().max(1500).optional(),
  toolName: z.string().trim().max(80).optional(),
  toolInput: z.record(z.string(), z.unknown()).optional(),
  sensitive: z.boolean().optional(),
});

export const IntentSchema = z.object({
  mode: z.enum(["chat", "plan"]),
  understanding: z.string().max(1200).describe("Compréhension de la demande en une phrase"),
  reply: z.string().max(18000).optional().describe("Réponse directe si mode=chat"),
  objective: z.string().max(1000).optional().describe("Objectif du plan si mode=plan"),
  steps: z.array(IntentStepSchema).max(8).optional(),
  /** Canal de clarification (Task 135 — compréhension EXACTE) : vrai si
   *  la compréhension n'est pas certaine (ambiguïté réelle, référent
   *  implicite non résolvable, action coûteuse sur une interprétation
   *  hasardeuse) — alors poser UNE question précise pour se rassurer. */
  needsClarification: z.boolean().optional(),
  clarifyingQuestion: z.string().max(600).optional().describe("Une seule question de clarification, si needsClarification"),
  /** Confiance dans la compréhension de la demande (0.0..1.0). */
  confidence: z.number().min(0).max(1).optional(),
  /** Options de réponse rapides proposées à l'utilisateur (max 3). */
  suggestions: z.array(z.string().max(60)).max(3).optional(),
});

export type TurnIntent = z.infer<typeof IntentSchema>;

export type ExplicitToolIntent =
  | { toolName: "web.search"; query: string }
  | { toolName: "custom_api.call"; query: string }
  | { toolName: "web.api"; url: string }
  | { toolName: "web.api.write"; url: string; method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: string }
  | { toolName: "artifact.create"; document: { title: string; format: "pdf" | "docx" | "xlsx" | "pptx" | "md" } }
  | { toolName: "email.send"; to: string; subject: string; text: string };

const EMAIL_ADDRESS_RE = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/;

/**
 * Extrait le sujet énoncé (« avec le sujet « … » », « sujet : … ») ou un repli honnête.
 */
export function extractEmailSubject(message: string): string {
  const quoted = message.match(/(?:sujet|subject|objet)\s*[:：]?\s*[«“"']([^»”"']{1,160})[»”"']/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const plain = message.match(/(?:sujet|subject|objet)\s*[:：]\s*([^«»“”"'\n]{3,160})/i);
  if (plain?.[1]?.trim()) return plain[1].trim();
  return "[Gen3ia] Message de votre agent";
}

/**
 * Extrait le corps énoncé (« et le texte « … » », « message : … ») ou repli sur la demande elle-même.
 */
export function extractEmailText(message: string): string {
  const quoted = message.match(/(?:texte|message|contenu|corps|dis que|dis-lui que)\s*[:：]?\s*[«“"]([^»”"]{1,2000})[»”"]?/i);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  return message.replace(EMAIL_ADDRESS_RE, "").replace(/\s{2,}/g, " ").trim().slice(0, 1000) || message.slice(0, 1000);
}

/**
 * Garde-fou déterministe : certaines demandes énoncent EXPLICITEMENT le
 * résultat attendu (recherche web réelle, document téléchargeable). Si l'IA
 * classe malgré tout la demande en simple réponse (ou si sa décision est
 * indisponible), cette heuristique force un plan avec l'outil réel — la
 * demande de l'utilisateur est loi.
 *
 * Audits 25-a/25-d : « Recherche les dernières tendances… » produisait une
 * réponse SANS sources (hallucination possible) et « Crée un PDF… » ne
 * générait jamais de livrable — ces deux familles sont désormais routées.
 */
export function detectExplicitToolIntent(message: string, catalog: ToolCatalogEntry[], customApis: CustomApiRecord[] = []): ExplicitToolIntent | null {
  const lower = message.toLowerCase();
  const catalogNames = new Set(catalog.map((t) => t.name));

  // 1) Recherche web explicite (« fais une recherche web », « search the web »).
  const webMarkers = /(recherche[s]? (web|internet)|cherche[rz]? (sur )?(le |la )?(web|internet)|fais[ez]? une recherche|search (the )?web|web search|sur (le|internet))\b/i;
  if (webMarkers.test(lower) && catalogNames.has("web.search")) {
    return { toolName: "web.search", query: extractSearchQuery(message) };
  }

  // 1 bis) Demande explicite d'UTILISATION d'une API personnelle connue :
  // l'appel réel est la demande de l'utilisateur, jamais un simple « chat ».
  if (
    customApis.length > 0 &&
    catalogNames.has("custom_api.call") &&
    looksLikeApiUsageRequest(message)
  ) {
    const wanted = extractApiUsageName(message);
    const api = wanted
      ? customApis.find((candidate) => candidate.name.toLowerCase().includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(candidate.name.toLowerCase()))
      : customApis.length === 1
        ? customApis[0]
        : undefined;
    if (api) return { toolName: "custom_api.call", query: message.slice(0, 400) };
  }

  // 1 ter) Appel d'API DIRECT par URL : l'utilisateur désigne l'URL d'une API
  // (avec un verbe d'appel, le mot « API » ou une hôte api.*) — l'agent
  // appelle RÉELLEMENT cette API, sans connecteur préalable.
  const directUrl = extractApiUrlFromMessage(message);
  if (directUrl && catalogNames.has("web.api") && looksLikeDirectApiCall(message, directUrl)) {
    // Garde déterministe ÉCRITURE : un verbe/méthode d'écriture (POST, PUT,
    // PATCH, DELETE, création, modification) route vers web.api.write —
    // JAMAIS web.api (lecture seule) pour une écriture.
    const writeIntent = detectApiWriteIntent(message);
    if (writeIntent && catalogNames.has("web.api.write")) {
      return { toolName: "web.api.write", url: directUrl, method: writeIntent.method, ...(writeIntent.body ? { body: writeIntent.body } : {}) };
    }
    return { toolName: "web.api", url: directUrl };
  }

  // 2 bis) Envoi d'email EXPLICITE : verbe d'envoi + mot email + adresse
  // destinataire réellement énoncée. L'envoi réel (Resend) est la demande de
  // l'utilisateur — jamais une réponse « je ne peux pas envoyer d'emails ».
  // Attention : rédiger/brouiller un email (sans envoi ni adresse) ne déclenche PAS le garde.
  const emailSendVerb = /\b(envoi[ez]|envoie|envoyer|exp[ée]di\w*|transmets?|transmets|send)\b/i;
  const emailWord = /\b(e-?mails?|courriels?)\b/i;
  // Garde « brouillon » : rédiger/préparer un email n'est PAS un envoi réel —
  // la demande reste conversationnelle (audit compréhension : « envoie-moi un
  // brouillon d'email… » ne doit jamais partir chez Resend).
  if (catalogNames.has("email.send") && emailSendVerb.test(lower) && emailWord.test(lower) && !isDraftEmailRequest(message)) {
    const address = message.match(EMAIL_ADDRESS_RE)?.[0];
    if (address) {
      return {
        toolName: "email.send",
        to: address,
        subject: extractEmailSubject(message),
        text: extractEmailText(message),
      };
    }
  }

  // 2) Recherche d'information ACTUELLE : verbe d'action + sujet qui exige des
  //    données à jour (tendances, actualités, prix, marché…) — une réponse de
  //    mémoire serait une fabrication sans sources.
  const researchVerb = /\b(recherch\w*|cherch\w*|trouv\w*|renseign\w*|surveill\w*|compar\w*|informe[rz]?)\b/i;
  const currentInfoSubject = /\b(tendances?|actualit[ée]s?|nouveaut[ée]s?|news|derni[èe]res? (informations|nouvelles|tendances|versions?|donn[ée]es)|march[ée]|concurrents?|concurrence|prix|tarifs?|m[ée]t[ée]o|r[ée]glementation)\b/i;
  if (researchVerb.test(lower) && currentInfoSubject.test(lower) && catalogNames.has("web.search")) {
    return { toolName: "web.search", query: extractSearchQuery(message) };
  }

  // 3) Livrable document explicite (« prépare un rapport », « crée un PDF ») :
  //    force un plan avec artifact.create — le moteur complète les blocs de
  //    contenu à l'exécution (voir ensureArtifactInput).
  const documentVerb = /\b(fais|pr[ée]par\w*|cr[ée]\w*|g[ée]n[èe]r\w*|r[ée]dig\w*|construis|produis|transforme|exporte)\b/i;
  const documentObject = /\b(rapport|comptes? rendus?|note de synth[èe]se|pr[ée]sentation|diaporama|slides?|documents?|pdf|docx|word|excel|xlsx|powerpoint|pptx|tableau de bord)\b/i;
  if (documentVerb.test(lower) && documentObject.test(lower) && catalogNames.has("artifact.create")) {
    return {
      toolName: "artifact.create",
      document: { title: extractDocumentTitle(message), format: extractDocumentFormat(message) },
    };
  }

  const imageMarkers = /\b(g[eé]n[eè]re|cr[eé]e|dessine)\b.*\b(image|illustration|dessin|visuel)\b|\b(image|illustration)\b.*\b(g[eé]n[eè]r)\b/i;
  if (imageMarkers.test(lower) && catalogNames.has("artifact.create")) {
    // Les images sont traitées en amont par Agnes ; ici on ne force rien.
    return null;
  }
  return null;
}

/** Titre court d'un livrable dérivé de la demande (nettoyage des formules). */
export function extractDocumentTitle(message: string): string {
  const cleaned = message
    .replace(/^(fais[ez]?|peux[- ]tu|pourrais[- ]tu|merci de|stp|s'il (te|vous) pla[eî]t)\s+/i, "")
    .replace(/^(sur |about )+/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  return (cleaned || message.trim()).slice(0, 80);
}

/** Format de document demandé — déduction prudente, PDF par défaut. */
export function extractDocumentFormat(message: string): "pdf" | "docx" | "xlsx" | "pptx" | "md" {
  const lower = message.toLowerCase();
  if (/\b(pr[ée]sentation|diaporama|slides?|powerpoint|pptx)\b/i.test(lower)) return "pptx";
  if (/\b(excel|xlsx|tableau de bord|feuille de calcul)\b/i.test(lower)) return "xlsx";
  if (/\b(word|docx)\b/i.test(lower)) return "docx";
  if (/\b(markdown|\.md)\b/i.test(lower)) return "md";
  return "pdf";
}

/**
 * Extrait la première URL http(s) énoncée (ponctuation finale exclue).
 * Utilisée par le garde d'appel d'API directe par URL (web.api).
 */
export function extractApiUrlFromMessage(message: string): string | null {
  const match = message.match(/https?:\/\/[^\s<>"'»“”')\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?]+$/, "");
}

/**
 * L'appel d'API direct est-il explicitement demandé ? L'utilisateur désigne
 * une URL d'API avec un verbe d'appel, le mot « API », ou une hôte de type
 * api.*. Un simple lien collé sans intention d'appel ne déclenche PAS l'outil.
 */
export function looksLikeDirectApiCall(message: string, url: string): boolean {
  const callVerb = /\b(appell\w*|interrog\w*|consult\w*|requ[eê]t\w*|call|request|fetch|r[ée]cup[ée]r\w*|utilise|tester?|essaie)\b/i;
  const apiWord = /\bapi\b/i;
  const apiHost = /(^|\/\/|\.)api\./i.test(url);
  return apiWord.test(message) || apiHost || callVerb.test(message);
}

/**
 * Détecte une ÉCRITURE API énoncée : méthode explicite (POST/PUT/PATCH/
 * DELETE) ou verbe de modification. Retourne la méthode et, si présente,
 * le corps JSON énoncé (extrait tel quel — jamais inventé).
 */
export function detectApiWriteIntent(message: string): { method: "POST" | "PUT" | "PATCH" | "DELETE"; body?: string } | null {
  const methodMatch = message.match(/\b(POST|PUT|PATCH|DELETE)\b/i);
  const writeVerb = /\b(cr[ée]er?|cr[ée]ez|cr[ée]e\s|ajout\w*|envoi\w*|publi\w*|modifi\w*|supprim\w*|mets?\s+à\s+jour|met[s]?\s+à\s+jour|mise\s+à\s+jour|create|send|update|delete)\b/i;
  const jsonMatch = message.match(/(\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\})/);
  if (!methodMatch) {
    // Verbe d'écriture + corps JSON explicite + URL : écriture probable (POST par défaut).
    if (writeVerb.test(message) && jsonMatch) return { method: "POST", body: jsonMatch[1] };
    return null;
  }
  const method = methodMatch[1].toUpperCase() as "POST" | "PUT" | "PATCH" | "DELETE";
  return { method, ...(jsonMatch ? { body: jsonMatch[1] } : {}) };
}

/** Requête condensée pour l'outil de recherche (nettoyage des formules). */
export function extractSearchQuery(message: string): string {
  const cleaned = message
    .replace(/^(fais[ez]?|peux[- ]tu|pourrais[- ]tu|merci de|stp|s'il te pla[eî]t)\s+/i, "")
    .replace(/(une |la |de )?(recherche[s]? (web|internet|sur internet)|search)\s*(sur|about|for)?\s*/i, "")
    .replace(/^(sur |about )+/i, "")
    .replace(/\s+et r[eé]sume[- ].*$/i, "")
    // Séparateurs résiduels après suppression de la formule (" : ", " - "…).
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .slice(0, 300);
  return cleaned || message.replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 300) || message.slice(0, 300);
}

export interface IntentPromptMeta {
  /** Contexte d'auto-amélioration (leçons + progression réelle). */
  evolutionContext?: string;
  /** Historique réel des runs de la conversation. */
  runHistoryContext?: string;
  /** Évaluation de complexité de la demande. */
  complexity?: ComplexityAssessment;
  /** Directive de langue calculée depuis le dernier message utilisateur. */
  languageDirective?: string;
}

export function buildIntentSystemPrompt(
  catalog: ToolCatalogEntry[],
  project?: WorkspaceProject | null,
  connectors?: string[],
  customApis?: CustomApiRecord[],
  meta?: IntentPromptMeta,
  /** Task 143 — axe 4 : note des serveurs MCP actifs (outils + arguments). */
  mcpNote?: string,
): string {
  const toolLines = catalog
    .map((t) => `- ${t.name} (risque ${t.risk}${t.requiresApproval ? ", validation requise" : ""}) : ${t.description}`)
    .join("\n");
  const catalogNames = new Set(catalog.map((t) => t.name));
  const connectorSection = connectors && connectors.length > 0
    ? [
        "",
        `Connecteurs activés explicitement par l'utilisateur pour CETTE demande : ${connectors.join(", ")}.`,
        "Si la demande concerne ces services, utilise l'outil composio.execute avec input { toolkit: \"<slug>\", action: \"<action>\", params: { … } }.",
        "Les actions externes (envoi, publication, modification) sont sensibles : décris leur impact précisément, la validation humaine sera demandée.",
      ].join("\n")
    : "";
  const customApiSection = customApis && customApis.length > 0
    ? [
        "",
        "API personnelles de l'utilisateur (RÉELLES, appelées par le serveur via custom_api.call / custom_api.write) :",
        ...customApis.map((api) => {
          const selected = connectors?.some((slug) => slug === `api-${api.id}`);
          return `- « ${api.name} » — base : ${api.baseUrl}${api.description ? ` — ${api.description.slice(0, 200)}` : ""}${selected ? " [ACTIVÉE pour ce message]" : ""} ; auth : ${api.authType}`;
        }),
        "Pour interroger une de ces API : étape avec toolName=\"custom_api.call\" et toolInput { apiName: \"<nom exact>\", path: \"/chemin\", query?: {…} } — l'appel HTTP réel est exécuté par le serveur et le résultat réel te sera renvoyé.",
        "Pour modifier des données via ces API : toolName=\"custom_api.write\" (POST/PUT/PATCH/DELETE, validation humaine requise).",
        "Utilise ces API uniquement si la demande s'y prête ; ne devine jamais un chemin : si le chemin est inconnu, commence par un appel GET sur la racine ou un chemin probable, et restitue le résultat réel.",
      ].join("\n")
    : "";
  const sousServicesSection = [
    "",
    "SOUS-SERVICES DU PROJET (tous pilotables en langage naturel par l'utilisateur) :",
    "- Tâches planifiées : schedule.create (récurrence hebdomadaire/webhook/veille), schedule.list, schedule.update (activer/désactiver/modifier), schedule.delete (validation requise).",
    "- Workflows : workflow.create (graphe multi-étapes réel), workflow.list, workflow.run (exécution réelle), workflow.delete (validation requise).",
    "Si l'utilisateur demande de planifier/automatiser une tâche récurrente : mode=plan avec UN step toolName=\"schedule.create\" et toolInput { objective: \"<exactement ce que l'agent fera>\", daysOfWeek: [1] (0=dimanche…6=samedi déduits de la demande), startTime: \"09:00\", endTime: \"23:59\", name? } — reprends UNIQUEMENT ce qui est énoncé.",
    "Si l'utilisateur décrit un enchaînement d'automatisation : mode=plan avec UN step toolName=\"workflow.create\" et toolInput { name, steps: [{ name, description }] (les étapes EXACTES énoncées), runNow?: true seulement s'il demande l'exécution immédiate }.",
    "Si l'utilisateur veut consulter/piloter ses tâches planifiées ou workflows existants : schedule.list / schedule.update (enable: true|false) / workflow.list / workflow.run.",
  ].join("\n");
  const artefactsSection = [
    "",
    "ARTEFACTS GEN3IA (natifs, gérés par le moteur avant toi) :",
    "- APPLICATIONS WEB : toute demande de création d'une page web, d'un site, d'une interface ou d'une petite application (« crée une page web de liste de tâches en mode sombre, écrite en React ») est générée AUTOMATIQUEMENT par le moteur : artefact exécutable + lien d'aperçu en direct dans la réponse. Si la demande lui a déjà été transmise, réponds mode=chat avec un reply court.",
    "- ANALYSE DE DONNÉES : « génère un graphique / analyse ces données » est pris en charge automatiquement (graphique réel à partir des fichiers importés ou des valeurs énoncées, export PNG/JPG, conclusions). Demande un fichier ou des valeurs si l'utilisateur n'en fournit pas — n'invente JAMAIS de données.",
    "- RÉDACTION / DOCUMENTS : rapports et textes longs → artifact.create avec format pdf ou docx (export direct prêt à diffuser).",
    "- AI SLIDES : « crée une présentation / un PowerPoint » → artifact.create avec format pptx (modèles professionnels appliqués automatiquement).",
  ].join("\n");
  const emailSection = catalogNames.has("email.send")
    ? [
        "",
        "EMAIL — l'envoi d'emails réels est DISPONIBLE via l'outil email.send (service Resend configuré côté serveur) :",
        "Si l'utilisateur demande d'envoyer/expédier un email (relance, notification, rapport, message à une adresse) : mode=plan avec UN step toolName=\"email.send\" et toolInput { to: \"<adresse exacte énoncée>\", subject: \"<sujet énoncé ou fidèle à la demande>\", text: \"<contenu énoncé ou reformulé fidèlement>\" }.",
        "Ne réponds JAMAIS que tu ne peux pas envoyer d'emails : tu le peux, l'envoi est exécuté par le serveur. N'invente jamais une adresse : utilise uniquement celle que l'utilisateur a énoncée.",
      ].join("\n")
    : "";
  const directApiSection = catalogNames.has("web.api")
    ? [
        "",
        "API DIRECTES PAR URL (sans connecteur préalable) :",
        "Si l'utilisateur désigne l'URL d'une API (ou colle une URL d'API) et demande de l'appeler, l'interroger ou l'utiliser : étape toolName=\"web.api\" avec toolInput { url: \"<URL exacte énoncée>\" } — l'appel HTTP réel est exécuté par le serveur et le résultat réel te sera renvoyé.",
        "Pour modifier des données via une URL d'API (POST/PUT/PATCH/DELETE, création, envoi, mise à jour) : toolName=\"web.api.write\" avec toolInput { url, method, body? } — JAMAIS web.api pour une écriture (web.api est en lecture seule GET). Validation humaine requise UNIQUEMENT si l'app cible n'est pas déjà connectée ; app connectée = exécution directe.",
        "N'invente JAMAIS une URL ni une clé : utilise uniquement ce que l'utilisateur a énoncé.",
      ].join("\n")
    : "";
  const mediaSection = [
    "",
    "RÈGLE IMPÉRATIVE — VISUELS : toute demande de CRÉATION d'image, photo, illustration, dessin, logo, affiche, poster, bannière, avatar, icône, fond d'écran ou miniature est routée en mode=plan avec UN SEUL step :",
    '  { title: "Génération de l\'image", toolName: "image.generate", toolInput: { prompt: "<description visuelle fidèle de CE QUE L\'UTILISATEUR a demandé — le sujet exact, sans rien ajouter ni inventer>" } }.',
    "Cela vaut quel que soit la formulation (« dessine-moi un chat », « je veux une photo de… », « un logo pour ma boulangerie », « fais-moi une image de… »). Ne réponds JAMAIS une demande de visuel par du texte seul.",
    catalogNames.has("video.create")
      ? [
          "",
          "RÈGLE IMPÉRATIVE — VIDÉO : toute demande de CRÉATION/PRODUCTION d'une vidéo, clip, reel, short, trailer, bande-annonce ou montage vidéo est routée en mode=plan avec UN SEUL step :",
          '  { title: "Production vidéo", toolName: "video.create", toolInput: { prompt: "<la demande EXACTE de l\'utilisateur : sujet, ton, message — fidèle, sans rien inventer>", title?: "<titre court>", aspectRatio?: "16:9" | "9:16" | "1:1" | "4:5" | "21:9", targetDurationSec?: <durée en secondes si l\'utilisateur la précise>, resolution?: "480p" | "720p" | "1080p" | "1440p" | "4K", language?: "<langue>", style?: "<style visuel/narratif>", audience?: "<public cible>", platform?: "<plateforme>", musicMood?: "cinematographique" | "documentaire" | "tension" | "energique" | "emotionnel" | "neutre", subtitlesEnabled?: boolean (sous-titres demandés/refusés), subtitleStyle?: "documentary" | "minimal" | "shorts_bold" | "cinematic_yellow" | "karaoke_pop", subtitlePosition?: "bottom" | "center" | "top", effectPreset?: "none" | "subtle" | "dynamic" | "cinematic" | "capcut", derivedTargets?: ["shorts_9_16" | "tiktok_9_16" | "reels_9_16" | "youtube_16_9" | "square_1_1" | "facebook_16_9"] } }.',
          "TRANSMETS FIDÈLEMENT les paramètres exprimés par l'utilisateur (durée « 2 minutes » → targetDurationSec: 120, « format TikTok » → aspectRatio 9:16 + derivedTargets [tiktok_9_16], « en 4K », « musique énergique », « pour les adolescents »…) — n'invente JAMAIS un paramètre absent de la demande. Les bornes du pipeline (durée minimale 10 s) sont appliquées automatiquement : transmets la durée demandée telle quelle.",
          "EFFETS D'ANIMATION ET SOUS-TITRES (règle impérative) : si l'utilisateur demande des effets d'animation ou des sous-titres, transmets-les TOUJOURS — « avec sous-titres karaoké » → subtitlesEnabled: true + subtitleStyle 'karaoke_pop' ; « sous-titres jaunes » → 'cinematic_yellow' ; « sans sous-titres » → subtitlesEnabled: false ; « effets dynamiques » → effectPreset 'dynamic' ; « style cinématique » → 'cinematic' ; « comme CapCut » → 'capcut' ; « sans effets » → 'none'. La détection déterministe du serveur rattrape les oublis, mais transmets fidèlement dès le plan.",
          "La production complète (scénario, visuels, voix, musique, montage, rendu) est enchaînée AUTOMATIQUEMENT par la plateforme, avec progression en temps réel affichée dans la conversation. Ne réponds JAMAIS une demande de vidéo par du texte seul, et ne demande JAMAIS de passer par l'atelier vidéo : tu lances la production toi-même.",
        ].join("\n")
      : "",
    catalogNames.has("voice.speak")
      ? [
          "",
          "RÈGLE IMPÉRATIVE — AUDIO / VOIX-OFF (la plateforme SYNTHÉTISE l'audio — ne réponds JAMAIS que la plateforme ne fait pas d'audio) : toute demande de GÉNÉRATION d'un audio, d'une voix-off, d'une narration parlée, d'un texte lu ou d'une synthèse vocale est servie par la plateforme : mode=plan avec UN SEUL step :",
          '  { title: "Synthèse vocale", toolName: "voice.speak", toolInput: { text: "<le texte EXACT à faire entendre, fidèle à la demande>", voiceId?: "<si l\'utilisateur en précise un>" } }.',
          "Si le texte à faire entendre n'est pas encore connu (ex : « génère-moi un audio de 5s » sans contenu), réponds mode=chat avec UNE SEULE question demandant le texte à synthétiser — ne refuse JAMAIS, ne propose JAMAIS un service externe ni un tutoriel.",
          "Si l'utilisateur répond ensuite avec le texte attendu, ce message EST le texte à synthétiser : route-le en voice.speak avec CE texte exact.",
        ].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const clarificationSection = [
    "",
    "CLARIFICATION (compréhension exacte — MIEUX VAUT DEMANDER QUE MAL EXÉCUTER) :",
    "Avant de choisir le mode, reformule silencieusement la demande dans `understanding` — fidèle aux mots de l'utilisateur.",
    "Pose UNE seule question (needsClarification=true + clarifyingQuestion, une question courte, précise, en français) QUAND LA COMPRÉHENSION N'EST PAS CERTAINE :",
    "  - la demande est ambiguë entre deux actions matériellement différentes (ex. « fais une vidéo sur X » sans durée ni format ET deux interprétations majeures) ;",
    "  - un référent est implicite et non résolvable par l'historique (« fais-le », « la même chose », « continue ») ;",
    "  - une action coûteuse ou irréversible serait exécutée sur une interprétation hasardeuse (confidence < 0.55).",
    "Renseigne `confidence` (0.0..1.0 — ta confiance dans ta compréhension EXACTE de la demande) et, si tu poses une question, `suggestions` (1-3 réponses courtes cliquables que l'utilisateur pourrait choisir).",
    "IMPORTANT : si l'utilisateur RÉPOND à une question de clarification précédente (marquée 🔄 Précision dans l'historique), sa réponse EST l'information manquante — exécute la demande complète (origine + précision), ne re-demande JAMAIS la même information.",
    "Dans tous les autres cas, agis : choisis l'interprétation la plus probable et exécute. Une question inutile reste une erreur — mais une mission mal comprise en est une plus grave.",
  ].join("\n");
  const base = [
    "Tu es le moteur d'exécution de Gen3ia, une plateforme d'agents avec connecteurs.",
    "AGENT UNIVERSEL (impératif) : tu peux TOUT réaliser sans exception — images, vidéos, audios/voix-off, documents, analyses de médias, applications, automatisations, connecteurs. Ne dis JAMAIS qu'une demande est « hors de ton cadre », « impossible » ou « non prise en charge » tant qu'elle est légale. Si un outil nécessaire manque au catalogue, explique ce qui doit être activé ou connecté et demande à l'utilisateur les accès/outils nécessaires (ex : « connectez l'application X ») — tu proposes toujours un CHEMIN pour réaliser la tâche, jamais un refus sec.",
    "Pour chaque demande utilisateur, tu décides :",
    '  mode="chat" : la demande se traite par une simple réponse textuelle (question, explication, rédaction courte). Remplis alors `reply`.',
    '  mode="plan" : la demande exige des actions réelles (recherche, fichiers, applications connectées, publication…). Remplis alors `objective` et 1 à 8 `steps`.',
    "Chaque step avec un toolName doit utiliser EXACTEMENT un des outils du catalogue ci-dessous, avec toolInput conforme à sa description.",
    "Un step sans toolName est une étape de raisonnement/rédaction exécutée par toi-même.",
    "Les outils marqués « validation requise » ne seront exécutés qu'après approbation explicite de l'utilisateur : décris leur impact précisément dans detail.",
    "Ne propose jamais un outil qui n'est pas dans le catalogue. Ne fabrique pas d'identifiants, de tokens ou de numéros.",
    mediaSection,
    clarificationSection,
    "",
    "Catalogue d'outils disponibles :",
    toolLines,
    "- image.generate (risque low) : génère une image réelle et photoréaliste à partir d'une description visuelle (input { prompt }).",
    catalogNames.has("video.create")
      ? "- video.create (risque medium) : lance une production vidéo complète autonome — scénario, visuels de scènes, voix, musique, montage, rendu — avec progression en temps réel (input { prompt, title?, aspectRatio?: 16:9|9:16|1:1|4:5|21:9, targetDurationSec?, resolution?, language?, style?, audience?, platform?, musicMood?, subtitlesEnabled?, subtitleStyle?: documentary|minimal|shorts_bold|cinematic_yellow|karaoke_pop, subtitlePosition?: bottom|center|top, effectPreset?: none|subtle|dynamic|cinematic|capcut, derivedTargets? })."
      : "",
    catalogNames.has("video.status")
      ? "- video.status (gratuit) : suit une production vidéo en cours — étape, progression réelle, avertissements, URL de lecture du master une fois terminé (input { jobId? | projectId? } — dernier lancement par défaut)."
      : "",
    catalogNames.has("video.revise")
      ? "- video.revise : réviser/piloter une vidéo EXISTANTE en langage naturel — rythme, musique, voix (\"utilise ma voix\"), style de sous-titres, suppression/régénération de scène, pause/reprise/annulation du rendu, formats dérivés (input { projectId, action?: revise|pause_render|resume_render|cancel_render|add_exports, instruction?, targets? })."
      : "",
    "",
    project?.instructions ? `Instructions persistantes du projet « ${project.name} » (à respecter) :\n${project.instructions}` : "",
    project?.privacyRules ? `Règles de confidentialité du projet (impératives) :\n${project.privacyRules}` : "",
    connectorSection,
    customApiSection,
    directApiSection,
    sousServicesSection,
    artefactsSection,
    emailSection,
    // Task 143 — axe 4 : les serveurs MCP de l'utilisateur sont des outils
    // RÉELS (serverId + arguments documentés) — injectés après les sections
    // connecteurs/API pour que le planificateur les utilise à bon escient.
    mcpNote ?? "",
    "Réponds UNIQUEMENT avec l'objet JSON conforme au schéma.",
  ]
    .filter(Boolean)
    .join("\n");
  const metaSections = [
    meta?.evolutionContext,
    meta?.runHistoryContext,
    meta?.languageDirective,
    meta?.complexity
      ? `COMPLEXITÉ DE LA DEMANDE : score ${meta.complexity.score}/100 (niveau ${meta.complexity.level})${meta.complexity.beyondMastered ? " — au-delà du niveau déjà maîtrisé : MODE ÉVOLUTION activé, planifie plus finement, vérifie chaque étape, utilise de vrais outils et délègue à des sous-agents si nécessaire." : " — planifie en conséquence, sans étapes superflues."}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return metaSections ? `${base}\n${metaSections}` : base;
}
