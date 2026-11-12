/**
 * HARNAIS D'ÉVALUATION DÉVELOPPEMENT WEB + DNS (it.150 — WEBTRAIN-BIS).
 *
 * Demande propriétaire : « AU MOINS 30 questions graduées dont 10 "tests de
 * production" par id (html-semantique, flex-grid, async-await, ts-generics,
 * http-304-etag, cors-preflight, dns-mx-ttl, dns-cname-apex, dns-propagation,
 * dnssec-pourquoi) — chaque question : prompt, mots-clés/points clés attendus,
 * scoring sémantique simple (recouvrement des points clés, pondéré) ».
 * INVENTAIRE RÉEL : 31 questions graduées (10 production + 21 graduées).
 *
 * SCORING (honnête et mesurable) :
 *   - chaque point clé porte un POIDS (1/2/3) et des MOTS acceptés
 *     (variantes normalisées : casse et accents neutralisés, pluriel
 *     toléré, bornes de mots respectées — « ns » ne matche pas « dns ») ;
 *   - score0a100 = 100 × Σ(poids couverts) / Σ(poids totaux) ;
 *   - verdicts : acquis ≥ 70, insuffisant < 30, partiel entre les deux ;
 *   - pointsCouverts / pointsManquants = noms des points clés — la sonde
 *     de production (passerelle-production.ts) peut rendre compte.
 *
 * CE QUE CE HARNAIS N'EST PAS : ni un modèle de langage, ni un juge LLM.
 * C'est un grader lexical pondéré, déterministe, vérifiable par tests —
 * adapté à des questions fermées dont les points clés sont énoncés.
 *
 * Module PUR — aucune dépendance Node.
 */

/** Sous-thèmes évalués (alignés sur les corpus commis it.150). */
export const SOUS_THEMES_EVAL_DEV_WEB = [
  "html-css",
  "js-ts",
  "react-next",
  "http-securite",
  "perf-a11y",
  "dns",
] as const;

export type SousThemeEvalDevWeb = (typeof SOUS_THEMES_EVAL_DEV_WEB)[number];

/** Gradation des questions (demande : « questions graduées »). */
export type NiveauQuestionDevWeb = "base" | "intermediaire" | "avance";

/** Verdict d'une réponse graduée. */
export type VerdictDevWeb = "acquis" | "partiel" | "insuffisant";

/** Seuils documentés (demande : correcte > 70 → acquis ; hors-sujet < 30 →
 * insuffisant ; entre les deux → partiel). */
export const SEUIL_ACQUIS_DEV_WEB = 70;
export const SEUIL_INSUFFISANT_DEV_WEB = 30;

/** Un point clé attendu : nom lisible, mots acceptés (bornés, pluriel ok),
 * poids 1–3 (pondération du score). */
export interface PointCleDevWeb {
  readonly nom: string;
  readonly mots: readonly string[];
  readonly poids: 1 | 2 | 3;
}

/** Question graduée du harnais. */
export interface QuestionDevWeb {
  readonly id: string;
  readonly sousTheme: SousThemeEvalDevWeb;
  readonly niveau: NiveauQuestionDevWeb;
  /** Les 10 « tests de production » (exécutés par passerelle-production.ts). */
  readonly testProduction: boolean;
  readonly prompt: string;
  readonly pointsCles: readonly PointCleDevWeb[];
}

/** Résultat du scoring d'une réponse. */
export interface ResultatScoringDevWeb {
  readonly score0a100: number;
  readonly pointsCouverts: readonly string[];
  readonly pointsManquants: readonly string[];
  readonly verdict: VerdictDevWeb;
}

// ─── NORMALISATION ET APPARIEMENT ────────────────────────────────────────────

/** Casse + accents neutralisés (les mots clés et réponses subissent le même
 * traitement — « ETag » == « etag », « priorité » == « priorite »). */
