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
const META_QUESTION_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])c[''’]est quoi|qu[''’]est[- ]ce que|signifie|veut dire|diff[ée]rence entre|conseils?|astuces?|meilleur (?:logiciel|outil|fa[çc]on)|comment (?:fonctionne|marche)(?![\\p{L}\\p{N}_])`,
  "iu",
);
const QUESTION_PREFIX_RE = new RegExp(
  `^(?:c[''’]est quoi|qu[''’]est[- ]ce|pourquoi|comment|qui|o[ùu]|quand|est[- ]ce que|what|why|how|who|where|which)(?![\\p{L}\\p{N}_])`,
  "iu",
);
const DIRECT_IMPERATIVE_RE = new RegExp(
  `(?<![\p{L}\p{N}_])(?:cr[ée](?:[ée]s?|ez)?|g[éèe]n[éèe]r(?:é[ée]?s?|e[zs]?|ez)?|fais(?:ez)?|dessin(?:e[zs]?|é[ée]?s?)|mont(?:e[zs]?|é[ée]?s?)|lanc(?:é[ée]?s?|e[zs]?|ez)?)\s+(?:moi\s+)?(?:une?|un|la|le|des)(?![\p{L}\p{N}_])`,
  "iu",
);

/* VIDEO — créer/produire une vidéo, clip, reel, short, trailer, montage. */
const VIDEO_NOUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])vid[ée]os?|videos?|clip|clips|reels?|shorts?|montages?|trailer|teaser|bande[- ]annonce|film|animation|pub vid[ée]o|vid[ée]o publicitaire(?![\\p{L}\\p{N}_])`,
  "iu",
);
const VIDEO_CREATE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])cr[ée]\\p{L}*|g[éèe]n[éèe]r\\p{L}*|fais\\p{L}*|fabriqu\\p{L}*|produi\\p{L}*|monte[rz]?|mont[ée]\\p{L}*|r[ée]alis\\p{L}*|lanc[ée]\\p{L}*|lance[rz]?|veux|voudrais|aimerais|create|generate|produce|edit|render|make(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* TERMINAL — exécution explicite d'une commande / shell (Task 122). */
const TERMINAL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:terminal|shell|bash|ligne de commande|commande shell|ex[ée]cut(?:er|e|é|ée|ées|ion)(?:[- ]moi)?\\s+(?:la|le|une?|un|cette|ce)?\\s*commande)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* ── Task 140 — marqueurs de la SUITE « OUTILS PILOTÉS PAR LES AGENTS IA ».
   Regex linéaires (aucun quantificateur imbriqué), garde-fous identiques. */

/* HANDOVER — reprise de relais humain d'une conversation IA. */
const HANDOVER_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:pass(?:age|er) (?:de|en) relais|reprend(?:s|re|rz)? (?:la|cette|mon)? ?(?:main|conversation)|pr[ée]pare?[- ](?:moi )?(?:le|la|un)? ?(?:relais|passage de t[ée]moin)|brief de relais|handover|r[ée]sum[ée] de reprise|fiche de reprise|prise en main humaine|reprendre le client)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* REGISTRY_FIND — package/bibliothèque à vérifier, comparer, installer
   (détection en deux parties : nom de package + intention de vérification —
   miroir du style verbe+nom des sections EMAIL / WEB_RESEARCH). */
