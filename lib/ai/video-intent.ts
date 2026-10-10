/**
 * DÉTECTION DE DEMANDE DE VIDÉO — routage déterministe (zéro variance LLM)
 * vers la production vidéo autopilotée (file `videoProductionJobs`).
 *
 * Miroir de `lib/ai/image-generation.ts` (looksLikeImageRequest) : verbe de
 * création + nom de vidéo. Garde-fous :
 *  - les demandes de PAGES/SITES web restent routées vers l'artefact
 *    application (détection amont) — jamais vers une production vidéo ;
 *  - les questions méta (« c'est quoi un bon montage vidéo ? »,
 *    « comment créer une vidéo ? ») ne déclenchent PAS de production ;
 *  - FR + EN.
 */

// Task 106-a — TYPES CANONIQUES du pipeline (source unique lib/video/types.ts)
import { VIDEO_ASPECT_RATIOS, type VideoExportTarget } from "@/lib/video/types";

/* ────────────────────────────────────────────────────────────────────────
 * FRONTIÈRES DE MOT UNICODE (fix captures 13:02 — cause racine).
 *
 * JavaScript `\b` et `\w` sont ASCII : « é », « è », « à » ne sont PAS des
 * caractères de mot → tout verbe français se terminant par un accent
 * (« créé », « généré », « lancé ») faisait ÉCHOUER le `\b` final et toute
 * la détection (« Créé une vidéo de 5s d'un bébé qui marche » partait en
 * mission au lieu de l'intercept vidéo). Toutes les frontières utilisent
 * désormais des garde-fous \p{L}/\p{N} avec le flag `u`.
 * ──────────────────────────────────────────────────────────────────────── */

/** Garde-fou gauche : le caractère précédent n'est PAS une lettre/chiffre. */
const U_START = "(?<![\\p{L}\\p{N}_])";
/** Garde-fou droit : le caractère suivant n'est PAS une lettre/chiffre. */
const U_END = "(?![\\p{L}\\p{N}_])";

const VIDEO_NOUN_RE = new RegExp(
  `${U_START}(?:vid[ée]os?|videos?|clip|clips|reels?|shorts?|short video|montages?|film|trailer|teaser|bande[- ]annonce|bande annonce|pub vid[ée]o|publicit[ée] vid[ée]o|vid[ée]o publicitaire|tutoriel vid[ée]o|animation)${U_END}`,
  "iu",
);

const VIDEO_CREATION_VERB_RE = new RegExp(
  `${U_START}(?:cr[ée]\\p{L}*|g[éèe]n[éèe]r\\p{L}*|fais\\p{L}*|fait\\p{L}*|fabriqu\\p{L}*|produi\\p{L}*|monte[rz]?|mont[ée]\\p{L}*|r[ée]alis\\p{L}*|confectionn\\p{L}*|veux|voudrais|aimerais|lanc[ée]\\p{L}*|lance[rz]?|make|create|generate|produce|edit|render|want)${U_END}`,
  "iu",
);

/** Amorce interrogative : une pure question méta ne produit pas de vidéo. */
const QUESTION_PREFIX_RE = new RegExp(
  `^(?:c[''’]est quoi|qu[''’]est[- ]ce|pourquoi|comment|qui (?:est|a)|o[ùu]|quand|quel(?:le)?s?(?:\\s+\\p{L}+){0,4}|est[- ]ce que|what|why|how|who|where|which)${U_END}`,
  "iu",
);

/** Demandes de pages/web/app : routage artefact application, PAS vidéo. */
const WEB_APP_CONTEXT_RE = new RegExp(
  `${U_START}(?:page (?:web|d[''’]accueil|de vente)|site (?:web|internet|vitrine)|landing|application (?:web|mobile)|page de|web app|html|site avec|page avec)${U_END}`,
  "iu",
);

/** Question méta posée SUR le sujet vidéo (sans intention de production). */
const META_QUESTION_RE = new RegExp(
  `${U_START}(?:c[''’]est quoi|qu[''’]est[- ]ce que|signifie|veut dire|diff[ée]rence|conseils?|astuces?|meilleur (?:logiciel|outil)|comment (?:fonctionne|marche))${U_END}`,
  "iu",
);

/**
 * La demande exprime-t-elle une production vidéo COMPLÈTE à lancer ?
 * (usage moteur : court-circuit déterministe avant la décision d'intention)
 */
