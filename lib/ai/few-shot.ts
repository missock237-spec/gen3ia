/**
 * FEW-SHOT PROMPTING (Task 138 — optimisation de la qualité des réponses IA).
 *
 * Exigence utilisateur : « Fournissez un ou deux exemples précis de ce que
 * vous considérez comme un résultat de qualité supérieure. »
 *
 * Chaque famille de réponse (explication, comparaison, procédure, analyse
 * chiffrée, correction de code, recommandation) possède UN exemple de
 * référence calibrant le niveau attendu : réponse directe dès la première
 * ligne, structure markdown, précision quantifiée, honnêteté sur les
 * limites. La sélection est DÉTERMINISTE (mots-clés FR/EN, accents
 * neutralisés) : une même demande sélectionne toujours les mêmes exemples —
 * jamais d'aléatoire, jamais d'invention.
 *
 * Module PUR (aucune dépendance, aucune IO) : testable en vitest, importable
 * côté serveur comme côté client.
 */

/* ------------------------------------------------------------------ */
/* Familles d'exemples                                                 */
/* ------------------------------------------------------------------ */

export interface FewShotFamily {
  id: string;
  /** Mots-clés (FR + EN, minuscules, accents conservés — normalisés au match). */
  keywords: string[];
  /** Titre lisible de la famille de demande. */
  label: string;
  /** La demande d'exemple (illustrative). */
  exampleRequest: string;
  /** La réponse de référence — le niveau de qualité à reproduire. */
  exampleAnswer: string;
}

