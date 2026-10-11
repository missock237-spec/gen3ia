/**
 * DÉTECTION DE DEMANDE DE CODE (Task 121) — routage déterministe (zéro
 * variance LLM) vers l'agent de code Jules de Google (jules.google).
 *
 * Miroir de `lib/ai/video-intent.ts` (looksLikeVideoRequest) : verbe
 * d'écriture/correction + nom de code (fonction, composant, bug, feature…).
 * Garde-fous :
 *  - les demandes VIDÉO / AUDIO / IMAGE / GRAPHIQUE gardent la priorité sur
 *    leurs intercepts dédiés (amont du moteur, détections propres) ;
 *  - les demandes de PAGES/SITES web SANS dépôt restent routées vers
 *    l'artefact application (détection amont) — Jules ne prend le relais QUE
 *    pour travailler sur une BASE DE CODE réelle (dépôt GitHub nommé) ;
 *  - les questions méta (« comment créer une fonction ? », « c'est quoi un
 *    bug ? ») ne déclenchent PAS de session Jules ;
 *  - FR + EN, frontières unicode \p{L} (les verbes français accentués
 *    « créé », « implémenté » ne cassent plus les garde-fous).
 *
 * Module PUR : aucune dépendance, aucun import — directement testable.
 */

/* ────────────────────────────────────────────────────────────────────────
 * FRONTIÈRES DE MOT UNICODE (même cause racine que video-intent.ts) :
 * `\b` et `\w` sont ASCII, « é »/« è »/« à » n'en font pas partie → tous
 * les garde-fous utilisent \p{L}/\p{N} avec le flag `u`.
 * ──────────────────────────────────────────────────────────────────────── */

/** Garde-fou gauche : le caractère précédent n'est PAS une lettre/chiffre. */
const U_START = "(?<![\\p{L}\\p{N}_])";
/** Garde-fou droit : le caractère suivant n'est PAS une lettre/chiffre. */
const U_END = "(?![\\p{L}\\p{N}_])";

/** Verbes de CODE (FR + EN) — écrire, corriger, refactorer, implémenter… */
const CODE_VERB_RE = new RegExp(
  `${U_START}(?:[ée]cris|[ée]crit|[ée]crire|[ée]crivez|cr[ée][eé]?[sr]?|cr[ée]ons|d[ée]veloppe\\p{L}*|corrige\\p{L}*|r[ée]pare\\p{L}*|r[ée]gl\\p{L}*|r[ée]sous|refactor\\p{L}*|impl[ée]mente\\p{L}*|modifi\\p{L}*|ajout\\p{L}*|rajout\\p{L}*|supprim\\p{L}*|cod\\p{L}*|programm\\p{L}*|compl[èe]t\\p{L}*|am[ée]lior\\p{L}*|optimis\\p{L}*|migr\\p{L}*|document\\p{L}*|test\\p{L}*|write|writes|wrote|writing|build|builds|fix|fixes|fixing|fixed|create|creates|develop|develops|refactor|refactors|implement|implements|modify|modifies|change|changes|update|updates|add|adds|remove|removes|patch|patches)${U_END}`,
  "iu",
);

/** Verbes FAIBLES (intention sans impératif : « je veux », « j'aimerais »). */
const WEAK_CODE_VERB_RE = new RegExp(
  `${U_START}(?:veux|voudrais|aimerais|souhait\\p{L}*|besoin|need|want|would like)${U_END}`,
  "iu",
);

/** Travail sur un dépôt (FR + EN) — combiné au dépôt GitHub nommé. */
const WORK_ON_VERB_RE = new RegExp(
  `${U_START}(?:travaille\\p{L}*|travaillons|work on|works on|working on)${U_END}`,
  "iu",
);