export function looksLikeVideoRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  const lower = trimmed.toLowerCase();
  if (WEB_APP_CONTEXT_RE.test(lower)) return false;
  if (META_QUESTION_RE.test(lower) && !/\b(g[éèe]n[éèe]re|cr[ée]e|fais|monte|lance)\s+(moi\s+)?(une?|la|le|des)\b/i.test(lower)) {
    return false;
  }
  if (QUESTION_PREFIX_RE.test(trimmed)) return false;
  return VIDEO_NOUN_RE.test(lower) && VIDEO_CREATION_VERB_RE.test(lower);
}

/**
 * Titre court de la production, dérivé de la demande (nettoyage des
 * formules d'adresse, ponctuation tronquée) — affiché dans l'atelier vidéo.
 */
export function extractVideoTitle(text: string): string {
  const cleaned = text
    .replace(/^(fais[ez]?[- ]?moi|g[éèe]n[éèe]re[rz]?[- ]?moi|cr[ée][eé]?[sr]?[- ]?moi|peux[- ]tu|pourrais[- ]tu|pourriez[- ]tu|merci de|stp|s['']il (te|vous) pla[iî]t)\s+/i, "")
    .replace(/^(cr[ée][eé]?[sr]?|g[éèe]n[éèe]re[rz]?|fais[ez]?|monte[rz]?|lance[rz]?|produis|je veux|je voudrais|j['']aimerais)\s+/i, "")
    .replace(/^(moi |nous )\s*/i, "")
    .replace(/^(une? |le |la |des |de la |du )\s*/i, "")
    .replace(/^(vid[ée]o|video|clip|reel|short|montage|film)\s+/i, "")
    .replace(/^(sur |about |de |du |pour )+/i, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || text.trim();
  return base.slice(0, 80) || "Production vidéo";
}

/* ────────────────────────────────────────────────────────────────────────
 * Task 106-a — EXTRACTION DE PARAMÈTRES DE PRODUCTION (déterministe).
 * Le chat lance des productions OPTIMALES : durée, cadrage et formats
 * dérivés sont lus DIRECTEMENT dans la demande (aucun LLM, zéro variance),
 * puis relayés à la file de production (ProductionJobOptions).
 * ──────────────────────────────────────────────────────────────────────── */

/** Ratios valides du pipeline — RÉ-EXPORT du constant canonique. */
const PARAM_ASPECT_RATIOS = VIDEO_ASPECT_RATIOS;

const NUMBER_WORDS: Record<string, number> = {
  une: 1, un: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10, // « six » déjà défini (FR/EN)
};

/**
 * Paramètres de production détectés dans la demande (tous optionnels).
 * `derivedTargets` reprend les formats de diffusion dérivés du pipeline
 * (lib/video/types.ts) — ex. une demande TikTok produit un 9:16 + shorts.
 */
export interface VideoRequestParams {
  targetDurationSec?: number;
  aspectRatio?: (typeof VIDEO_ASPECT_RATIOS)[number];
  platform?: string;
  derivedTargets?: VideoExportTarget[];
}

/** Durée cible en secondes lue dans le texte (bornée 10..3600), sinon undefined. */
export function extractTargetDurationSec(text: string): number | undefined {
  const lower = text.toLowerCase();

  // 1) Heures : "1h30", "1 h 30" (demi-heure → 1800 s).
  const hourMatch = lower.match(/\b(\d{1,2})\s*h(?:\s*(\d{1,2}))?\b/);
  if (hourMatch) {
    const h = Number(hourMatch[1]);
    const m = hourMatch[2] ? Number(hourMatch[2]) : 0;
    const total = h * 3600 + m * 60;
    return clampDuration(total);
  }
  if (/\bdemi[- ]heure\b/.test(lower)) return 1800;

  // 2) Minutes explicites : "90 minutes", "2 min", "une minute".
  const minuteMatch = lower.match(/\b(\d{1,4})\s*(?:minutes?|mins?)\b/);
  if (minuteMatch) return clampDuration(Number(minuteMatch[1]) * 60);

  // 3) Secondes explicites : "30 secondes", "45s".
  const secondMatch = lower.match(/\b(\d{1,4})\s*(?:secondes?|secs?)\b/);
  if (secondMatch) return clampDuration(Number(secondMatch[1]));

  // 4) Unité seule avec mot-nombre : "une minute", "deux minutes", "trois secondes".
  const wordMatch = lower.match(/\b(une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|one|two|three|four|five|six|seven|eight|nine|ten)\s+(minutes?|secondes?|mins?|secs?)\b/);
  if (wordMatch) {
    const n = NUMBER_WORDS[wordMatch[1]] ?? 1;
    const isMinutes = /m/.test(wordMatch[2]);
    return clampDuration(n * (isMinutes ? 60 : 1));
  }

  // 5) Unité abrégée collée : "30 s", "2 m", "45 sec" (le plus explicite
  // reste au-dessus) — l'unité portée par le match tranche.
  const looseMatch = lower.match(/\b(\d{1,4})\s*(m|s|sec|min)\b/);
  if (looseMatch) {
    const n = Number(looseMatch[1]);
    if (n > 0 && n <= 3600) return clampDuration(looseMatch[2].startsWith("m") ? n * 60 : n);
  }
  return undefined;
}

function clampDuration(total: number): number | undefined {
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return Math.min(3600, Math.max(10, Math.round(total)));
}

/**
 * Cadrage + plateforme + formats dérivés lus dans la demande. La plateforme
 * est normalisée (TikTok, YouTube, Instagram, Reels, Shorts, Facebook) et
 * implique le ratio + les formats dérivés quand ils ne sont pas explicites.
 */
export function extractVideoParams(text: string): VideoRequestParams {
  const lower = text.toLowerCase();
  const params: VideoRequestParams = {};
  params.targetDurationSec = extractTargetDurationSec(text);

  // Ratio explicite : "9:16", "16/9", "vertical", "horizontal", "paysage", "carré"…
  const explicitRatio = lower.match(/\b(16|9|1|4|21)\s*[:\/]\s*(9|16|1|5)\b/);
  if (explicitRatio) {
    const candidate = `${explicitRatio[1]}:${explicitRatio[2]}`;
    const found = PARAM_ASPECT_RATIOS.find((r) => r === candidate);
    if (found) params.aspectRatio = found;
  }
  if (!params.aspectRatio) {
    if (/\bverticales?\b|\bportrait\b/.test(lower)) params.aspectRatio = "9:16";
    else if (/\bhorizontal\b|\bpaysage\b|\blandscape\b/.test(lower)) params.aspectRatio = "16:9";
    else if (/\bcarr[ée]e?\b|\bsquare\b/.test(lower)) params.aspectRatio = "1:1";
  }

  // Plateforme → ratio + formats dérivés (priorité au ratio explicite).
  const derived: VideoExportTarget[] = [];
  if (/\btik[- ]?tok\b/.test(lower)) {
    params.platform = "TikTok";
    params.aspectRatio = params.aspectRatio ?? "9:16";
    derived.push("tiktok_9_16");
  } else if (/\breels?\b/.test(lower)) {
    params.platform = "Instagram Reels";
    params.aspectRatio = params.aspectRatio ?? "9:16";
    derived.push("reels_9_16");
  } else if (/\bshorts?\b/.test(lower)) {
    params.platform = "YouTube Shorts";
    params.aspectRatio = params.aspectRatio ?? "9:16";
    derived.push("shorts_9_16");
  } else if (/\byou[- ]?tube\b|\byt\b/.test(lower)) {
    params.platform = "YouTube";
    params.aspectRatio = params.aspectRatio ?? "16:9";
    derived.push("youtube_16_9");
  } else if (/\bfacebook\b|\bmeta\b/.test(lower)) {
    params.platform = "Facebook";
    params.aspectRatio = params.aspectRatio ?? "16:9";
    derived.push("facebook_16_9");
  } else if (/\binstagram\b/.test(lower)) {
    params.platform = "Instagram";
    if (params.aspectRatio === "9:16") derived.push("reels_9_16");
    else if (params.aspectRatio === "1:1") derived.push("square_1_1");
    else {
      params.aspectRatio = params.aspectRatio ?? "4:5";
      derived.push("square_1_1");
    }
  }

  // "version TikTok ET YouTube" : formats dérivés multiples détectés.
  if (/\btik[- ]?tok\b/.test(lower) && /\byou[- ]?tube\b/.test(lower) && !derived.includes("youtube_16_9")) {
    derived.push("youtube_16_9");
  }

  if (derived.length > 0) params.derivedTargets = derived.slice(0, 4);
  return params;
}

/* ────────────────────────────────────────────────────────────────────────
 * Task 114-a — VOIX-OFF DIRECTE (intercept chat déterministe, zéro LLM).
 * Miroir de looksLikeVideoRequest : un message demandant une voix-off est
 * servi IMMÉDIATEMENT par synthèse vocale (speakDirectForUser) au lieu de
 * partir dans un plan de mission. Même marqueur que VOICE_RE de
 * lib/agents/runtime/tool-intent.ts (module PUR sans dépendance : regex
 * copiée, tool-intent.ts n'est PAS édité) + garde vidéo (une demande vidéo
 * contenant le mot « voix » reste une PRODUCTION VIDÉO).
 * ──────────────────────────────────────────────────────────────────────── */

/** Marqueurs voix (FR + EN), alignés VOICE_RE (tool-intent.ts) en unicode. */
const VOICE_REQUEST_RE = new RegExp(
  `${U_START}(?:voix[- ]off|narration (?:audio|vocal\\p{L}*|sonore)|synth[èe]se vocale|voix synth[ée]tique|text[- ]to[- ]speech|text to speech|tts|locution|lire (?:à|a) voix haute|version audio|g[éèe]n[éèe]r\\p{L}* (?:une |la |de la |de l' |de l’ )?voix)${U_END}`,
  "iu",
);

/**
 * Commandes audio explicites sans mot « voix » (audio parlé) — couvre les
 * infinitifs/participes accentués (« générer un audio », « généré un audio »,
 * « créé un audio ») que l'ancien pattern ASCII manquait (capture 13:02 :
 * « Peut tu me générer un audio de 5s »).
 */
const AUDIO_SPEECH_RE = new RegExp(
  `${U_START}(?:g[éèe]n[éèe]r\\p{L}*|cr[ée]\\p{L}*|fais\\p{L}*|produi\\p{L}*|lanc[ée]\\p{L}*|lance[rz]?|veux|voudrais|aimerais|besoin(?:\\s+d[e''’])?)\\s*(?:-|\\s)?(?:moi\\s+)?(?:un|une|du|des|de la|de l'|de l’|le|la)\\s*audio${U_END}`,
  "iu",
);

/** Lecture à voix haute explicite (« lis ce texte à voix haute : X »). */
const VOICE_READ_ALOUD_RE = new RegExp(
  `${U_START}(?:lis|lit|lire|lecture)${U_END}[^.!?\\n]{0,60}${U_START}voix haute${U_END}`,
  "iu",
);

/** Impératif de production : une question méta n'est PAS une demande. */
const VOICE_IMPERATIVE_RE = new RegExp(
  `${U_START}(?:g[éèe]n[éèe]r\\p{L}*|cr[ée]\\p{L}*|fais\\p{L}*|lis|lire|dit[s]?|dis)${U_END}`,
  "iu",
);

/**
 * La demande exprime-t-elle une synthèse vocale DIRECTE (voix-off) ?
 * Une demande de production VIDÉO gagne TOUJOURS (la voix-off y est une
 * étape interne, pas le produit demandé) — garde miroir de la route chat.
 * Les questions méta sans impératif (« c'est quoi une voix off ? ») ne
 * déclenchent pas de synthèse.
 */
export function looksLikeVoiceRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  if (looksLikeVideoRequest(trimmed)) return false;
  const isVoiceMarker = VOICE_REQUEST_RE.test(trimmed) || AUDIO_SPEECH_RE.test(trimmed) || VOICE_READ_ALOUD_RE.test(trimmed);
  if (!isVoiceMarker) return false;
  if (QUESTION_PREFIX_RE.test(trimmed) && !VOICE_IMPERATIVE_RE.test(trimmed)) return false;
  return true;
}