const PACKAGE_NOUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:packages?|librairies?|libs?|biblioth[èe]qu\\p{L}*|d[ée]pendanc\\p{L}*|npm|pypi|modules?|d[ée]p[ôo]ts? npm)(?![\\p{L}\\p{N}_])`,
  "iu",
);
const PACKAGE_CHECK_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:v[ée]rifi\\p{L}*|existe|exist\\p{L}*|dispo\\p{L}*|obsol[èe]t\\p{L}*|derni[èe]re? version|version (?:la )?plus r[ée]cent\\p{L}*|encore (?:maintenu|utilis\\p{L}*)|compare\\p{L}*|quell?e? (?:librairie|lib|package|version))(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* BUILD_AUTOFIX — log de build en échec à corriger (dépôt GitHub). */
const BUILD_AUTOFIX_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:corrige[- ](?:moi )?(?:ce|le|cette)? ?(?:build|log d'erreur|log)|build (?:qui )?[ée]chou\\p{L}*|[ée]chec de build|log d'erreur|error TS\\d|failed to compile|module not found|corrige (?:l'erreur|les erreurs)|fix (?:the )?(?:build|error|failing)|pull request (?:corrective|de correction)|r[ée]pare[- ](?:moi )?(?:le|ce|la)? ?(?:build|d[ée]p[ôo]t|repo))(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* SIMULATION — test utilisateur par personas / parcours stress-testé. */
const SIMULATION_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:simul\\p{L}*|persona|personas|faux? (?:utilisateurs?|clients?)|utilisateurs? (?:fictifs?|simul[ée]s?|test\\p{L}*)|test(?:er|e[- ]moi)? (?:l'|le |la |mon |notre )?(?:interface|parcours|tunnel|page d'accueil|inscription|checkout)|stress[- ]test\\p{L}*|audit d'utilisabilit\\p{L}*|recette utilisateurs?)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* TRANSCRIPT_REDACT — anonymisation / masquage de données sensibles. */
const REDACT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:anonymis\\p{L}*|masqu\\p{L}* (?:les? |la? |l')?(?:donn[ée]es|infos?|num[ée]ro|carte|iban|t[ée]l[ée]phone)|censur\\p{L}*|effac\\p{L}* (?:les? |la? )?(?:donn[ée]es|coordonn[ée]es)|rend\\p{L}* (?:anonyme|confidentiel)|masque?[- ](?:moi )?(?:ce|le|la|les)? ?(?:transcript|transcription)|scrub|redact|r[ée]dact\\p{L}* (?:les? )?donn[ée]es)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* DECISION — décision probabiliste chiffrée (options, probabilités, risques). */
const DECISION_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:esp[ée]rance de gain|probabilit\\p{L}* de|quelle? (?:option|d[ée]cision|choix) (?:est |choisir|retenir)|vaut[- ]il mieux (?:miser|prendre|choisir)|rapport risque|prise de risque|VaR|CVaR|Monte[- ]Carlo|sc[ée]narios? probabilis\\p{L}*|analyse (?:de )?risque|risque r[ée]compense|quel pari|quelles? (?:chances?|odds))(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* WATCHDOG — surveillance des changements d'une page / d'un concurrent. */
const WATCHDOG_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:surveill\\p{L}* (?:les? |la? |l'|ce|cette)? ?(?:changements?|modifications?|page|site|prix|concurrent|offre)|veille (?:sur|strat[ée]gique)|alerte[- ]moi (?:si|d[èe]s)|pr[ée]viens[- ]moi (?:si|d[èe]s)|notifi\\p{L}* (?:si|d[èe]s)|d[ée]tect\\p{L}* (?:les? )?changements?|watchdog|change monitoring)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* IMAGE — dessine/génère image, photo, logo, affiche, illustration, poster. */
const IMAGE_NOUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])images?|photos?|photographies?|dessins?|logos?|affiches?|posters?|illustrations?|banni[èe]res?|avatars?|ic[ôo]nes?|miniatures?|visuels?|fond d'[ée]cran|wallpaper(?![\\p{L}\\p{N}_])`,
  "iu",
);
const IMAGE_CREATE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])dessin\\p{L}*|cr[ée]\\p{L}*|g[éèe]n[éèe]r\\p{L}*|fais\\p{L}*|veux|voudrais|aimerais|fabriqu\\p{L}*|illustr\\p{L}*|draw|create|generate|design|make(?![\\p{L}\\p{N}_])`,
  "iu",
);
const DRAW_ALONE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])dessin\\p{L}*(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* VOICE — voix off, narration audio, text-to-speech. */
const VOICE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])voix[- ]off|narration (?:audio|vocal\\p{L}*|sonore)|synth[èe]se vocale|voix synth[ée]tique|text[- ]to[- ]speech|text to speech|tts|locution|lire (?:à|a) voix haute|version audio|g[éèe]n[éèe]r\\p{L}* (?:une |la |de la |de l' )?voix(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* EMAIL — envoyer un email (verbe + nom ou adresse énoncée). */
const EMAIL_VERB_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])envoi\\p{L}*|envoy\\p{L}*|expedi\\p{L}*|send(?![\\p{L}\\p{N}_])`,
  "iu",
);
const EMAIL_NOUN_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])e[- ]?mails?|mails?|courriels?(?![\\p{L}\\p{N}_])`,
  "iu",
);
const EMAIL_ADDRESS_RE = /[\w.+-]+@[\w-]+\.[\w-]{2,}/;

/* SCHEDULE — planifier, tâche récurrente, chaque jour/semaine. */
const SCHEDULE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])planifi\\p{L}*|programme[rz]?|schedul\\p{L}*|t[âa]che r[ée]current\\p{L}*|r[ée]current\\p{L}*|chaque (?:jour|semaine|mois|matin|soir|heure|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)|tous les (?:jours|lundis|mardis|mercredis|jeudis|vendredis|samedis|dimanches|mois|matins|soirs)|quotidienn\\p{L}*|hebdomadair\\p{L}*|mensuel\\p{L}*|every (?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* WORKFLOW — enchaînement d'automatisation. */
const WORKFLOW_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])workflows?|automatis\\p{L}*|automatisation|encha[îi]n\\p{L}*|pipeline d'actions|sc[ée]nario d'automatisation(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* WEB_RESEARCH — recherche web/internet (verbe + cible). */
const RESEARCH_VERB_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])recherch\\p{L}*|cherch\\p{L}*|trouv\\p{L}*|renseign\\p{L}*|surveill\\p{L}*|explor\\p{L}*|informe[- ]moi|documente[- ]toi|search|research|look ?up(?![\\p{L}\\p{N}_])`,
  "iu",
);
const RESEARCH_TARGET_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])web|internet|en ligne|google|actualit[ée]s?|news|concurrents?|concurrence|march[ée]|tendances?|nouveaut[ée]s?|prix|tarifs?|derni[èe]res? (?:infos|informations|nouvelles|versions?)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* PUBLISH_SOCIAL — publier sur TikTok/Instagram/Facebook/LinkedIn… */
const SOCIAL_VERB_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])publi\\p{L}*|poste[rz]?|poster|partag\\p{L}*|diffus\\p{L}*|publish(?![\\p{L}\\p{N}_])`,
  "iu",
);
const SOCIAL_TARGET_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])tik[- ]?tok|instagram|facebook|linkedin|youtube|twitter|snapchat|pinterest|threads|r[ée]seaux? sociaux?|social media|stories?|page (?:facebook|linkedin)(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* API_CALL — URL d'API énoncée, ou mot « API » + verbe d'appel. */
const API_WORD_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])api|endpoints?|rest|graphql|webservice|web service(?![\\p{L}\\p{N}_])`,
  "iu",
);
const API_VERB_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])appel\\p{L}*|interrog\\p{L}*|requ[êe]t\\p{L}*|consomm\\p{L}*|r[ée]cup[éèe]r\\p{L}*|fetch|call|query(?![\\p{L}\\p{N}_])`,
  "iu",
);
const URL_RE = /https?:\/\/[^\s"'<>]{4,}/i;

/* KNOWLEDGE — chercher dans mes documents / base de connaissances. */
const KNOWLEDGE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])mes (?:documents?|fichiers?|notes?|docs?|archives?|donn[ée]es)|(?:la |ma |notre )?base de connaissances?|knowledge(?: ?base)?|documents? internes?|docs? internes?(?![\\p{L}\\p{N}_])`,
  "iu",
);