/** Noms de CODE (FR + EN) — la demande porte sur une base de code réelle. */
const CODE_NOUN_RE = new RegExp(
  `${U_START}(?:fonctions?|functions?|fonctionnalit[ée]s?|features?|composants?|components?|pages?|sites?|apps?|applications?|scripts?|bugs?|fixes?|apis?|endpoints?|modules?|modulaires?|classes?|tests?|unit[ée]s? de test|services?|routes?|middlewares?|hooks?|utilitaires?|librairies?|libraries?|biblioth[èe]ques?|migrations?|requ[êe]tes?|algorithmes?|algorithms?|regex|expressions r[ée]guli[èe]res?|d[ée]p[ôo]ts?|depots?|repos?|repositories?|repository|branches?|pull requests?|merge requests?|commits?|code|codebases?|source|backend|front[- ]end|frontend|full[- ]stack|typescript|javascript|python|react|vue|angular|svelte|node(?:\\.js)?|express|next\\.?js|nestjs?|django|flask|fastapi|laravel|symfony|spring|kotlin|golang|rust|java|c\\+\\+|c#|\\.net|php|ruby|rails)${U_END}`,
  "iu",
);

/**
 * Contexte PAGES/SITES web SANS dépôt : routage artefact application (détection
 * amont de video-intent / artefact-apps) — Jules ne prend le relais QUE si un
 * dépôt GitHub est explicitement nommé (composés spécifiques, comme
 * video-intent.ts : une « page de login » à corriger vit DANS un dépôt).
 */
const WEB_APP_CONTEXT_RE = new RegExp(
  `${U_START}(?:page (?:web|d[''’]accueil|de vente|internet)|site (?:web|internet|vitrine)|landing|application (?:web|mobile)|web app|html|site avec|page avec)${U_END}`,
  "iu",
);

/** Demandes MÉDIAS/GRAPHIQUES : priorité aux autres intents (jamais Jules). */
const MEDIA_REQUEST_RE = new RegExp(
  `${U_START}(?:vid[ée]os?|videos?|clips?|reels?|shorts?|montages?|trailer|teaser|bande[- ]annonce|film|voix[- ]off|voix off|narration audio|synth[èe]se vocale|text[- ]to[- ]speech|tts|audio|podcast|son(?:s)? de|images?|photos?|logos?|affiches?|posters?|illustrations?|dessins?|banni[èe]res?|miniatures?|avatars?|graphiques?|graphes?|charts?|diagrammes?|courbes?|histogrammes?|camemberts?|pie chart|visualisation)${U_END}`,
  "iu",
);

/** Amorce interrogative : une pure question méta ne déclenche pas Jules. */
const QUESTION_PREFIX_RE = new RegExp(
  `^(?:c[''’]est quoi|qu[''’]est[- ]ce|pourquoi|comment|qui (?:est|a)|o[ùu]|quand|quel(?:le)?s?(?:\\s+\\p{L}+){0,4}|est[- ]ce que|peux[- ]tu m[''’]expliquer|what|why|how|who|where|which)${U_END}`,
  "iu",
);

/** Question méta SUR le sujet code (curiosité, pas une commande). */
const META_QUESTION_RE = new RegExp(
  `${U_START}(?:c[''’]est quoi|qu[''’]est[- ]ce que|signifie|veut dire|diff[ée]rence|comment (?:fonctionne|marche|faire|cr[ée]er|[ée]crire))${U_END}`,
  "iu",
);

/** Impératif RENFORCÉ (miroir video-intent) : « écris-moi une… », « fix the… ». */
const REINFORCED_IMPERATIVE_RE = new RegExp(
  `${U_START}(?:[ée]cris|cr[ée]e|corrige|refactor[es]?|impl[ée]mente|modifi[es]?|d[ée]veloppe|cod[es]?|r[ée]par[es]?|fix(?:e[sz]?)?|build|write|implement)\\s+(?:moi\\s+)?(?:une?|la|le|les|des|un|the|a|an)${U_END}`,
  "iu",
);

/** Réponse qui annule le suivi contextuel (« non », « annule », « stop »…). */
const REFUSAL_RE = new RegExp(
  `^(?:non|nan|annul\\p{L}*|stop|laisse\\p{L}*|oubli\\p{L}*|finalement|en fait|jamais mind|never mind|cancel)${U_END}`,
  "iu",
);

/* ────────────────────────────────────────────────────────────────────────
 * DÉPÔT GITHUB — extraction owner/repo (URL complète ou format nu).
 * ──────────────────────────────────────────────────────────────────────── */