export const FEW_SHOT_FAMILIES: readonly FewShotFamily[] = [
  {
    id: "explication",
    label: "question d'explication",
    keywords: [
      "explique", "explication", "qu'est-ce que", "cest quoi", "comment fonctionne",
      "pourquoi", "definition", "definir", "difference entre", "c'est quoi",
      "explain", "what is", "how does", "why does", "definition",
    ],
    exampleRequest: "« Explique-moi ce qu'est le R2 (stockage objet) et à quoi ça sert. »",
    exampleAnswer: [
      "**Le R2 (Rainier 2) est un stockage objet compatible S3 : il conserve des fichiers dans des « buckets » accessibles par URL, sans système de fichiers traditionnel.**",
      "",
      "## À quoi ça sert concrètement",
      "1. **Servir des fichiers depuis une URL** — images, PDF, vidéos : chaque objet devient une URL directe (cacheable, signable).",
      "2. **Dissocier stockage et calcul** — le serveur ne garde plus les fichiers : il les dépose et les relit via l'API.",
      "3. **Payer au volume réel** — pas de serveur à dimensionner, tarification au Go stocké et au Go transféré.",
      "",
      "## Quand l'utiliser",
      "| Besoin | R2 adapté ? | Pourquoi |",
      "|---|---|---|",
      "| Fichiers rares mais volumineux | Oui | Aucun coût de lecture sortante |",
      "| Base de données relationnelle | Non | Ce n'est pas un moteur SQL |",
      "",
      "En pratique : vous déposez un objet avec `PUT /bucket/key`, puis vous le servez via son URL — le reste (droits, expiration) se règle par politique sur le bucket.",
    ].join("\n"),
  },
  {
    id: "comparaison",
    label: "demande de comparaison",
    keywords: [
      "compare", "comparer", "comparaison", "difference", "differences", "versus", " vs ",
      "lequel", "meilleur entre", "mieux que", "pour ou contre", "avantages et inconvenients",
      "compare", "better", "pros and cons", "trade-off",
    ],
    exampleRequest: "« Compare PostgreSQL et MongoDB pour une app SaaS qui démarre. »",
    exampleAnswer: [
      "**Pour un SaaS qui démarre : PostgreSQL, sauf besoin documentaire avéré et schéma très mou.**",
      "",
      "| Critère | PostgreSQL | MongoDB |",
      "|---|---|---|",
      "| Modèle | Relationnel, schéma strict | Documents JSON, schéma souple |",
      "| Transactions | ACID robustes, multi-tables | Multi-documents (4.0+), moins matures |",
      "| Requêtes | JOIN, agrégats SQL complets | Pipeline d'agrégation, pas de JOIN natif |",
      "| Scalabilité écriture | Verticale d'abord | Horizontale native (sharding) |",
      "",
      "## Recommandation",
      "- **Choisissez PostgreSQL** si vos données sont liées (clients → factures → lignes) : l'intégrité relationnelle évite 80 % des bugs de données des jeunes SaaS.",
      "- **Choisissez MongoDB** si vos documents sont vraiment auto-contenus (catalogues, journaux d'événements) et que le schéma change chaque semaine.",
      "",
      "Point d'attention : les deux sont gratuits en auto-hébergé ; le coût réel se joue sur l'hébergement managé, où PostgreSQL reste généralement le moins cher à faible trafic.",
    ].join("\n"),
  },
  {
    id: "procedure",
    label: "demande de procédure pas-à-pas",
    keywords: [
      "comment faire", "comment creer", "comment installer", "comment configurer", "etapes",
      "tutoriel", "guide", "pas a pas", "mise en place", "installer", "configurer", "parametrer",
      "deploiement", "deployer", "how to", "step by step", "tutorial", "setup", "install",
      "configure", "deploy",
    ],
    exampleRequest: "« Comment publier mon site Next.js sur Vercel ? »",
    exampleAnswer: [
      "**Le déploiement tient en 3 étapes : connecter le dépôt, vérifier les variables d'environnement, publier.**",
      "",
      "## Prérequis",
      "- Un dépôt GitHub/GitLab contenant votre projet",
      "- Les clés de vos services (base de données, auth…) sous la main",
      "",
      "## Étapes",
      "1. **Importer le projet** — sur vercel.com → *Add New Project* → autorisez l'accès GitHub → sélectionnez le dépôt.",
      "2. **Renseigner les variables** — onglet *Settings → Environment Variables* : reportez CHAQUE variable de votre `.env.local` (une oubliée = build qui échoue au démarrage).",
      "3. **Publier** — *Deploy* : le premier build tourne 2-3 min ; les prochains partiront automatiquement à chaque `git push`.",
      "",
      "## Vérification",
      "Ouvrez l'URL fournie (`https://projet.vercel.app`) et testez une page qui dépend de la base : si elle affiche une erreur 500, une variable d'environnement manque (retour à l'étape 2).",
    ].join("\n"),
  },
  {
    id: "analyse-chiffree",
    label: "demande de calcul ou d'analyse chiffrée",
    keywords: [
      "calcule", "calculer", "combien", "cout", "coute", "budget", "depense", "prix", "tarif",
      "pourcentage", "marge", "rentabilite", "roi", "estimation", "estime", "projetons",
      "statistique", "moyenne", "calculate", "how much", "cost", "price", "estimate",
      "forecast", "roi", "margin",
    ],
    exampleRequest: "« Estime le coût mensuel de mon app : 1 000 utilisateurs, stockage R2 de 50 Go, 10 000 requêtes API/jour. »",
    exampleAnswer: [
      "**Estimation totale : environ 38 €/mois — détail et hypothèses ci-dessous.**",
      "",
      "## Détail du calcul",
      "| Poste | Hypothèse | Coût mensuel |",
      "|---|---|---|",
      "| Stockage | 50 Go × 0,015 $/Go | ≈ 0,75 $ |",
      "| Requêtes | 300 000 requêtes/mois (classe A) | ≈ 0,45 $ |",
      "| Sortie | 100 Go × 0,01 $/Go (R2 : gratuit) | 0 $ |",
      "| Compute | 1 instance petite (≈ 0,5 vCPU) | ≈ 15 € |",
      "| Base de données | Postgres managé 500 Mo | ≈ 20 € |",
      "",
      "## Hypothèses à valider",
      "- **1 000 utilisateurs « actifs légers »** : 10 requêtes/jour chacun. Si chaque session fait 100 appels API, multipliez la ligne requêtes par 10 (≈ +4 $ — négligeable).",
      "- **Sortie réseau** : j'ai supposé 100 Go/mois de téléchargements ; c'est le poste le plus variable.",
      "",
      "⚠️ Fourchette réaliste : **38–60 €/mois**. Le coût réel dépend surtout de la base de données et du compute ; le stockage reste marginal à cette échelle.",
    ].join("\n"),
  },
  {
    id: "code",
    label: "question de code ou de débogage",
    keywords: [
      "code", "bug", "erreur", "exception", "fonction", "script", "compile", "compilation",
      "typescript", "javascript", "python", "react", "api", "requete", "stack trace", "traceback",
      "debogage", "corrige", "null", "undefined", "function", "debug", "error", "fix", "refactor",
    ],
    exampleRequest: "« Mon useEffect React tourne en boucle infinie, pourquoi ? »",
    exampleAnswer: [
      "**Cause : une dépendance qui change à chaque rendu (objet ou tableau recréé) déclenche l'effet à chaque cycle.**",
      "",
      "## Diagnostic",
      "Le cycle : rendu → l'effet s'exécute → il met à jour l'état → nouveau rendu → l'effet s'exécute encore. Le signal : un `console.log` dans l'effet qui se répète sans intervention.",
      "",
      "## Correctif",
      "```tsx",
      "useEffect(() => {",
      "  // 1. Dépendance stable : objet mémoïsé",
      "  const options = useMemo(() => ({ page: 1 }), []);",
      "  // 2. L'effet ne dépend QUE d'elle",
      "  fetchItems(options);",
      "}, [options]);",
      "```",
      "",
      "## Vérification",
      "- Le `console.log` de l'effet ne doit apparaître qu'UNE fois au montage.",
      "- Si la boucle persiste : la fonction `fetchItems` est-elle recréée à chaque rendu ? Emballez-la dans `useCallback` avec les bonnes dépendances.",
    ].join("\n"),
  },
  {
    id: "recommandation",
    label: "demande de recommandation ou de décision",
    keywords: [
      "devrais-je", "dois-je", "conseille", "recommande", "recommandation", "que choisir",
      "quelle option", "aide-moi a decider", "valoir le coup", "priorite", "par ou commencer",
      "should i", "recommend", "advice", "which option", "prioritize",
    ],
    exampleRequest: "« Devrais-je utiliser TypeScript ou rester en JavaScript pour mon projet ? »",
    exampleAnswer: [
      "**Recommandation : passez à TypeScript — sauf script jetable de moins de 100 lignes.**",
      "",
      "## Pourquoi",
      "- **Les erreurs se déplacent du runtime vers l'éditeur** : une faute de frappe sur un champ (`user.naame`) devient une ligne rouge immédiate au lieu d'un `undefined` en production.",
      "- **L'autocomplétion devient structurelle** : l'IDE connaît vos types de données, pas seulement les mots-clés du langage.",
      "- **Le refactoring devient sûr** : renommer une fonction sur 40 fichiers est vérifié par le compilateur, pas par vos yeux.",
      "",
      "## Nuances honnêtes",
      "| Situation | Choix raisonnable |",
      "|---|---|",
      "| Projet durable, équipe ≥ 1 | TypeScript |",
      "| Prototype jetable, 1 après-midi | JavaScript acceptable |",
      "| Migration d'une grosse base JS | JS + `checkJs` progressif |",
      "",
      "Prochaine étape concrète : `npx tsc --init` dans votre projet, activez `strict: true` dès le départ — le coût d'entrée est faible, le gain se voit dès la première semaine.",
    ].join("\n"),
  },
];