/* ────────────────────────────────────────────────────────────────────────
 * SUIVI CONTEXTUEL (fix capture 13:02 — audio) : l'assistant demande le
 * texte à faire entendre (« Quel texte ou quel contenu souhaitez-vous
 * entendre dans cet audio ? ») et l'utilisateur répond « Bjr je suis
 * entrain de venir » : AUCUN marqueur audio dans CE message → l'ancienne
 * détection mono-message laissait filer la demande et le LLM répondait
 * « la plateforme ne prend en charge que la génération d'images ». La
 * résolution relie la réponse à la demande audio précédente.
 * ──────────────────────────────────────────────────────────────────────── */

export interface VoiceHistoryTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ContextVoiceResolution extends VoiceRequestText {
  /** "direct" = texte extrait du message courant ; "context" = réponse à une clarification. */
  source: "direct" | "context";
}

/**
 * Le message exprime-t-il une intention de CRÉATION audio/voix ? (suiti
 * contextuel : demande précédente de l'utilisateur dans le fil)
 */
const AUDIO_CREATION_INTENT_RE = new RegExp(
  `${U_START}(?:g[éèe]n[éèe]r\\p{L}*|cr[ée]\\p{L}*|fais\\p{L}*|produi\\p{L}*|lanc[ée]\\p{L}*|lance[rz]?|veux|voudrais|aimerais|besoin(?:\\s+d[e''’])?)\\s*(?:-|\\s)?(?:moi\\s+)?(?:un|une|du|des|de la|de l'|de l’|le|la|mon|ma)\\s*(?:audio|son|voix(?:[- ]off)?|narration|locution)${U_END}`,
  "iu",
);

