/**
 * DÉTECTION D'INTENTIONS OUTIL — auto-sélection déterministe (Task 107-c).
 *
 * Objectif produit : dans la section agent IA, l'utilisateur décrit un BESOIN
 * (« crée-moi une vidéo TikTok », « dessine un logo ») sans JAMAIS désigner
 * l'outil à employer. Ce module analyse l'objectif de façon DÉTERMINISTE
 * (zéro LLM, zéro variance) et produit des indices d'intention à haute
 * confiance injectés dans le prompt du planificateur (planUniversalAgent) —
 * le planner reste libre de choisir, mais il est orienté vers les bons outils
 * du catalogue EFFECTIF (celui filtré par allowedTools / sentinelle "*").
 *
 * Style calibré sur les marqueurs déterministes existants du repo :
 *  - lib/domain/conversations/engine.ts (webMarkers ~ligne 339, sections
 *    media/email/sous-services ~lignes 542-592) ;
 *  - lib/ai/video-intent.ts (looksLikeVideoRequest : verbe de création +
 *    nom de vidéo, garde-fous question méta).
 *
 * Garde-fous sécurité :
 *  - scan limité aux 2000 PREMIERS caractères de l'objectif ;
 *  - max 4 indices retenus (le prompt ne doit pas être dilué) ;
 *  - regex linéaires anti-ReDoS (aucun quantificateur imbriqué — uniquement
 *    des bornes \b et des classes de caractères quantifiées une fois) ;
 *  - module PUR : aucune dépendance, aucun import du registre — les noms
 *    d'outils sont des chaînes statiques croisées avec GEN3IA_TOOLS par
 *    l'appelant (formatToolIntentSection reçoit les noms du catalogue).
 */

/** Indices d'intention produits par la détection déterministe. */
export interface ToolIntentHint {
  /** Identifiant stable de l'intention (ex. "video", "web_research"). */
  intent: string;
  /** Outils GEN3IA_TOOLS candidats, ORDONNÉS par préférence. */
  toolNames: string[];
  /** Justification courte injectée dans le prompt du planner. */
  rationale: string;
}

/** Fenêtre d'analyse : les objectifs longs sont tronqués (anti-dilution). */
const MAX_INTENT_SCAN_LENGTH = 2000;
/** Caps de sécurité : au plus 4 indices injectés dans le prompt. */
const MAX_HINTS = 4;

/* ────────────────────────────────────────────────────────────────────────
 * Marqueurs déterministes (FR + EN), regex linéaires (aucun quantificateur
 * imbriqué : uniquement \b + classes quantifiées une seule fois).
 * ──────────────────────────────────────────────────────────────────────── */

/** Garde commun : une question méta / curiosité ne déclenche PAS de
 * production implicite (miroir de video-intent.ts) — sauf impératif direct. */
const META_QUESTION_RE =
  /\b(c['']est quoi|qu['']est[- ]ce que|signifie|veut dire|diff[ée]rence entre|conseils?|astuces?|meilleur (?:logiciel|outil|fa[çc]on)|comment (?:fonctionne|marche))\b/i;
const QUESTION_PREFIX_RE =
  /^(c['']est quoi|qu['']est[- ]ce|pourquoi|comment |qui |o[ùu] |quand |est[- ]ce que|what|why|how|who|where|which)\b/i;
const DIRECT_IMPERATIVE_RE =
  /\b(cr[ée]e?s?|g[ée]n[èe]re[rz]?|fais|dessine|monte|lance)\s+(moi\s+)?(une?|un|la|le|des)\b/i;

/* VIDEO — créer/produire une vidéo, clip, reel, short, trailer, montage. */
const VIDEO_NOUN_RE =
  /\b(vid[ée]os?|videos?|clip|clips|reels?|shorts?|montage|montages|trailer|teaser|bande[- ]annonce|film|animation|pub vid[ée]o|vid[ée]o publicitaire)\b/i;
const VIDEO_CREATE_RE =
  /\b(cr[ée]\w*|g[ée]n[èe]r\w*|fais\w*|fabriqu\w*|produis\w*|produire|monte[rz]?|r[ée]alis\w*|lance[rz]?|veux|voudrais|aimerais|create|generate|produce|edit|render|make)\b/i;