/** Nombre maximal d'exemples injectés dans un prompt (exigence : 1 à 2). */
export const FEW_SHOT_MAX_EXAMPLES = 2;

/* ------------------------------------------------------------------ */
/* Normalisation (accents/casse) — partagée avec la logique de match    */
/* ------------------------------------------------------------------ */

/** Minuscules + accents NFD supprimés (la casse et les accents ne doivent jamais casser la sélection). */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Sélection déterministe                                              */
/* ------------------------------------------------------------------ */

export interface SelectedFewShot {
  family: FewShotFamily;
  score: number;
}

/**
 * Sélectionne les 1-2 familles d'exemples les plus similaires à la demande.
 * Règles :
 *  - score = nombre de mots-clés de la famille présents dans la demande ;
 *  - ex æquo → ordre de déclaration stable (déterminisme total) ;
 *  - aucun mot-clé trouvé → AUCUN exemple (une salutation ou une demande
 *    triviale n'a pas besoin de calibrage — le prompt reste court).
 */
export function selectFewShotExamples(message: string, max = FEW_SHOT_MAX_EXAMPLES): SelectedFewShot[] {
  const limit = Math.min(Math.max(Math.floor(max), 0), FEW_SHOT_MAX_EXAMPLES);
  const haystack = ` ${normalizeForMatch(message)} `;
  const scored = FEW_SHOT_FAMILIES.map((family, index) => {
    let score = 0;
    for (const keyword of family.keywords) {
      if (haystack.includes(normalizeForMatch(keyword))) score += 1;
    }
    return { family, score, index };
  });
  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ family, score }) => ({ family, score }));
}

/* ------------------------------------------------------------------ */
/* Rendu prompt                                                        */
/* ------------------------------------------------------------------ */

/**
 * Rend la section few-shot prête à injecter dans un prompt système.
 * Vide si aucun exemple sélectionné (aucune section fantôme).
 */
export function renderFewShotSection(examples: SelectedFewShot[]): string {
  if (examples.length === 0) return "";
  const blocks = examples.map(({ family }) => [
    `--- EXEMPLE (${family.label}) ---`,
    `Demande : ${family.exampleRequest}`,
    `Réponse de référence :`,
    family.exampleAnswer,
  ].join("\n"));
  return [
    "EXEMPLES DE QUALITÉ ATTENDUE (calibrent le NIVEAU et la STRUCTURE de tes réponses ; le sujet des exemples est purement illustratif) :",
    "",
    ...blocks,
  ].join("\n");
}

/** Raccourci : sélection + rendu en un appel (le plus courant). */
export function buildFewShotSection(message: string, max = FEW_SHOT_MAX_EXAMPLES): string {
  return renderFewShotSection(selectFewShotExamples(message, max));
}
