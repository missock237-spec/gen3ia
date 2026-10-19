/**
 * Détection déterministe des intentions « agents » formulées en langage
 * naturel — les fonctionnalités d'agents IA passent sous la commande de l'IA :
 * l'utilisateur DEMANDE à l'IA de créer, lister, activer, désactiver ou
 * supprimer un agent directement depuis la conversation, sans passer par
 * un formulaire.
 *
 * Principe anti-hallucination (identique à service-intents) : une détection
 * ne retourne QUE ce que l'utilisateur a réellement énoncé. Le type d'agent
 * est déduit de mots-clés explicites ; à défaut il devient « Personnalisé »
 * reprenant le spécialité énoncée ; le nom par défaut est HONNÊTE et affiché
 * dans la confirmation.
 */

export type AgentIntent =
  | { action: "create"; name: string; typeKey: string; customType?: string }
  | { action: "list" }
  | { action: "delete"; name?: string }
  | { action: "enable"; name?: string }
  | { action: "disable"; name?: string };

/* ------------------------------------------------------------------ */
/* Marqueurs                                                           */
/* ------------------------------------------------------------------ */

/** L'énoncé porte bien sur un agent (pas un livrable, pas un workflow). */
const AGENT_TARGET_RE =
  /\bagents?\s*(?:ia|intelligents?|d'[eé]quipe|sp[eé]cialis[eé]s?|d[eé]di[eé]s?|vocals?|personnalis[eé]s?)?\b/i;

const VERB_CREATE_RE =
  /\b(cr[eé]e(?:r|z|-?moi)?|g[eé]n[eè]re(?:r|-?moi)?|construis(?:re|-?moi)?|fabriqu(?:e|er)|ajout(?:e|er|-?moi)|mets? (?:en place|moi)|met (?:en place|moi)|configure(?:r|-?moi)?|d[eé]finis(?:s-?moi)?|create|build|make|add)\b/i;

const VOLONTE_RE = /\bje (?:veux|voudrais|souhaite|aimerais|d[eé]sire)\b/i;

const VERB_LIST_RE =
  /\b(liste|lister|affiche(?:r)?|montre(?:r|-?moi)?|quels? sont|quelles? sont|donne[- ]moi|vois?|voir|show|list)\b/i;

const VERB_DELETE_RE =
  /\b(supprim(?:e|er|es?|ons)|effac(?:e|er|es?)|enl[eè]v(?:e|er)|retir(?:e|er)|delete|remove)\b/i;

const VERB_DISABLE_RE =
  /\b(d[eé]sactiv(?:e|er)|arr[eê]t(?:e|er|es?)|stoppe(?:r)?|suspend(?:re)?|mets? en pause|met en pause|disable|stop|pause)\b/i;

const VERB_ENABLE_RE =
  /\b(r[eé]activ(?:e|er)|activ(?:e|er)|relance(?:r)?|r[eé]enclench(?:e|er)|enable|resume)\b/i;

/** Questions informatives : JAMAIS une action (aucune création surprise). */
const INFO_GUARD_RE =
  /\b(c'?est quoi|qu'est-?ce qu|comment (?:cr[eé]er|fonctionne|faire|puis-je)|pourquoi|diff[eé]rence|peux-?tu (?:m')?expliquer|explique(?:r|-?moi))\b/i;

/* ------------------------------------------------------------------ */
/* Types d'agents (mots-clés énoncés → clé wizard)                     */
/* ------------------------------------------------------------------ */

const TYPE_KEYWORDS: Array<{ key: string; re: RegExp }> = [
  { key: "code", re: /\b(code|d[eé]veloppe(?:ur|se)|programmation|informatique|d[eé]bug|script)\b/i },
  { key: "marketing", re: /\b(marketing|seo|copywriting|communication|publicit[eé]|r[eé]seaux? sociaux|contenu|community manager)\b/i },
  { key: "teaching", re: /\b(enseignement|prof(?:esseur)?|tuteur|p[eé]dagog\w*|cours|[eé]ducation|formation|tutorat)\b/i },
  { key: "sales", re: /\b(commercial\w*|ventes?|prospection|vendeur|vendeuse|sales|lead\w*)\b/i },
  { key: "voice", re: /\b(vocal|t[eé]l[eé]phon\w*|appel(?:s)? t[eé]l[eé]phonique?s?|standardiste|voix)\b/i },
];

/** Spécialité libre : « spécialisé en/dans/pour X », « qui gère X ». */
const CUSTOM_TYPE_RE =
  /\b(?:sp[eé]cialis[eé]s? (?:en|dans|pour)|qui g[eè]re|qui g[eé]rerait|pour g[eé]rer)\s+([^.!?,;:\n]{2,60})/i;

const TYPE_LABELS: Record<string, string> = {
  code: "Développement & Code",
  marketing: "Marketing",
  teaching: "Enseignement",
  sales: "Commercial",
  voice: "Agent vocal",
  custom: "Personnalisé",
};

/* ------------------------------------------------------------------ */
/* Extraction : nom, spécialité                                        */
/* ------------------------------------------------------------------ */

/** Nom cité ou introduit : « agent nommé Alex », « agent "Alex" », « agent « Alex » ». */
export function extraireNomAgent(message: string): string | undefined {
  const guillemets = /[«"“']([^»"”']{2,40})[»"”']/.exec(message);
  if (guillemets) return guillemets[1]!.trim();
  const nomme = /\bagents?\s+(?:[a-zà-ÿ]+\s+){0,3}?(?:nomm[eé]s?|appel[eé]s?|baptis[eé]s?)\s+([A-Za-zÀ-ÿ0-9][A-Za-zÀ-ÿ0-9' -]{1,39})/i.exec(message);
  if (nomme) {
    const nom = nomme[1]!
      .replace(/\b(qui|pour|charg[eé]|sp[eé]cialis[eé]|de|du|en|dans)\b.*$/i, "")
      .replace(/[.!?…,;:]+$/, "")
      .trim();
    if (nom.length >= 2) return nom;
  }
  // « supprime l'agent Alex » / « active mon agent Alex » : suite de mots
  // capitalisés uniquement (les adverbes minuscules sont exclus —
  // « Sarah maintenant » → « Sarah », « Jean Pierre » reste entier).
  const cible = /\b(?:l'|le |la |mon |ma |mes |ce |cet |cette )?agents?\s+([A-ZÀ-Þ][\p{L}'-]*(?:\s+[A-ZÀ-Þ][\p{L}'-]*)*)/u.exec(message);
  if (cible) {
    const nom = cible[1]!.trim();
    // Le nom propre doit rester plausible : pas un marqueur générique.
    if (nom.length >= 2 && !/^(ia|intelligent|intelligente|sp[eé]cialis[eé]|vocal|autonome)$/i.test(nom)) return nom;
  }
  return undefined;
}

/** Spécialité énoncée (« spécialisé en immobilier » → « immobilier »). */
export function extraireSpecialite(message: string): string | undefined {
  const m = CUSTOM_TYPE_RE.exec(message);
  if (!m) return undefined;
  const specialite = m[1]!
    .replace(/^(?:mes?|ma|mon|les?|la|le|des|du|de la|de)\s+/i, "")
    .replace(/[.!?…,;:]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return specialite.length >= 2 ? specialite : undefined;
}

/** Nom de repli honnête (affiché dans la confirmation, modifiable ensuite). */
function nomParDefaut(typeKey: string, customType?: string): string {
  if (customType) return `Agent ${customType.charAt(0).toUpperCase()}${customType.slice(1)}`;
  return `Agent ${TYPE_LABELS[typeKey] ?? "IA"}`;
}

/* ------------------------------------------------------------------ */
/* Détecteur principal                                                 */
/* ------------------------------------------------------------------ */

/**
 * Détecte une demande de gestion d'agent formulée naturellement :
 * créer (« crée-moi un agent commercial nommé Alex »), lister (« liste mes
 * agents »), activer/désactiver/supprimer (« désactive l'agent Alex »).
 * Null si la phrase est une question informative ou ne porte pas sur les agents.
 */
export function detectAgentIntent(message: string): AgentIntent | null {
  const sansCitations = message.replace(/[«"“']([^»"”']*)[»"”']/g, " ");
  const lower = sansCitations.toLowerCase();

  // Les citations ne portent PAS l'intention : « l'agent « Rapport » » désigne
  // une cible — on évalue les marqueurs sur le texte nettoyé.
  const targetRe = /\bagents?\b/i;

  // PRIORITÉ À LA CRÉATION (comme service-intents) : « crée un agent et
  // connecte-le » reste une création.
  const veutCreation = VERB_CREATE_RE.test(lower) || VOLONTE_RE.test(lower);

  if (veutCreation && targetRe.test(sansCitations) && !INFO_GUARD_RE.test(lower)) {
    // Type : mots-clés explicites d'abord, spécialité énoncée ensuite.
    let typeKey = "custom";
    let customType: string | undefined;
    for (const entry of TYPE_KEYWORDS) {
      if (entry.re.test(lower)) {
        typeKey = entry.key;
        break;
      }
    }
    if (typeKey === "custom") {
      customType = extraireSpecialite(message);
    }
    const nom = extraireNomAgent(message) ?? nomParDefaut(typeKey, customType);
    return { action: "create", name: nom.slice(0, 60), typeKey, ...(customType ? { customType } : {}) };
  }

  if (!targetRe.test(lower)) return null;
  if (INFO_GUARD_RE.test(lower)) return null;

  if (AGENT_TARGET_RE.test(lower)) {
    if (VERB_DELETE_RE.test(lower)) {
      return { action: "delete", ...(extraireNomAgent(message) ? { name: extraireNomAgent(message) } : {}) };
    }
    if (VERB_DISABLE_RE.test(lower)) {
      return { action: "disable", ...(extraireNomAgent(message) ? { name: extraireNomAgent(message) } : {}) };
    }
    if (VERB_ENABLE_RE.test(lower)) {
      return { action: "enable", ...(extraireNomAgent(message) ? { name: extraireNomAgent(message) } : {}) };
    }
    if (VERB_LIST_RE.test(lower) || /\bmes agents\b/i.test(lower)) {
      return { action: "list" };
    }
  }

  return null;
}