export function normaliserTexteDevWeb(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/** Échappement regex minimal. */
function echapperRegex(mot: string): string {
  return mot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Le mot apparaît-il comme MOT (bornes : pas collé à [a-z0-9]) avec
 * tolérance du pluriel (« résolveur » couvre « résolveurs ») ? */
function contientMotDevWeb(texte: string, mot: string): boolean {
  const regex = new RegExp(`(?<![a-z0-9])${echapperRegex(mot)}s?(?![a-z0-9])`);
  return regex.test(texte);
}

// ─── LES QUESTIONS GRADUÉES (10 tests de production + 21 graduées) ──────────

export const QUESTIONS_DEV_WEB: readonly QuestionDevWeb[] = [
  // ══ TESTS DE PRODUCTION (10) ════════════════════════════════════════════
  {
    id: "html-semantique",
    sousTheme: "html-css",
    niveau: "intermediaire",
    testProduction: true,
    prompt:
      "Pourquoi utiliser du HTML sémantique plutôt que des div partout ? Citez les éléments de structure d'une page.",
    pointsCles: [
      {
        nom: "landmarks / navigation lecteur d'écran",
        mots: ["lecteur d'ecran", "landmark", "accessibilite", "screen reader", "navigation"],
        poids: 2,
      },
      {
        nom: "éléments structurels (header, nav, main, article, section, aside, footer)",
        mots: ["header", "nav", "main", "article", "section", "aside", "footer"],
        poids: 3,
      },
      {
        nom: "signification portée (moteurs, SEO, lisibilité) — un div ne dit rien",
        mots: ["semantique", "signification", "moteurs", "seo", "div"],
        poids: 2,
      },
      {
        nom: "un seul h1 et hiérarchie de titres sans saut de niveau",
        mots: ["h1", "titre", "hierarchie"],
        poids: 1,
      },
      {
        nom: "button pour une action, a (lien) pour naviguer",
        mots: ["button", "lien", "action", "naviguer", "navigation"],
        poids: 2,
      },
    ],
  },
  {
    id: "flex-grid",
    sousTheme: "html-css",
    niveau: "intermediaire",
    testProduction: true,
    prompt:
      "Expliquez la différence entre flexbox et CSS Grid, quand utiliser chacun, et comment centrer un élément avec flex.",
    pointsCles: [
      {
        nom: "flex = un axe principal, grid = deux dimensions (lignes et colonnes)",
        mots: ["axe", "dimension", "ligne", "colonne", "deux"],
        poids: 3,
      },
      {
        nom: "flex-direction définit l'axe (row/column)",
        mots: ["flex-direction", "row", "column"],
        poids: 1,
      },
      {
        nom: "justify-content (axe principal) vs align-items (axe secondaire)",
        mots: ["justify-content", "align-items"],
        poids: 2,
      },
      {
        nom: "centrage : display: flex + justify-content: center + align-items: center",
        mots: ["display", "center"],
        poids: 2,
      },
      {
        nom: "grille responsive : grid-template-columns repeat minmax auto-fit",
        mots: ["grid-template-columns", "repeat", "minmax", "auto-fit"],
        poids: 2,
      },
      {
        nom: "gap pour espacer sans marges",
        mots: ["gap"],
        poids: 1,
      },
    ],
  },
  {
    id: "async-await",
    sousTheme: "js-ts",
    niveau: "base",
    testProduction: true,
    prompt:
      "Que fait async/await par rapport aux promesses JavaScript ? Comment y gérer les erreurs et le parallélisme ?",
    pointsCles: [
      {
        nom: "async/await repose sur les promesses (promise)",
        mots: ["promesse", "promise"],
        poids: 3,
      },
      {
        nom: "une fonction async renvoie toujours une promesse",
        mots: ["async", "renvoie", "toujours"],
        poids: 2,
      },
      {
        nom: "await suspend jusqu'à la résolution — code lisible, évite callbacks/.then chaînés",
        mots: ["await", "attend", "suspend"],
        poids: 2,
      },
      {
        nom: "gestion des erreurs avec try/catch",
        mots: ["try", "catch", "erreur"],
        poids: 2,
      },
      {
        nom: "parallélisme avec Promise.all",
        mots: ["promise.all", "parallele", "parallelisme", "simultane"],
        poids: 1,
      },
      {
        nom: "lisible par rapport aux callbacks imbriqués / .then",
        mots: ["callback", "then", "lisible"],
        poids: 1,
      },
    ],
  },
  {
    id: "ts-generics",
    sousTheme: "js-ts",
    niveau: "intermediaire",
    testProduction: true,
    prompt:
      "À quoi servent les génériques TypeScript ? Donnez la syntaxe, un exemple et une contrainte possible.",
    pointsCles: [
      {
        nom: "type paramétré — code réutilisable et typé sans dupliquer",
        mots: ["parametre", "reutilisable", "generique", "dupliquer"],
        poids: 3,
      },
      {
        nom: "syntaxe <T> (paramètre de type)",
        mots: ["<t>", "parametre de type"],
        poids: 2,
      },
      {
        nom: "sécurité de type conservée, évite any",
        mots: ["securite", "any", "typage", "type-safe"],
        poids: 2,
      },
      {
        nom: "exemple (identité, tableau, interface)",
        mots: ["exemple", "identite", "tableau", "interface"],
        poids: 1,
      },
      {
        nom: "contrainte avec extends",
        mots: ["extends"],
        poids: 1,
      },
      {
        nom: "utilitaires génériques (Partial, Record, Pick)",
        mots: ["partial", "record", "pick"],
        poids: 1,
      },
    ],
  },
  {
    id: "http-304-etag",
    sousTheme: "http-securite",
    niveau: "intermediaire",
    testProduction: true,
    prompt:
      "Comment fonctionne une revalidation de cache avec ETag et le statut 304 Not Modified ?",
    pointsCles: [
      {
        nom: "ETag = identifiant opaque de la version de la ressource",
        mots: ["etag", "identifiant", "version", "empreinte"],
        poids: 3,
      },
      {
        nom: "revalidation par If-None-Match",
        mots: ["if-none-match", "revalidation", "revalide"],
        poids: 3,
      },
      {
        nom: "304 Not Modified — réponse sans corps",
        mots: ["304", "not modified", "sans corps", "pas de corps"],
        poids: 3,
      },
      {
        nom: "le cache client conserve sa copie",
        mots: ["cache"],
        poids: 2,
      },
      {
        nom: "économie de bande passante / transfert",
        mots: ["bande passante", "economie", "transfert"],
        poids: 1,
      },
      {
        nom: "variante par date If-Modified-Since / Last-Modified",
        mots: ["if-modified-since", "last-modified"],
        poids: 1,
      },
      {
        nom: "fraîcheur directe Cache-Control max-age",
        mots: ["cache-control", "max-age"],
        poids: 1,
      },
    ],
  },
  {
    id: "cors-preflight",
    sousTheme: "http-securite",
    niveau: "intermediaire",
    testProduction: true,
    prompt:
      "Qu'est-ce que le CORS et le preflight ? Quand le navigateur envoie-t-il OPTIONS et que doit répondre le serveur ?",
    pointsCles: [
      {
        nom: "politique de même origine du navigateur (origine = schéma+host+port)",
        mots: ["origine", "origin", "navigateur"],
        poids: 3,
      },
      {
        nom: "Access-Control-Allow-Origin autorise la lecture",
        mots: ["access-control-allow-origin"],
        poids: 3,
      },
      {
        nom: "preflight = requête OPTIONS préalable",
        mots: ["preflight", "options"],
        poids: 3,
      },
      {
        nom: "déclenché par une requête non simple (méthode, en-têtes personnalisés)",
        mots: ["non simple", "personnalise", "custom", "authorization"],
        poids: 2,
      },
      {
        nom: "Access-Control-Allow-Methods / Access-Control-Allow-Headers",
        mots: ["access-control-allow-methods", "access-control-allow-headers"],
        poids: 2,
      },
      {
        nom: "mise en cache du preflight Access-Control-Max-Age",
        mots: ["max-age"],
        poids: 1,
      },
    ],
  },
  {
    id: "dns-mx-ttl",
    sousTheme: "dns",
    niveau: "base",
    testProduction: true,
    prompt:
      "À quoi servent les enregistrements MX et comment fonctionne la priorité ? Et le TTL d'un enregistrement DNS ?",
    pointsCles: [
      {
        nom: "MX désigne le serveur de courriel du domaine",
        mots: ["courriel", "mail", "email", "messagerie"],
        poids: 3,
      },
      {
        nom: "priorité la plus petite d'abord, essais croissants, égaux répartissent",
        mots: ["priorite", "petit", "basse", "croissant"],
        poids: 3,
      },
      {
        nom: "TTL = durée de mise en cache, en secondes",
        mots: ["ttl", "cache", "seconde", "duree"],
        poids: 3,
      },
      {
        nom: "TTL court → changements rapides ; TTL long → moins de charge",
        mots: ["court", "long", "rapide", "charge"],
        poids: 2,
      },
      {
        nom: "le résolveur décrémente le TTL des réponses en cache",
        mots: ["decrement", "decremente", "decroit", "resolveur", "resolver"],
        poids: 1,
      },
      {
        nom: "la propagation n'est que l'expiration des caches",
        mots: ["propagation", "expiration", "expire"],
        poids: 1,
      },
    ],
  },
  {
    id: "dns-cname-apex",
    sousTheme: "dns",
    niveau: "intermediaire",
    testProduction: true,
    prompt:
      "Pourquoi ne peut-on pas mettre un CNAME directement sur exemple.org (apex) et quelles sont les alternatives ?",
    pointsCles: [
      {
        nom: "CNAME = alias vers un autre nom",
        mots: ["alias", "cname"],
        poids: 3,
      },
      {
        nom: "l'apex doit porter SOA et NS",
        mots: ["soa", "ns", "apex"],
        poids: 3,
      },
      {
        nom: "un nom avec CNAME ne peut porter aucun autre enregistrement",
        mots: ["aucun autre", "aucune autre", "interdit", "remplace"],
        poids: 2,
      },
      {
        nom: "interdit par les RFC (1034 / 2181)",
        mots: ["rfc", "1034", "2181"],
        poids: 2,
      },
      {
        nom: "alternatives : A/AAAA directs, ALIAS/ANAME, CNAME flattening",
        mots: ["aaaa", "adresse", "alias", "aname", "flattening"],
        poids: 2,
      },
      {
        nom: "hors apex (www) le CNAME est légal",
        mots: ["www", "sous-domaine"],
        poids: 1,
      },
    ],
  },
  {
    id: "dns-propagation",
    sousTheme: "dns",
    niveau: "intermediaire",
    testProduction: true,
    prompt:
      "Qu'est-ce que la « propagation DNS » réellement et comment réduire la fenêtre avant une migration ?",
    pointsCles: [
      {
        nom: "ce sont les caches qui expirent — pas une onde réseau",
        mots: ["cache", "onde"],
        poids: 3,
      },
      {
        nom: "le TTL gouverne la durée de vie en cache",
        mots: ["ttl"],
        poids: 3,
      },
      {
        nom: "baisser le TTL 24–48 h AVANT la migration",
        mots: ["baisser", "24", "48", "avant", "migration"],
        poids: 2,
      },
      {
        nom: "vérifier l'autoritaire (dig @ns) comme vérité",
        mots: ["autoritaire", "dig", "@ns"],
        poids: 2,
      },
      {
        nom: "comparer plusieurs résolveurs publics (8.8.8.8, 1.1.1.1)",
        mots: ["8.8.8.8", "1.1.1.1", "resolveur", "resolver"],
        poids: 1,
      },
      {
        nom: "TTL négatif du SOA pour les NXDOMAIN",
        mots: ["negatif", "soa", "nxdomain"],
        poids: 1,
      },
    ],
  },
  {
    id: "dnssec-pourquoi",
    sousTheme: "dns",
    niveau: "avance",
    testProduction: true,
    prompt:
      "Pourquoi activer DNSSEC sur un domaine ? Que protège-t-il, et que ne fait-il PAS ?",
    pointsCles: [
      {
        nom: "signature cryptographique des RRsets",
        mots: ["signature", "cryptographique", "signe"],
        poids: 3,
      },
      {
        nom: "authenticité + intégrité de la réponse",
        mots: ["authenticite", "authentique", "integrite"],
        poids: 3,
      },
      {
        nom: "tue le cache poisoning / détournement (Kaminsky)",
        mots: ["poisoning", "empoisonnement", "detournement", "kaminsky"],
        poids: 3,
      },
      {
        nom: "ne chiffre PAS — pas de confidentialité du transport",
        mots: ["chiffre", "confidentialite"],
        poids: 2,
      },
      {
        nom: "confidentialité par DoH/DoT (complément)",
        mots: ["doh", "dot", "transport"],
        poids: 1,
      },
      {
        nom: "chaîne de confiance racine → TLD → zone (DS/DNSKEY)",
        mots: ["chaine", "confiance", "ds", "dnskey", "racine", "tld"],
        poids: 1,
      },
      {
        nom: "zone invalide → SERVFAIL (jamais une réponse non validée)",
        mots: ["servfail"],
        poids: 1,
      },
    ],
  },

  // ══ QUESTIONS GRADUÉES (20) ═════════════════════════════════════════════
  {
    id: "html-formulaires-accessibles",
    sousTheme: "html-css",
    niveau: "base",
    testProduction: false,
    prompt: "Comment rendre un formulaire HTML accessible ?",
    pointsCles: [
      { nom: "label for relié à chaque champ", mots: ["label"], poids: 3 },
      { nom: "fieldset/legend pour les groupes", mots: ["fieldset", "legend"], poids: 2 },
      { nom: "placeholder n'est pas un label", mots: ["placeholder"], poids: 2 },
      { nom: "erreurs annoncées (aria-invalid, aria-describedby)", mots: ["aria-invalid", "aria-describedby", "erreur"], poids: 2 },
    ],
  },
  {
    id: "html-alt-images",
    sousTheme: "html-css",
    niveau: "base",
    testProduction: false,
    prompt: "Comment écrire un bon attribut alt pour une image ?",
    pointsCles: [
      { nom: "alt décrit la fonction/le contenu utile", mots: ["fonction", "contenu", "decrit", "description"], poids: 3 },
      { nom: "alt=\"\" pour une image décorative", mots: ["decorative", "vide"], poids: 3 },
      { nom: "jamais « image de » (redondant avec le rôle)", mots: ["image de", "redondant"], poids: 1 },
    ],
  },
  {
    id: "css-specificite",
    sousTheme: "html-css",
    niveau: "avance",
    testProduction: false,
    prompt: "Comment se calcule la spécificité CSS et comment l'apprivoiser ?",
    pointsCles: [
      { nom: "comptage (identifiants, classes, éléments)", mots: ["identifiant", "classe", "element", "comptage"], poids: 3 },
      { nom: "styles inline passent devant les feuilles", mots: ["inline"], poids: 2 },
      { nom: "!important inverse l'ordre (anti-pattern)", mots: ["important"], poids: 2 },
      { nom: "@layer déclare l'ordre des couches", mots: ["layer", "couche"], poids: 1 },
    ],
  },
  {
    id: "js-tableaux-immuables",
    sousTheme: "js-ts",
    niveau: "base",
    testProduction: false,
    prompt: "Que font map, filter et reduce sur un tableau JavaScript ?",
    pointsCles: [
      { nom: "map transforme chaque élément (même taille)", mots: ["map", "transforme"], poids: 3 },
      { nom: "filter sélectionne un sous-ensemble", mots: ["filter", "filtre", "sous-ensemble"], poids: 2 },
      { nom: "reduce accumule vers une valeur unique", mots: ["reduce", "accumule", "accumulation"], poids: 2 },
      { nom: "elles retournent un nouveau tableau (immuable)", mots: ["nouveau", "immuable", "copie"], poids: 1 },
    ],
  },
  {
    id: "js-modules-esm",
    sousTheme: "js-ts",
    niveau: "base",
    testProduction: false,
    prompt: "Comment fonctionnent les modules ES (import/export) ?",
    pointsCles: [
      { nom: "export expose (nommé ou default)", mots: ["export", "default"], poids: 3 },
      { nom: "import consomme dans un autre module", mots: ["import"], poids: 3 },
      { nom: "graph statique analysable (tree-shaking)", mots: ["statique", "tree-shaking", "arbre"], poids: 1 },
    ],
  },
  {
    id: "ts-utility-types",
    sousTheme: "js-ts",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Citez et expliquez des utility types TypeScript (Partial, Record, Readonly).",
    pointsCles: [
      { nom: "Partial rend les propriétés facultatives", mots: ["partial", "facultative", "optionnel"], poids: 3 },
      { nom: "Record construit un dictionnaire clé→type", mots: ["record", "dictionnaire", "cle"], poids: 2 },
      { nom: "Readonly interdit la mutation", mots: ["readonly", "mutation"], poids: 2 },
      { nom: "transformations de types (mappées)", mots: ["mappe", "transformation"], poids: 1 },
    ],
  },
  {
    id: "react-hooks-etat",
    sousTheme: "react-next",
    niveau: "base",
    testProduction: false,
    prompt: "Comment fonctionnent useState et useEffect dans React ?",
    pointsCles: [
      { nom: "useState porte l'état local + setter", mots: ["usestate", "etat", "setter"], poids: 3 },
      { nom: "useEffect synchronise avec des effets (dépendances)", mots: ["useeffect", "effet", "dependance"], poids: 3 },
      { nom: "hooks au sommet du composant (pas dans des conditions)", mots: ["sommet", "top", "condition", "ordre"], poids: 2 },
    ],
  },
  {
    id: "next-server-client-components",
    sousTheme: "react-next",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Quelle différence entre composants serveur et clients dans l'App Router Next.js ?",
    pointsCles: [
      { nom: "composants serveur par défaut (RSC)", mots: ["serveur", "server", "rsc"], poids: 3 },
      { nom: "\"use client\" pour interactivité, état, navigateur", mots: ["use client", "client", "interactivite"], poids: 3 },
      { nom: "les serveurs ne portent pas useState/effets", mots: ["usestate", "effet", "etat"], poids: 2 },
    ],
  },
  {
    id: "next-app-router-structure",
    sousTheme: "react-next",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Comment l'App Router de Next.js structure-t-il les routes et les mises en page ?",
    pointsCles: [
      { nom: "dossier = segment de route (page.tsx)", mots: ["dossier", "page.tsx", "segment"], poids: 3 },
      { nom: "layout.tsx enveloppe les segments (persistant)", mots: ["layout"], poids: 2 },
      { nom: "loading.tsx / error.tsx par convention", mots: ["loading", "error"], poids: 1 },
    ],
  },
  {
    id: "next-data-fetching-cache",
    sousTheme: "react-next",
    niveau: "avance",
    testProduction: false,
    prompt: "Comment fonctionne le fetch dans un composant serveur Next.js (cache, revalidation) ?",
    pointsCles: [
      { nom: "fetch étendu avec cache / revalidate", mots: ["fetch", "cache", "revalidate"], poids: 3 },
      { nom: "revalidation par temps ou par tag", mots: ["revalidate", "tag", "temps", "secondes"], poids: 2 },
      { nom: "requêtes dédupliquées par requête", mots: ["dedupliquee", "memoise"], poids: 1 },
    ],
  },
  {
    id: "http-401-vs-403",
    sousTheme: "http-securite",
    niveau: "base",
    testProduction: false,
    prompt: "Quelle différence entre les statuts 401 et 403 ?",
    pointsCles: [
      { nom: "401 Unauthorized : authentification requise/invalide", mots: ["401", "authentification"], poids: 3 },
      { nom: "401 renvoie WWW-Authenticate", mots: ["www-authenticate"], poids: 2 },
      { nom: "403 Forbidden : identifié mais refusé — auth ne changera rien", mots: ["403", "refuse", "forbidden"], poids: 3 },
    ],
  },
  {
    id: "http-404-vs-410",
    sousTheme: "http-securite",
    niveau: "base",
    testProduction: false,
    prompt: "Quelle différence entre 404 Not Found et 410 Gone ?",
    pointsCles: [
      { nom: "404 : ressource introuvable (permanent ou non)", mots: ["404", "introuvable", "not found"], poids: 3 },
      { nom: "410 : définitivement supprimée", mots: ["410", "gone", "supprimee", "definitivement"], poids: 3 },
      { nom: "les moteurs déindexent plus vite un 410", mots: ["moteur", "seo", "deindex"], poids: 1 },
    ],
  },
  {
    id: "http-methodes-idempotence",
    sousTheme: "http-securite",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Expliquez sûreté et idempotence des méthodes HTTP (GET, POST, PUT, PATCH, DELETE).",
    pointsCles: [
      { nom: "GET/HEAD sont sûres (sans effet)", mots: ["sure", "get", "head"], poids: 2 },
      { nom: "idempotence : PUT/DELETE répétables, POST non", mots: ["idempotent", "put", "delete", "post"], poids: 3 },
      { nom: "PUT remplace tout, PATCH modifie partiellement", mots: ["patch", "partiel", "remplace"], poids: 2 },
    ],
  },
  {
    id: "securite-csp-headers",
    sousTheme: "http-securite",
    niveau: "avance",
    testProduction: false,
    prompt: "Quels en-têtes de sécurité HTTP réduisent le risque XSS et clickjacking ?",
    pointsCles: [
      { nom: "Content-Security-Policy borne les sources (script-src, nonce)", mots: ["content-security-policy", "csp", "script-src", "nonce"], poids: 3 },
      { nom: "X-Content-Type-Options: nosniff", mots: ["nosniff", "x-content-type-options"], poids: 2 },
      { nom: "CSP frame-ancestors (ou X-Frame-Options) contre le clickjacking", mots: ["frame-ancestors", "x-frame-options", "clickjacking"], poids: 2 },
      { nom: "HSTS force HTTPS", mots: ["hsts", "strict-transport-security"], poids: 1 },
    ],
  },
  {
    id: "perf-lcp",
    sousTheme: "perf-a11y",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Qu'est-ce que le LCP des Core Web Vitals et comment l'améliorer ?",
    pointsCles: [
      { nom: "LCP = Largest Contentful Paint, seuil bon ≤ 2,5 s", mots: ["lcp", "largest contentful", "2.5"], poids: 3 },
      { nom: "précharger la ressource critique / preload", mots: ["preload", "precharge"], poids: 2 },
      { nom: "images optimisées (formats modernes, tailles responsive)", mots: ["image", "format", "responsive", "webp"], poids: 2 },
    ],
  },
  {
    id: "perf-cls",
    sousTheme: "perf-a11y",
    niveau: "base",
    testProduction: false,
    prompt: "Qu'est-ce que le CLS et comment éviter les décalages de mise en page ?",
    pointsCles: [
      { nom: "CLS = Cumulative Layout Shift, seuil bon < 0.1", mots: ["cls", "layout shift", "0.1"], poids: 3 },
      { nom: "réserver la place : width/height, aspect-ratio", mots: ["width", "height", "aspect-ratio", "place"], poids: 3 },
      { nom: "pas d'insertion de contenu au-dessus du contenu existant", mots: ["inser", "au-dessus", "reserve"], poids: 1 },
    ],
  },
  {
    id: "a11y-contraste-wcag",
    sousTheme: "perf-a11y",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Quels ratios de contraste le WCAG exige-t-il (AA) ?",
    pointsCles: [
      { nom: "4.5:1 pour le texte normal", mots: ["4.5", "4,5"], poids: 3 },
      { nom: "3:1 pour le gros texte", mots: ["gros", "3:1"], poids: 3 },
      { nom: "WCAG niveau AA (AAA à 7:1)", mots: ["wcag", "aa", "aaa"], poids: 2 },
    ],
  },
  {
    id: "dns-a-aaaa",
    sousTheme: "dns",
    niveau: "base",
    testProduction: false,
    prompt: "Quelle différence entre les enregistrements DNS A et AAAA ?",
    pointsCles: [
      { nom: "A : nom → IPv4 (32 bits)", mots: ["ipv4", "32"], poids: 3 },
      { nom: "AAAA : nom → IPv6 (128 bits)", mots: ["aaaa", "ipv6", "128"], poids: 3 },
      { nom: "publier les deux en parallèle (dual-stack)", mots: ["dual", "parallele", "deux"], poids: 1 },
    ],
  },
  {
    id: "dns-zone-soa-serial",
    sousTheme: "dns",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Que contient le SOA d'une zone DNS et pourquoi incrémenter le serial ?",
    pointsCles: [
      { nom: "SOA = début d'autorité (NS primaire, contact)", mots: ["soa", "autorite", "primaire"], poids: 2 },
      { nom: "serial incrémenté à chaque modification", mots: ["serial", "serie", "incremente"], poids: 3 },
      { nom: "sans incrément, les secondaires ne transfèrent pas la zone", mots: ["secondaire", "transfert"], poids: 2 },
      { nom: "minimum = TTL négatif (NXDOMAIN)", mots: ["minimum", "negatif", "nxdomain"], poids: 1 },
    ],
  },
  {
    id: "dns-spf-dkim-dmarc",
    sousTheme: "dns",
    niveau: "intermediaire",
    testProduction: false,
    prompt: "Comment publier SPF, DKIM et DMARC pour un domaine qui envoie du courriel ?",
    pointsCles: [
      { nom: "SPF : TXT v=spf1 avec include et -all", mots: ["spf", "txt", "include"], poids: 3 },
      { nom: "DKIM : clé publique au sélecteur._domainkey", mots: ["dkim", "domainkey", "selecteur"], poids: 3 },
      { nom: "DMARC : _dmarc avec politique p=none → quarantine/reject", mots: ["dmarc", "quarantine", "reject"], poids: 2 },
      { nom: "alignement SPF/DKIM avec le domaine du From", mots: ["alignement", "from"], poids: 1 },
    ],
  },
  {
    id: "dns-outils-diagnostic",
    sousTheme: "dns",
    niveau: "avance",
    testProduction: false,
    prompt: "Avec dig, comment distinguer la vérité autoritaire d'une réponse en cache ?",
    pointsCles: [
      { nom: "dig +norecurse @ns : réponse de l'autoritaire (vérité)", mots: ["norecurse", "autoritaire", "@ns"], poids: 3 },
      { nom: "dig +trace rejoue la chaîne de délégation", mots: ["trace", "delegation", "racine"], poids: 2 },
      { nom: "TTL décroissant = preuve de cache", mots: ["ttl", "decroit", "decroissant", "cache"], poids: 2 },
    ],
  },
];

/** Les 10 questions de « tests de production » (ids stables — la sonde
 * Python de production consomme exactement cette liste). */
export const QUESTIONS_TEST_PRODUCTION_DEV_WEB: readonly QuestionDevWeb[] =
  QUESTIONS_DEV_WEB.filter((q) => q.testProduction);

/** IDs de production attendus (garde explicite de l'API publique). */
export const IDS_TEST_PRODUCTION_DEV_WEB: readonly string[] = [
  "html-semantique",
  "flex-grid",
  "async-await",
  "ts-generics",
  "http-304-etag",
  "cors-preflight",
  "dns-mx-ttl",
  "dns-cname-apex",
  "dns-propagation",
  "dnssec-pourquoi",
];

// ─── SCORING ─────────────────────────────────────────────────────────────────

const QUESTIONS_PAR_ID = new Map<string, QuestionDevWeb>(
  QUESTIONS_DEV_WEB.map((q) => [q.id, q]),
);

/** Score pondéré d'une réponse pour une question connue — recouvrement des
 * points clés (déterministe : même réponse → même score). */
export function scorerReponseDevWeb(
  questionId: string,
  reponse: string,
): ResultatScoringDevWeb {
  const question = QUESTIONS_PAR_ID.get(questionId);
  if (!question) {
    throw new Error(`Question d'évaluation inconnue : ${questionId}`);
  }
  const texte = normaliserTexteDevWeb(reponse ?? "");
  const pointsCouverts: string[] = [];
  const pointsManquants: string[] = [];
  let poidsCouvert = 0;
  let poidsTotal = 0;
  for (const point of question.pointsCles) {
    poidsTotal += point.poids;
    const couvert = point.mots.some((mot) =>
      contientMotDevWeb(texte, normaliserTexteDevWeb(mot)),
    );
    if (couvert) {
      poidsCouvert += point.poids;
      pointsCouverts.push(point.nom);
    } else {
      pointsManquants.push(point.nom);
    }
  }
  const score0a100 =
    poidsTotal === 0 ? 0 : Math.round((100 * poidsCouvert) / poidsTotal);
  const verdict: VerdictDevWeb =
    score0a100 >= SEUIL_ACQUIS_DEV_WEB
      ? "acquis"
      : score0a100 < SEUIL_INSUFFISANT_DEV_WEB
        ? "insuffisant"
        : "partiel";
  return { score0a100, pointsCouverts, pointsManquants, verdict };
}

/** Inventaire du harnais (télémétrie honnête). */
export function inventaireHarnaisDevWeb(): {
  total: number;
  testProduction: number;
  parSousTheme: Record<string, number>;
  parNiveau: Record<string, number>;
} {
  const parSousTheme: Record<string, number> = {};
  const parNiveau: Record<string, number> = {};
  for (const q of QUESTIONS_DEV_WEB) {
    parSousTheme[q.sousTheme] = (parSousTheme[q.sousTheme] ?? 0) + 1;
    parNiveau[q.niveau] = (parNiveau[q.niveau] ?? 0) + 1;
  }
  return {
    total: QUESTIONS_DEV_WEB.length,
    testProduction: QUESTIONS_TEST_PRODUCTION_DEV_WEB.length,
    parSousTheme,
    parNiveau,
  };
}