/** Réponse qui annule le suivi contextuel (« non », « annule », « stop »…). */
const VOICE_REFUSAL_RE = new RegExp(
  `^(?:non|nan|annul\\p{L}*|stop|laisse\\p{L}*|oubli\\p{L}*|finalement|en fait)${U_END}`,
  "iu",
);

/** Nom visuel : la réponse contextuelle ne doit jamais capter une demande d'image. */
const VISUAL_NOUN_RE = new RegExp(
  `${U_START}(?:images?|photos?|logo|logos?|illustrations?|dessins?|affiches?|posters?|vid[ée]os?|clips?|reels?|shorts?|miniatures?|avatars?|banni[èe]res?)${U_END}`,
  "iu",
);

/**
 * La question de l'assistant demande-t-elle le TEXTE à faire entendre ?
 * Contient un « ? » (partout dans le message — la question déterministe se
 * termine par « …immédiatement. ») ET parle de texte/contenu/voix/audio/
 * entendre… Les URLS sont retirées AVANT le test (un lien d'écoute signé
 * peut contenir « ? » sans être une question).
 */
export function isVoiceClarifyingQuestion(content: string): boolean {
  const sansUrls = content
    // liens markdown [label](url) → label
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    // URLS nues
    .replace(/https?:\/\/\S+/g, " ");
  if (!sansUrls.includes("?")) return false;
  return new RegExp(`(?:texte|contenu|message|paroles?|entendre|écouter|dire|lire|voix|audio|synth[ée]tis\\p{L}*)`, "iu").test(sansUrls);
}