/* IMAGE — dessine/génère image, photo, logo, affiche, illustration, poster. */
const IMAGE_NOUN_RE =
  /\b(images?|photos?|photographies?|dessins?|logos?|affiches?|posters?|illustrations?|banni[èe]res?|avatars?|ic[ôo]nes?|miniatures?|visuels?|fond d'[ée]cran|wallpaper)\b/i;
const IMAGE_CREATE_RE =
  /\b(dessin\w*|cr[ée]\w*|g[ée]n[èe]r\w*|fais\w*|veux|voudrais|aimerais|fabriqu\w*|illustr\w*|draw|create|generate|design|make)\b/i;
const DRAW_ALONE_RE = /\bdessin\w*\b/i;

/* VOICE — voix off, narration audio, text-to-speech. */
const VOICE_RE =
  /\b(voix off|narration (?:audio|vocal\w*|sonore)|synth[èe]se vocale|voix synth[ée]tique|text[- ]to[- ]speech|text to speech|tts|locution|lire (?:à|a) voix haute|version audio|g[ée]n[èe]r\w* (?:une |la |de la )?voix)\b/i;

/* EMAIL — envoyer un email (verbe + nom ou adresse énoncée). */
const EMAIL_VERB_RE = /\b(envoi\w*|envoy\w*|expedi\w*|send)\b/i;
const EMAIL_NOUN_RE = /\b(e[- ]?mails?|mails?|courriels?)\b/i;
const EMAIL_ADDRESS_RE = /[\w.+-]+@[\w-]+\.[\w-]{2,}/;

/* SCHEDULE — planifier, tâche récurrente, chaque jour/semaine. */
const SCHEDULE_RE =
  /\b(planifi\w*|programme[rz]?|schedul\w*|t[âa]che r[ée]current\w*|r[ée]current\w*|chaque (?:jour|semaine|mois|matin|soir|heure|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)|tous les (?:jours|lundis|mardis|mercredis|jeudis|vendredis|samedis|dimanches|mois|matins|soirs)|quotidienn\w*|hebdomadair\w*|mensuel\w*|every (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning))\b/i;

/* WORKFLOW — enchaînement d'automatisation. */
const WORKFLOW_RE =
  /\b(workflows?|automatis\w*|automatisation|encha[îi]n\w*|pipeline d'actions|sc[ée]nario d'automatisation)\b/i;

/* WEB_RESEARCH — recherche web/internet (verbe + cible). */
const RESEARCH_VERB_RE =
  /\b(recherch\w*|cherch\w*|trouv\w*|renseign\w*|surveill\w*|explor\w*|informe[- ]moi|documente[- ]toi|search|research|look ?up)\b/i;
const RESEARCH_TARGET_RE =
  /\b(web|internet|en ligne|google|actualit[ée]s?|news|concurrents?|concurrence|march[ée]|tendances?|nouveaut[ée]s?|prix|tarifs?|derni[èe]res? (?:infos|informations|nouvelles|versions?))\b/i;

/* PUBLISH_SOCIAL — publier sur TikTok/Instagram/Facebook/LinkedIn… */
const SOCIAL_VERB_RE = /\b(publi\w*|poste[rz]?|poster|partag\w*|diffus\w*|publish)\b/i;
const SOCIAL_TARGET_RE =
  /\b(tik[- ]?tok|instagram|facebook|linkedin|youtube|twitter|snapchat|pinterest|threads|r[ée]seaux? sociaux?|social media|stories?|page (?:facebook|linkedin))\b/i;

/* API_CALL — URL d'API énoncée, ou mot « API » + verbe d'appel. */
const API_WORD_RE = /\b(api|endpoints?|rest|graphql|webservice|web service)\b/i;
const API_VERB_RE =
  /\b(appel\w*|interrog\w*|requ[êe]t\w*|consomm\w*|r[ée]cup[èe]r\w*|fetch|call|query)\b/i;
const URL_RE = /https?:\/\/[^\s"'<>]{4,}/i;

/* KNOWLEDGE — chercher dans mes documents / base de connaissances. */
const KNOWLEDGE_RE =
  /\b(mes (?:documents?|fichiers?|notes?|docs?|archives?|donn[ée]es)|(?:la |ma |notre )?base de connaissances?|knowledge(?: ?base)?|documents? internes?|docs? internes?)\b/i;

/* FILE_ZIP — zip, archive (créer / extraire / analyser). */
const ZIP_RE = /\b(zips?|zipper|compres\w*|d[ée]compres\w*|archiv\w*|extraction|extraire)\b/i;
const ZIP_CREATE_RE = /\b(compres\w*|zipper|archiv\w*|cr[ée]\w*)\b/i;
const ZIP_EXTRACT_RE = /\b(d[ée]compres\w*|extraire|extraction|extract)\b/i;

/**
 * Une question méta / pure curiosité bloque la production implicite
 * (vidéo, image) SAUF si un impératif direct est présent
 * (« comment créer une vidéo ? » → non ; « crée-moi une vidéo » → oui).
 */
function blocksImplicitProduction(text: string): boolean {
  return (META_QUESTION_RE.test(text) || QUESTION_PREFIX_RE.test(text)) && !DIRECT_IMPERATIVE_RE.test(text);
}

/**
 * Détecte les intentions outils à haute confiance dans un objectif utilisateur
 * (détection déterministe FR+EN, scan borné aux 2000 premiers caractères,
 * max 4 indices). Aucun crash possible : l'entrée n'est jamais interprétée
 * au-delà de regex linéaires.
 */
export function detectToolIntents(objective: string): ToolIntentHint[] {
  const text = objective.trim().slice(0, MAX_INTENT_SCAN_LENGTH);
  if (!text) return [];

  const hints: ToolIntentHint[] = [];
  const push = (intent: string, toolNames: string[], rationale: string): void => {
    if (toolNames.length > 0 && !hints.some((hint) => hint.intent === intent)) {
      hints.push({ intent, toolNames, rationale });
    }
  };

  // VIDÉO : production complète réelle (script, visuels, voix, montage).
  if (VIDEO_NOUN_RE.test(text) && VIDEO_CREATE_RE.test(text) && !blocksImplicitProduction(text)) {
    push("video", ["video.create"], "La production vidéo complète (script, visuels, voix, musique, montage) est lancée et suivie par video.create — jamais une réponse textuelle seule.");
  }

  // IMAGE : visuel réellement généré (jamais répondu par du texte seul).
  const imageMatch = (IMAGE_NOUN_RE.test(text) && IMAGE_CREATE_RE.test(text)) || DRAW_ALONE_RE.test(text);
  if (imageMatch && !blocksImplicitProduction(text)) {
    push("image", ["image.generate"], "Tout visuel demandé (image, photo, logo, affiche) doit être réellement généré via image.generate, jamais répondu par du texte seul.");
  }

  // VOICE : synthèse vocale réelle.
  if (VOICE_RE.test(text)) {
    push("voice", ["voice.speak", "voice.list"], "L'audio réel est synthétisé par voice.speak (voice.list pour explorer les profils de voix disponibles).");
  }

  // EMAIL : verbe d'envoi + (nom email OU adresse énoncée).
  if (EMAIL_VERB_RE.test(text) && (EMAIL_NOUN_RE.test(text) || EMAIL_ADDRESS_RE.test(text))) {
    push("email", ["email.send"], "L'envoi réel est exécuté par le serveur via email.send — n'utilise que l'adresse énoncée par l'utilisateur.");
  }

  // SCHEDULE : planification / récurrence explicite.
  if (SCHEDULE_RE.test(text)) {
    push("schedule", ["schedule.create"], "Une tâche récurrente se matérialise par schedule.create (planification réelle) plutôt qu'une promesse textuelle.");
  }

  // WORKFLOW : enchaînement d'automatisation explicite.
  if (WORKFLOW_RE.test(text)) {
    push("workflow", ["workflow.create"], "Un enchaînement d'automatisation se matérialise par workflow.create (graphe multi-étapes réel).");
  }

  // WEB_RESEARCH : verbe de recherche + cible d'information actuelle.
  if (RESEARCH_VERB_RE.test(text) && RESEARCH_TARGET_RE.test(text)) {
    push("web_research", ["web.search", "web.open"], "Une information actuelle exige une vraie recherche web (web.search, puis web.open pour lire une page), jamais une réponse de mémoire.");
  }

  // PUBLISH_SOCIAL : verbe de publication + plateforme sociale énoncée.
  if (SOCIAL_VERB_RE.test(text) && SOCIAL_TARGET_RE.test(text)) {
    push("publish_social", ["social.publish"], "La publication sur une plateforme sociale passe par social.publish via connecteur — action externe soumise à validation humaine.");
  }

  // API_CALL : URL d'API énoncée, ou mot « API » + verbe d'appel.
  if ((API_WORD_RE.test(text) || URL_RE.test(text)) && API_VERB_RE.test(text)) {
    push("api_call", ["web.api", "custom_api.call"], "Une URL d'API énoncée s'appelle réellement via web.api (custom_api.call si l'API personnelle est nommée) — le serveur exécute l'appel HTTP.");
  }

  // KNOWLEDGE : verbe de recherche + documents/connaissances de l'utilisateur.
  if (RESEARCH_VERB_RE.test(text) && KNOWLEDGE_RE.test(text)) {
    push("knowledge", ["knowledge.search"], "Les documents de l'utilisateur se retrouvent via knowledge.search (recherche vectorielle indexée) — jamais inventés.");
  }

  // FILE_ZIP : archive explicite — candidats ordonnés selon l'opération.
  if (ZIP_RE.test(text)) {
    const zipTools: string[] = [];
    if (ZIP_CREATE_RE.test(text)) zipTools.push("zip.create");
    if (ZIP_EXTRACT_RE.test(text)) zipTools.push("zip.extract");
    if (zipTools.length === 0) zipTools.push("zip.analyze");
    push("file_zip", zipTools, "Les archives se manipulent réellement : zip.create pour compresser, zip.extract pour extraire, zip.analyze pour analyser sans risque.");
  }

  return hints.slice(0, MAX_HINTS);
}

/* ────────────────────────────────────────────────────────────────────────
 * Formatage de la section prompt (FR) — consignes d'auto-sélection.
 * ──────────────────────────────────────────────────────────────────────── */

/** Libellés FR lisibles injectés dans le prompt (clé = intent). */
const INTENT_LABELS: Record<string, string> = {
  video: "création d'une vidéo",
  image: "création d'un visuel (image/photo/logo)",
  voice: "génération d'une voix / audio",
  email: "envoi d'un email",
  schedule: "planification d'une tâche récurrente",
  workflow: "automatisation multi-étapes (workflow)",
  web_research: "recherche d'information sur le web",
  publish_social: "publication sur les réseaux sociaux",
  api_call: "appel d'une API",
  knowledge: "recherche dans les documents / connaissances",
  file_zip: "manipulation d'une archive ZIP",
};

/**
 * Formate la section « SÉLECTION AUTOMATIQUE DES OUTILS » pour le prompt du
 * planner. Renvoie "" si aucun indice : la section est alors totalement
 * absente du prompt (pas de bruit).
 *
 * - hint dont AU MOINS UN toolName ∈ catalogNames → consigne d'outil explicite
 *   (premier candidat disponible, ordre de préférence respecté) ;
 * - hint sans aucun outil dans le catalogue effectif → mention d'indisponibilité,
 *   AUCUNE consigne d'outil (ni nom d'outil cité) : le planner ne force rien ;
 * - règle générale rappelée en fin de section : c'est l'AGENT qui choisit.
 */
export function formatToolIntentSection(hints: readonly ToolIntentHint[], catalogNames: Iterable<string>): string {
  if (!hints || hints.length === 0) return "";
  const available = new Set(catalogNames);
  const lines: string[] = [
    "SÉLECTION AUTOMATIQUE DES OUTILS — INDICES D'INTENTION (détection déterministe, à confronter au catalogue effectif) :",
  ];
  for (const hint of hints) {
    const label = INTENT_LABELS[hint.intent] ?? hint.intent;
    const candidate = hint.toolNames.find((name) => available.has(name));
    if (candidate) {
      lines.push(`- La demande ressemble à « ${label} » → privilégie une étape type "tool" avec toolName="${candidate}" (input conforme au catalogue). ${hint.rationale}`);
    } else {
      lines.push(`- La demande évoque « ${label} », mais l'outil correspondant est INDISPONIBLE dans le catalogue effectif : ne force rien, réponds au mieux avec les capacités disponibles.`);
    }
  }
  lines.push("RÈGLE GÉNÉRALE : l'utilisateur ne désigne JAMAIS l'outil : c'est TOI qui choisis l'outil le plus adapté (ou une réponse directe si aucun outil n'est nécessaire). Ne force un outil QUE si la demande l'appelle réellement.");
  return lines.join("\n");
}