/** Parties de dépôt qu'un humain n'écrira jamais comme owner/repo (faux positifs « km/h », « 24/7 »…). */
const REPO_PART_STOPWORDS = new Set([
  "a", "and", "or", "the", "sur", "dans", "pour", "avec", "env", "vs", "km", "kg",
  "mois", "jours", "heures", "minutes", "secondes", "ex", "exemple", "http", "https", "www",
]);

/** URL GitHub : github.com/owner/repo (optionnel .git et chemin final). */
const GITHUB_URL_RE = /github\.com\/([A-Za-z0-9][A-Za-z0-9-_.]{0,60})\/([A-Za-z0-9][A-Za-z0-9-_.]{0,100}?)(?:\.git)?(?:[/?#\s]|$)/i;

/** Format nu owner/repo dans une phrase (« corrige le bug dans acme/api »). */
const BARE_REPO_RE = /(?<![\p{L}\p{N}\/_.@-])([A-Za-z][A-Za-z0-9-_.]{0,60})\/([A-Za-z][A-Za-z0-9-_.]{0,100}?)(?:\.git)?(?![\p{L}\p{N}\/_.-])/gu;

export interface GithubRepo {
  owner: string;
  repo: string;
}

/** Extrait un dépôt GitHub d'un texte (URL complète prioritaire, sinon owner/repo nu). */
export function extractGithubRepo(text: string): GithubRepo | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(GITHUB_URL_RE);
  if (urlMatch?.[1] && urlMatch[2]) {
    return { owner: urlMatch[1], repo: urlMatch[2].replace(/\.git$/, "") };
  }

  for (const match of trimmed.matchAll(BARE_REPO_RE)) {
    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo) continue;
    // Faux positifs usuels : unités (« km/h »), conjonctions (« and/or »),
    // dates — chaque partie doit être un identifiant GitHub plausible.
    if (REPO_PART_STOPWORDS.has(owner.toLowerCase()) || REPO_PART_STOPWORDS.has(repo.toLowerCase())) continue;
    if (owner.length < 2 || repo.length < 2) continue;
    return { owner, repo: repo.replace(/\.git$/, "") };
  }
  return null;
}

/* ────────────────────────────────────────────────────────────────────────
 * DÉTECTION PRINCIPALE
 * ──────────────────────────────────────────────────────────────────────── */

/** Niveau de confiance du routage Jules. */
export type CodeRequestConfidence = "high" | "medium" | "low";

/** Résultat de la détection d'une demande de code. */
export interface CodeRequestDetection {
  /** true = la demande doit être routée vers Jules (après clarification du dépôt si besoin). */
  isCodeRequest: boolean;
  /** "high" = verbe fort ou dépôt nommé ; "medium" = verbe faible + nom ; "low" = pas une demande de code. */
  confidence: CodeRequestConfidence;
  /** La demande reformulée pour Jules (bornée) — vide si pas une demande de code. */
  promptExtraction: string;
  /** Dépôt GitHub présent dans la demande, sinon absent (clarification requise). */
  repo?: GithubRepo;
}

/** Longueur maximale du prompt transmis à Jules (contrat API : 10 000 — borne conservative). */
const MAX_JULES_PROMPT_LENGTH = 4_000;

/** Nettoyage des formules de politesse/annonce (le prompt Jules garde le cœur technique). */
const POLITENESS_PREFIX_RE =
  /^(?:\s*(?:bonjour|salut|hello|hi|hey|coucou|re)[\s,!.;:–—-]*)+/i;

/** Préfixes de demande (« peux-tu », « est-ce que tu peux »…). */
const REQUEST_PREFIX_RE =
  /^(?:\s*(?:peux[- ]tu|pourrais[- ]tu|pourriez[- ]tu|tu peux|est[- ]ce que tu peux|s[''’]il te pla[îi]t|s[''’]il vous pla[îi]t|svp|please|pls|stp|merci de|merci d[''’]avance)[\s,:.!-]*)+/i;

/** Politesse en fin de demande (« stp », « please »…) — retirée du prompt. */
const TRAILING_POLITENESS_RE =
  /[\s,]*(?:stp|svp|please|pls|s[''’]il (?:te|vous) pla[îi]t|merci d[''’]avance)[\s,!.?]*$/iu;

