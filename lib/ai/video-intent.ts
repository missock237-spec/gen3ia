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

const VIDEO_NOUN_RE =
  /\b(vid[ée]os?|videos?|clip|clips|reels?|shorts?|short video|montage|montages|film|trailer|teaser|bande[- ]annonce|bande annonce|pub vid[ée]o|publicit[ée] vid[ée]o|vid[ée]o publicitaire|tutoriel vid[ée]o|animation)\b/i;

const VIDEO_CREATION_VERB_RE =
  /\b(cr[ée][eé]?[sr]?|cr[ée]er?|g[ée]n[èe]re[rz]?|g[ée]n[èe]rer?|fais[ez]?|fait|fabriqu\w*|produis\w*|produire|monte[rz]?|monter|montage|r[ée]alis\w*|r[ée]aliser|confectionn\w*|veux|voudrais|aimerais|lance[rz]?|make|create|generate|produce|edit|render|want)\b/i;

/** Amorce interrogative : une pure question méta ne produit pas de vidéo. */
const QUESTION_PREFIX_RE =
  /^(c['']est quoi|qu['']est[- ]ce|pourquoi|comment|qui (est|a)|o[ùu]|quand|quel(?:le)?s?(?:\s+\w+){0,3}\s|est[- ]ce que|what|why|how|who|where|which)\b/i;

/** Demandes de pages/web/app : routage artefact application, PAS vidéo. */
const WEB_APP_CONTEXT_RE =
  /\b(page (web|d['']accueil|de vente)|site (web|internet|vitrine)|landing|application (web|mobile)|page de|web app|html|site avec|page avec)\b/i;

/** Question méta posée SUR le sujet vidéo (sans intention de production). */
const META_QUESTION_RE =
  /\b(c['']est quoi|qu['']est[- ]ce que|signifie|veut dire|diff[ée]rence|conseils?|astuces?|meilleur (logiciel|outil)|comment (fonctionne|marche))\b/i;

/**
 * La demande exprime-t-elle une production vidéo COMPLÈTE à lancer ?
 * (usage moteur : court-circuit déterministe avant la décision d'intention)
 */
export function looksLikeVideoRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  const lower = trimmed.toLowerCase();
  if (WEB_APP_CONTEXT_RE.test(lower)) return false;
  if (META_QUESTION_RE.test(lower) && !/\b(g[ée]n[èe]re|cr[ée]e|fais|monte|lance)\s+(moi\s+)?(une?|la|le|des)\b/i.test(lower)) {
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
    .replace(/^(fais[ez]?[- ]?moi|g[ée]n[èe]re[rz]?[- ]?moi|cr[ée][eé]?[sr]?[- ]?moi|peux[- ]tu|pourrais[- ]tu|pourriez[- ]tu|merci de|stp|s['']il (te|vous) pla[iî]t)\s+/i, "")
    .replace(/^(cr[ée][eé]?[sr]?|g[ée]n[èe]re[rz]?|fais[ez]?|monte[rz]?|lance[rz]?|produis|je veux|je voudrais|j['']aimerais)\s+/i, "")
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

/** Marqueurs voix (FR + EN), identiques à VOICE_RE (tool-intent.ts). */
const VOICE_REQUEST_RE =
  /\b(voix off|narration (?:audio|vocal\w*|sonore)|synth[èe]se vocale|voix synth[ée]tique|text[- ]to[- ]speech|text to speech|tts|locution|lire (?:à|a) voix haute|version audio|g[ée]n[èe]r\w* (?:une |la |de la )?voix)\b/i;

/** Commandes audio explicites sans mot « voix » (audio parlé). */
const AUDIO_SPEECH_RE =
  /\b(g[ée]n[èe]re?|cr[ée]e?|fais)\s*(?:-|\s)?(moi\s+)?(un|une)\s+audio\b/i;

/** Lecture à voix haute explicite (« lis ce texte à voix haute : X »). */
const VOICE_READ_ALOUD_RE =
  /\b(lis|lit|lire|lecture)\b[^.!?\n]{0,60}\bvoix haute\b/i;

/** Impératif de production : une question méta n'est PAS une demande. */
const VOICE_IMPERATIVE_RE =
  /\b(g[ée]n[èe]r\w*|cr[ée]\w*|fais\w*|lis|lire|dit[s]?|dis)\b/i;

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
 * Extrait le TEXTE À SYNTHÉTISER d'une demande de voix-off (« voix off
 * disant X », « génère un audio qui dit X », « lis ce texte à voix haute :
 * X »). PUR, zéro LLM. Retourne null quand la demande ne contient pas de
 * texte exploitable (le flux normal — planificateur + outil voice.speak —
 * prend alors le relais).
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
      const text2speak = extraireTexteAParler(captured);
      if (text2speak.length >= 2) {
        return { text2speak: text2speak.slice(0, 2500) };
      }
    }
  }
  return null;
}
