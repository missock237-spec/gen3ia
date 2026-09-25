import type { CustomApiAuthType } from "./repository";

/**
 * Détection déterministe de la FOURNITURE d'une API dans le chat :
 * « Connecte cette API : https://api.exemple.com avec la clé abc123 ».
 * Quand un motif est reconnu, le connecteur est réellement créé et confirmé —
 * aucune hallucination : la configuration renvoyée reprend exactement ce que
 * l'utilisateur a écrit.
 */

export interface DetectedApiProvisioning {
  name: string;
  baseUrl: string;
  authType: CustomApiAuthType;
  authHeader?: string;
  authValue?: string;
  queryKey?: string;
  description?: string;
}

/** Mots-clés « API » obligatoires pour éviter tout faux positif sur une simple URL. */
const API_KEYWORD = /\bapi\b/i;

/** Verbes d'enregistrement/branchement explicites. */
const PROVISIONING_VERBS =
  /(connecte[rz]?|ajoute[rz]?|enregistre[rz]?|branche[rz]?|ajout(e|ons)|ajouter|declare[rz]?|configure[rz]?|int[eé]gre[rz]?)\b/i;

/** Formules « voici mon api / utilise cette api / nouvelle api … » suivies d'une URL. */
const API_PRESENTATION = /(voici|voil[àa]|j'ai|nouvelle|this|my)\s+(mon\s+|ma\s+|la\s+|cette\s+|the\s+|your\s+)?api\b/i;

/** Indicateurs de secret : présence d'une clé/token dans le message. */
const SECRET_INDICATOR =
  /(cl[eé]\s*[:=]|key\s*[:=]|token\s*[:=]|api[-_ ]?key\s*[:=]|apikey\s*[:=]|secret\s*[:=]|bearer\s+[A-Za-z0-9._~+/=-]{8,}|authorization\s*[:=])/i;

/** Extrait une clé/token après un indicateur (« clé: abc123 », « clé abc123 », « token = xyz… »). */
const SECRET_VALUE_PATTERNS: Array<{ re: RegExp; authType: CustomApiAuthType; header?: string }> = [
  { re: /authorization\s*[:=]\s*(bearer\s+)?([A-Za-z0-9._~+/=-]{8,200})/i, authType: "header", header: "Authorization" },
  { re: /\bbearer\s+([A-Za-z0-9._~+/=-]{8,200})/i, authType: "bearer" },
  {
    re: /(api[-_ ]?key|apikey)\s*[:=]?\s*["']?([A-Za-z0-9._~+/=-]{8,200})["']?/i,
    authType: "header",
    header: "X-API-Key",
  },
  {
    re: /(?:cl[eé]|key|token|secret|access[-_ ]?token)\s*[:=]?\s*["']?([A-Za-z0-9._~+/=-]{8,200})["']?/i,
    authType: "bearer",
  },
];

/** Première URL http(s) plausible du message (hors fichiers/localhost). */
export function extractApiUrl(message: string): string | null {
  const matches = message.match(/https?:\/\/[^\s"'<>»«,;)}\]]+/gi);
  if (!matches) return null;
  for (const candidate of matches) {
    const cleaned = candidate.replace(/[.)]+$/, "");
    try {
      const url = new URL(cleaned);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      const host = url.hostname.toLowerCase();
      if (!host || host === "localhost" || host.endsWith(".local") || host === "gen3ia.online" || host.endsWith(".gen3ia.online")) continue;
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) continue;
      return cleaned;
    } catch {
      continue;
    }
  }
  return null;
}

/** Nom lisible : texte entre guillemets « … » / "…" autour d'API, sinon nom d'hôte. */
export function extractApiName(message: string, baseUrl: string): string {
  const quoted = message.match(/[«"]([^»"]{2,60})[»"]/);
  if (quoted?.[1] && !/https?:/i.test(quoted[1])) return quoted[1].trim();
  const named = message.match(/api\s+(?:qui s'appelle|nomm[ée]e|appel[ée]e|d[eé]nomm[ée]e)\s+([A-Za-z0-9 ._-]{2,60})/i);
  if (named?.[1]) return named[1].trim().replace(/[.,;:!?)].*$/, "");
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return "API personnelle";
  }
}

/** Analyse le message et retourne une configuration d'API exacte, ou null. */
export function detectApiProvisioning(message: string): DetectedApiProvisioning | null {
  const lower = message.toLowerCase();
  if (!API_KEYWORD.test(message)) return null;

  const verb = PROVISIONING_VERBS.test(message);
  const presentation = API_PRESENTATION.test(message);
  const url = extractApiUrl(message);
  if (!url) return null;
  if (!verb && !presentation) return null;
  // Une URL seule + un verbe générique (« cherche sur https://… ») ne suffit
  // pas : il faut soit un secret fourni, soit une formule de branchement claire.
  const hasSecret = SECRET_INDICATOR.test(message);
  if (!verb && !hasSecret) return null;

  let authType: CustomApiAuthType = "none";
  let authHeader: string | undefined;
  let authValue: string | undefined;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    const match = message.match(pattern.re);
    if (match) {
      authType = pattern.authType;
      authValue = (match[2] ?? match[1]).trim();
      authHeader = pattern.header;
      break;
    }
  }
  if (authType === "none" && lower.includes("authentification") && !hasSecret) {
    /* l'utilisateur annonce une API protégée sans donner la clé : on crée
       quand même le connecteur, il complétera l'authentification ensuite. */
  }

  const name = extractApiName(message, url);
  return {
    name,
    baseUrl: url,
    authType,
    ...(authHeader ? { authHeader } : {}),
    ...(authValue ? { authValue } : {}),
    ...(authType === "query" ? { queryKey: "api_key" } : {}),
    description: message.slice(0, 300),
  };
}

/** Demande d'UTILISATION d'une API (verbe d'appel + mot api/connecteur). */
export function looksLikeApiUsageRequest(message: string): boolean {
  return /(utilise|r[eé]cup[eè]re|appelle|interroge|interroger|appeler|requ[eê]te|passe par|demande [àa]|via)\s+(l'|la |le |ce |cette |mon |ma )?(api|connecteur)/i.test(message);
}

/** Extrait le nom d'API mentionné dans une demande d'utilisation (si identifiable). */
export function extractApiUsageName(message: string): string | null {
  const explicit = message.match(/api\s+(?:«\s?([^»]{2,60})\s?»|"([^"]{2,60})"|(?:qui s'appelle|nomm[ée]e|appel[ée]e)\s+([\p{L}0-9 ._-]{2,60}))/iu);
  if (explicit) {
    const name = (explicit[1] ?? explicit[2] ?? explicit[3])?.trim();
    if (name) return name.replace(/[.,;:!?)].*$/, "");
  }
  const after = message.match(/(?:api|connecteur)\s+(?:personnelle\s+)?(?!(?:pour|afin|et|via|de|du|des|la|le|les|sur|dans|me|m')\b)([\p{L}0-9][\p{L}0-9 ._-]{1,59}?)(?=\s+pour\s|\s+afin\s|\s+et\s|[,.;:!?]|$)/iu);
  return after?.[1]?.trim() ?? null;
}