/**
 * Reformule la demande pour Jules : formules d'adresse et politesse
 * retirées, espaces normalisés, longueur bornée.
 */
export function extractCodePrompt(text: string): string {
  const cleaned = text
    .replace(POLITENESS_PREFIX_RE, "")
    .replace(REQUEST_PREFIX_RE, "")
    .replace(TRAILING_POLITENESS_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, MAX_JULES_PROMPT_LENGTH);
}

/**
 * Le message exprime-t-il une demande de DÉVELOPPEMENT sur une base de code ?
 * (usage moteur : court-circuit déterministe vers Jules, après les
 * intercepts vidéo/audio et avant l'artefact application).
 */
export function looksLikeCodeRequest(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 6) return false;
  const lower = trimmed.toLowerCase();

  // Priorité aux autres intents : vidéo, voix/audio, image, graphique.
  if (MEDIA_REQUEST_RE.test(lower)) return false;
  // Question méta SANS impératif renforcé : curiosité, pas une commande
  // (« je me demande c'est quoi un bug ? ») — miroir video-intent.ts.
  if (META_QUESTION_RE.test(lower) && !REINFORCED_IMPERATIVE_RE.test(lower)) return false;
  // Amorce interrogative : une question ne lance jamais de session Jules
  // (« comment écrire une fonction ? », « How do I write…? »).
  if (QUESTION_PREFIX_RE.test(trimmed)) return false;

  const repo = extractGithubRepo(trimmed);
  const hasVerb = CODE_VERB_RE.test(lower) || WEAK_CODE_VERB_RE.test(lower) || WORK_ON_VERB_RE.test(lower);
  const hasNoun = CODE_NOUN_RE.test(lower);

  // Dépôt GitHub nommé + verbe : travail sur une base de code réelle —
  // même si la demande mentionne une « page »/« app » (elle vit DANS le dépôt).
  if (repo && hasVerb) return true;

  // Contexte pages/sites web SANS dépôt : artefact application (amont).
  if (WEB_APP_CONTEXT_RE.test(lower) && !repo) return false;

  return hasVerb && hasNoun;
}