/**
 * Résout une demande de voix-off à partir du message courant ET du fil :
 *  - texte identifiable dans le message lui-même → source "direct" ;
 *  - réponse de l'utilisateur à une question de clarification posée par
 *    l'assistant après une demande audio → source "context".
 * Retourne null quand il n'y a rien à synthétiser (demande d'audio sans
 * texte → l'appelant pose la question de clarification déterministe).
 */
export function resolveVoiceRequestFromContext(
  message: string,
  priorHistory: VoiceHistoryTurn[] = [],
): ContextVoiceResolution | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  // 1) Demande directe : le message contient lui-même le texte à synthétiser.
  if (looksLikeVoiceRequest(trimmed)) {
    const direct = extractVoiceRequestText(trimmed);
    return direct ? { ...direct, source: "direct" } : null;
  }

  // 2) Suivi contextuel : l'assistant vient de demander le texte à entendre.
  if (VOICE_REFUSAL_RE.test(trimmed)) return null;
  if (looksLikeVideoRequest(trimmed) || VISUAL_NOUN_RE.test(trimmed)) return null;

  const history = priorHistory ?? [];
  // La DERNIÈRE demande utilisateur du fil doit être une demande audio, et
  // tous les messages assistant intervenus depuis doivent être des questions
  // de clarification (aucun audio déjà livré entre-temps).
  let userAskedAudio = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (!turn || turn.role === "system") continue;
    if (turn.role === "assistant") {
      if (!isVoiceClarifyingQuestion(turn.content)) return null;
      continue;
    }
    // Dernier message utilisateur : porte-t-il une intention audio ?
    userAskedAudio = AUDIO_CREATION_INTENT_RE.test(turn.content) || looksLikeVoiceRequest(turn.content);
    break;
  }
  if (!userAskedAudio) return null;

  const text2speak = trimmed.slice(0, 2500);
  if (text2speak.length < 2) return null;
  return { text2speak, source: "context" };
}