/* FILE_ZIP — zip, archive (créer / extraire / analyser). */
const ZIP_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])zips?|zipper|compres\\p{L}*|d[ée]compres\\p{L}*|archiv\\p{L}*|extraction|extraire(?![\\p{L}\\p{N}_])`,
  "iu",
);
const ZIP_CREATE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])compres\\p{L}*|zipper|archiv\\p{L}*|cr[ée]\\p{L}*(?![\\p{L}\\p{N}_])`,
  "iu",
);
const ZIP_EXTRACT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])d[ée]compres\\p{L}*|extraire|extraction|extract(?![\\p{L}\\p{N}_])`,
  "iu",
);

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

  // TERMINAL (Task 122) : exécution RÉELLE d'une commande dans le terminal
  // intégré — l'agent dispose enfin d'un outil exécutable au registre.
  if (TERMINAL_RE.test(text)) {
    push("terminal", ["terminal.run"], "L'exécution réelle de commandes passe par terminal.run (terminal agent encadré : deny-list, limites temps/mémoire/sortie, mode d'exécution renvoyé honnêtement).");
  }

  // ── Task 140 — indices d'intention de la SUITE « OUTILS PILOTÉS PAR LES
  // AGENTS IA » (détection déterministe, mêmes garde-fous : regex linéaires,
  // max 4 indices au total).

  // HANDOVER : reprise en main humaine d'une conversation IA (relais).
  if (HANDOVER_RE.test(text)) {
    push("handover", ["handover.compose"], "Une reprise de relais humain exige un brief structuré réel (intention, état émotionnel, blocages, données collectées) produit par handover.compose, jamais un résumé improvisé.");
  }

  // REGISTRY_FIND : package/bibliothèque à vérifier ou comparer (nom + intention).
  if (PACKAGE_NOUN_RE.test(text) && PACKAGE_CHECK_RE.test(text)) {
    push("registry_find", ["registry.find"], "Toute recommandation de package/bibliothèque doit être vérifiée EN DIRECT (existence, version, fraîcheur, dépréciation) via registry.find — jamais de mémoire.");
  }

  // BUILD_AUTOFIX : log de build en erreur + dépôt GitHub à corriger.
  if (BUILD_AUTOFIX_RE.test(text)) {
    push("build_autofix", ["build.autofix"], "Un log de build en échec sur un dépôt GitHub se corrige par build.autofix (localisation de la ligne fautive, correctif écrit, pull request créée automatiquement).");
  }

  // SIMULATION : test utilisateur / personas / parcours stress-testé.
  if (SIMULATION_RE.test(text)) {
    push("simulation", ["simulation.run"], "Le test de parcours par des utilisateurs simulés (personas novice/hacker/acheteur pressé…) se matérialise par simulation.run avec rapport de bugs comportementaux persisté.");
  }

  // TRANSCRIPT_REDACT : anonymisation / masquage de données sensibles.
  if (REDACT_RE.test(text)) {
    push("transcript_redact", ["transcript.redact"], "Le masquage de données sensibles (cartes, mots de passe, IBAN, téléphones) s'effectue via transcript.redact — déterministe et fiable, jamais à la main.");
  }

  // DECISION : comparaison d'options probabilistes / pari / risque chiffré.
  if (DECISION_RE.test(text)) {
    push("decision", ["decision.analyze"], "Toute décision sous incertitude chiffrable (probabilités, gains/pertes) passe par decision.analyze (espérance, Monte-Carlo, VaR/CVaR, recommandation) — jamais un calcul mental.");
  }

  // WATCHDOG : surveillance des changements d'une page stratégique.
  if (WATCHDOG_RE.test(text)) {
    push("watchdog", ["watchdog.track"], "La surveillance d'une page (changements stratégiques vs cosmétiques) s'enregistre et se vérifie via watchdog.track — pas de re-vérification manuelle.");
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
  terminal: "exécution d'une commande dans le terminal intégré",
  // Task 140 — suite « outils pilotés par les agents IA ».
  handover: "brief de relais IA vers humain",
  registry_find: "vérification de packages en direct",
  build_autofix: "auto-correction d'un build en échec",
  simulation: "simulation d'utilisateurs (personas)",
  transcript_redact: "masquage de données sensibles",
  decision: "décision probabiliste chiffrée",
  watchdog: "veille des changements d'une page",
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