/** Détection complète : demande, confiance, prompt Jules et dépôt éventuel. */
export function detectCodeRequest(text: string): CodeRequestDetection {
  const trimmed = text.trim();
  if (!trimmed || !looksLikeCodeRequest(trimmed)) {
    return { isCodeRequest: false, confidence: "low", promptExtraction: "" };
  }
  const lower = trimmed.toLowerCase();
  const repo = extractGithubRepo(trimmed);
  const strongVerb = CODE_VERB_RE.test(lower);
  const confidence: CodeRequestConfidence = repo || strongVerb ? "high" : "medium";
  return {
    isCodeRequest: true,
    confidence,
    promptExtraction: extractCodePrompt(trimmed),
    ...(repo ? { repo } : {}),
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * SUIVI CONTEXTUEL (miroir resolveVoiceRequestFromContext) :
 *  - l'assistant pose la question de clarification DÉTERMINISTE « Sur quel
 *    dépôt GitHub dois-je travailler ? » ; la réponse de l'utilisateur
 *    (owner/repo) est reliée à la demande de code d'origine ;
 *  - l'avis « intégration Jules en préparation » (clé absente) n'est JAMAIS
 *    répété en boucle : le message suivant retombe dans le flux normal
 *    (l'agent traite la demande via ses outils internes).
 * ──────────────────────────────────────────────────────────────────────── */

export interface CodeHistoryTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface ContextCodeResolution {
  /** "direct" = demande dans le message courant ; "context" = réponse à la clarification du dépôt. */
  source: "direct" | "context";
  /** Prompt Jules (celui du message courant, ou celui de la demande d'origine pour un suivi contextuel). */
  promptExtraction: string;
  /** Confiance héritée de la demande d'origine (contexte) ou courante (direct). */
  confidence: CodeRequestConfidence;
  /** Dépôt GitHub : présent dans la demande (direct) ou dans la réponse (context). */
  repo?: GithubRepo;
}

/** Marqueurs de la question de clarification dépôt (les DEUX, pour la robustesse). */
const REPO_CLARIFY_OWNER_RE = new RegExp(`${U_START}d[ée]p[ôo]t\\s+GitHub${U_END}`, "iu");
const REPO_CLARIFY_FORMAT_RE = /owner\s*\/\s*repo/i;

/**
 * Le message de l'assistant est-il la question de clarification DÉTERMINISTE
 * « Sur quel dépôt GitHub dois-je travailler ? (format owner/repo) » ?
 * Les URLs sont retirées avant le test (un lien peut contenir « ? »).
 */
export function isCodeRepoClarifyingQuestion(content: string): boolean {
  const sansUrls = content
    // liens markdown [label](url) → label
    .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
    // URLS nues
    .replace(/https?:\/\/\S+/g, " ");
  if (!sansUrls.includes("?")) return false;
  return REPO_CLARIFY_OWNER_RE.test(sansUrls) && REPO_CLARIFY_FORMAT_RE.test(sansUrls);
}

/**
 * Le message de l'assistant est-il l'avis honnête « intégration Jules en
 * préparation » (JULES_API_KEY absente) ? Marqueur déterministe : la
 * mention de jules.google ET de la variable JULES_API_KEY.
 */
export function isJulesPendingNotice(content: string): boolean {
  return content.includes("jules.google") && content.includes("JULES_API_KEY");
}

/**
 * Résout une demande de code à partir du message courant ET du fil :
 *  - demande de code identifiable dans le message lui-même → source "direct" ;
 *  - réponse de l'utilisateur (owner/repo) à la question de clarification
 *    posée après une demande de code → source "context" (prompt d'origine) ;
 *  - dernier message assistant = avis Jules en préparation → null (le flux
 *    normal prend le relais : l'agent traite via ses outils internes —
 *    jamais deux avis identiques d'affilée) ;
 *  - refus / hors-sujet → null.
 */
export function resolveCodeRequestFromContext(
  message: string,
  priorHistory: CodeHistoryTurn[] = [],
): ContextCodeResolution | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  // 1) Le dernier message assistant (le PLUS RÉCENT du fil chronologique)
  // décide du régime du tour.
  const history = priorHistory ?? [];
  let lastAssistant: CodeHistoryTurn | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (!turn || turn.role === "system") continue;
    if (turn.role === "assistant") {
      // Parcours depuis la fin : le PREMIER rencontré est le plus récent.
      if (lastAssistant === null) lastAssistant = turn;
      continue;
    }
    break; // dernier message utilisateur atteint : stop.
  }
  // Avis « Jules en préparation » déjà envoyé → le flux normal répond.
  if (lastAssistant && isJulesPendingNotice(lastAssistant.content)) return null;

  // 2) Demande directe : le message lui-même porte l'intention de code.
  const direct = detectCodeRequest(trimmed);
  if (direct.isCodeRequest) {
    return {
      source: "direct",
      promptExtraction: direct.promptExtraction,
      confidence: direct.confidence,
      ...(direct.repo ? { repo: direct.repo } : {}),
    };
  }

  // 3) Suivi contextuel : réponse à la question de clarification du dépôt.
  if (REFUSAL_RE.test(trimmed)) return null;
  if (MEDIA_REQUEST_RE.test(trimmed.toLowerCase())) return null;

  if (!lastAssistant || !isCodeRepoClarifyingQuestion(lastAssistant.content)) return null;

  // La DERNIÈRE demande utilisateur du fil doit être une demande de code, et
  // tous les messages assistant intervenus depuis doivent être des questions
  // de clarification (aucune session lancée ni réponse complète entre-temps).
  let originalCodeRequest: CodeRequestDetection | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (!turn || turn.role === "system") continue;
    if (turn.role === "assistant") {
      if (!isCodeRepoClarifyingQuestion(turn.content)) return null;
      continue;
    }
    originalCodeRequest = detectCodeRequest(turn.content);
    break;
  }
  if (!originalCodeRequest?.isCodeRequest) return null;

  // La réponse doit nommer un dépôt (owner/repo ou URL GitHub).
  const repo = extractGithubRepo(trimmed);
  if (!repo) return null;

  return {
    source: "context",
    promptExtraction: originalCodeRequest.promptExtraction,
    confidence: "high",
    repo,
  };
}