export interface VoiceRequestText {
  /** Texte à synthétiser, extrait de la demande (borné au quota outil : 2 500 caractères). */
  text2speak: string;
  /** Sujet court optionnel (nommage du résultat). */
  title?: string;
}

/** Découpe la consigne d'un énoncé : guillemets > deux-points > fin de ligne. */
function extraireTexteAParler(raw: string): string {
  const cleaned = raw
    .replace(/^[«"'\u201c\u2018\s]+/, "")
    .replace(/[»"'\u201d\u2019\s]+$/, "")
    .replace(/^(bon|bien|voici|ok|d'accord)[\s,:]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned;
}

/**
 * Phrases de DURÉE en tête de capture (« 5s », « 30 secondes », « 2 min… ») :
 * « un audio de 5s » ne demande PAS de lire « 5s » à voix haute (capture
 * 13:02 — l'audio livré disait littéralement « cinq secondes »). La durée est
 * retirée de la capture ; s'il ne reste rien, la demande n'a PAS de texte
 * identifiable → question de clarification déterministe.
 */
const LEADING_DURATION_RE =
  /^\s*\d{1,4}\s*(?:s|sec\.?|secs?|secondes?|m|min\.?|mins?|minutes?|h|heures?)\b[\s,.:;—–-]*/i;

/**
 * Extrait le TEXTE À SYNTHÉTISER d'une demande de voix-off (« voix off
 * disant X », « génère un audio qui dit X », « lis ce texte à voix haute :
 * X »). PUR, zéro LLM. Retourne null quand la demande ne contient pas de
 * texte exploitable (le flux normal — question de clarification
 * déterministe + planificateur + outil voice.speak — prend alors le relais).
 */
export function extractVoiceRequestText(text: string): VoiceRequestText | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const patterns: RegExp[] = [
    // « voix off disant X » / « voix off qui dit X » / « voix off sur X »
    /(?:voix off|narration audio|synth[èe]se vocale|version audio|locution)\s*(?:disant|qui dit|avec le texte|sur|de)\s*[:\-—]?\s*(.+)$/i,
    // « génère un audio qui dit X » / « un audio disant X » / « un audio avec le texte X »
    /\baudio\s*(?:qui dit|disant|avec le texte|avec ce texte|de)\s*[:\-—]?\s*(.+)$/i,
    // « lis ce texte à voix haute : X » / « lis à voix haute X »
    /\b(?:lis|lit|lire)\s*(?:(?:ce|le|cette)\s+texte|moi|ceci|[cç]a|cela)?\s*(?:à|a)\s*voix haute\s*[:\-—]?\s*(.*)$/i,
    // Deux-points direct après un marqueur voix (« tts : X », « voix off : X »)
    /\b(?:voix off|narration audio|synth[èe]se vocale|version audio|text[- ]to[- ]speech|tts|locution)\s*[:：]\s*(.+)$/i,
    // Texte cité entre guillemets n'importe où dans la demande
    /[«"\u201c]([^»"\u201d]{4,})[»"\u201d]/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    const captured = match?.[1];
    if (captured) {
      // Une DURÉE en tête de capture n'est pas un texte à faire entendre
      // (« un audio de 5s » → capture « 5s » → rejetée ; « un audio de 5s
      // disant bonjour » → « 5s » retiré → « bonjour » conservé). Le
      // connecteur de parole qui suit la durée est retiré avec elle.
      const sansDuree = captured
        .replace(LEADING_DURATION_RE, "")
        .replace(/^\s*(?:qui\s+dit|disant|avec\s+(?:le\s+|ce\s+)?texte)\s*[:\-—]?\s*/i, "")
        .trim();
      const text2speak = extraireTexteAParler(sansDuree);
      if (text2speak.length >= 2) {
        return { text2speak: text2speak.slice(0, 2500) };
      }
    }
  }
  return null;
}
