/**
 * MÉTHODES DE RAISONNEMENT PAR FAMILLE — it.85-r (re-test production).
 *
 * Anomalie mesurée en production (re-test navigateur du 2026-11-02, 18:10) :
 * les paires du corpus it.85 répondent parfaitement quand la question est
 * posée presque mot pour mot (appariement exact 5,67), mais une question
 * REFORMULÉE avec d'autres concepts (« tous les chats sont des félins… »
 * alors que le corpus apprend « oiseaux/animaux ») retombe soit sur une
 * paire faussement voisine (match à token isolé), soit sur le pont
 * vocation — hors-sujet (« Art et création multimédia ») pour une
 * question de logique.
 *
 * Le levier de généralisation raisonnable sans LLM externe : chaque
 * famille des 16 familles PP porte une MÉTHODE générique — le pas-à-pas
 * qu'un humain applique à ce type de question, rédigé une fois pour
 * toutes, honnête (il annonce la méthode, ne prétend pas être un exemple
 * mémorisé). Quand la détection de famille reconnaît les signaux du
 * message, la méthode répond AVANT le pont vocation.
 *
 * Détection déterministe : les signaux sont des PRÉFIXES de tokens
 * normalisés (sans accents, minuscules — cf. tokenize). Un signal FORT
 * vaut 2 points, un signal FAIBLE 1 point ; la famille répond à partir de
 * 2 points (1 signal fort OU 2 signaux faibles distincts). En cas
 * d'égalité, la première famille du tableau gagne (ordre stable).
 * Seuil à 2 points pour éviter les faux positifs : « pourquoi tu ne
 * réponds pas ? » (1 signal causalité) ne déclenche PAS la méthode
 * causalité — le seuil de 2 protège les questions de service.
 *
 * Le savoir vient du corpus it.85 (16 familles) : ce module est la face
 * conversationnelle de la même connaissance — la généralisation par
 * méthode là où l'appariement par exemple échoue.
 */

/** Une famille de raisonnement et sa méthode générique. */
export interface MethodeFamille {
  /** Clé interne — alignée sur les familles PP du générateur it.85. */
  readonly famille: string;
  /** Nom humain de la famille (affiché honnête dans les logs/tests). */
  readonly nom: string;
  /** Préfixes FORTS : un seul suffit (rare et discriminant). */
  readonly signauxForts: readonly string[];
  /** Préfixes FAIBLES : deux distincts requis. */
  readonly signauxFaibles: readonly string[];
  /** Méthode générique — pas-à-pas pédagogique honnête. */
  readonly methode: string;
}

/** Préfixe de token : le token commence par ce préfixe. */
function prefixePresent(tokens: readonly string[], prefixe: string): boolean {
  return tokens.some((t) => t.startsWith(prefixe));
}

/** Normalise un préfixe-signal : minuscules sans accents (même règle que le corpus). */
function normaliserSignal(signal: string): string {
  return signal
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export const METHODES_FAMILLES: readonly MethodeFamille[] = [
  {
    famille: "deduction",
    nom: "déduction",
    signauxForts: ["conclu", "dedui", "syllogis", "premiss", "converse", "invalide", "valable"],
    signauxFaibles: ["logique", "regle", "decoule"],
    methode:
      "1) Une déduction part de prémisses données et n'affirme que ce qui en découle nécessairement. " +
      "2) Repère les deux prémisses : une règle générale (« tous les A sont des B ») et un cas particulier (« X est un A »). " +
      "3) Conclusion valide : X est un B — le cas particulier hérite de ce que la règle lui accorde. " +
      "4) Piège classique : la converse n'est PAS valide — de « tous les A sont des B », on ne peut pas conclure « tous les B sont des A » (tous les chats sont des félins, mais un félin peut être un lion). " +
      "5) Pour vérifier une conclusion : cherche UN contre-exemple ; s'il en existe un seul, elle est invalide. " +
      "Donc : applique la règle au cas, puis teste la converse avant de l'accepter.",
  },
  {
    famille: "conditionnel",
    nom: "conditionnel (si… alors)",
    signauxForts: ["modus", "condition", "sinon"],
    signauxFaibles: ["si", "alors", "consequence", "supposons"],
    methode:
      "1) Un conditionnel lie une condition à une conséquence : « si P, alors Q ». " +
      "2) P vrai → Q vrai (modus ponens : on affirme la conséquence légitimement). " +
      "3) Q faux → P faux (modus tollens : nier la conséquence nie la condition). " +
      "4) Pièges : quand P est faux, la règle ne dit RIEN sur Q ; et « Q est vrai » ne prouve jamais P (affirmation du conséquent). " +
      "5) Avant de conclure, identifie quelle branche tu utilises : ponens, tollens, ou un piège. " +
      "Donc : ponens pour affirmer, tollens pour nier — jamais l'inverse.",
  },
  {
    famille: "induction",
    nom: "induction",
    signauxForts: ["inductio", "induire", "generalis"],
    signauxFaibles: ["repete", "tendance", "observe", "toujours"],
    methode:
      "1) Une induction généralise à partir d'observations répétées — elle est prudente, jamais certaine. " +
      "2) Compte les observations : combien de fois, dans quels contextes différents ? " +
      "3) Formule la généralisation avec son degré de confiance : « jusqu'ici, toujours » plutôt que « toujours, pour toujours ». " +
      "4) Cherche activement le contre-exemple (le cygne noir) : une seule exception force la règle à se limiter. " +
      "5) Reste prêt à réviser : une induction solide est une hypothèse solide, pas une vérité. " +
      "Donc : observe, généralise prudemment, cherche l'exception, réserve-toi le droit de réviser.",
  },
  {
    famille: "abduction",
    nom: "abduction (meilleure explication)",
    signauxForts: ["abductio", "plausible", "hypothese"],
    signauxFaibles: ["expliqu", "probable", "suppos", "explicati", "meilleur"],
    methode:
      "1) Une abduction cherche la meilleure explication d'un fait surprenant. " +
      "2) Décris d'abord le fait exactement (quoi, quand, où) — sans interprétation. " +
      "3) Liste au moins deux hypothèses concurrentes : la plus évidente n'est pas toujours la meilleure. " +
      "4) Compare : celle qui explique le fait avec le MOINS de suppositions nouvelles gagne (rasoir d'Occam). " +
      "5) Chaque hypothèse doit être vérifiable : propose le test qui la confirme ou l'élimine. " +
      "Donc : fait → hypothèses concurrentes → la plus économe → un test pour trancher.",
  },
  {
    famille: "analogie",
    nom: "analogie",
    signauxForts: ["analogi", "ressemble", "comparable"],
    signauxFaibles: ["pareil", "similair", "semabl"],
    methode:
      "1) Une analogie transfère ce qu'on sait d'un domaine connu vers un domaine nouveau. " +
      "2) Identifie la structure commune : A est à B ce que C est à D — quels rapports se correspondent ? " +
      "3) Vérifie que le rapport est le même, pas seulement les objets : les images se ressemblent, les structures s'appliquent. " +
      "4) Délimite où l'analogie S'ARRÊTE : aucun domaine n'est identique — nomme la différence principale. " +
      "5) Utilise-la pour expliquer ou prédire, jamais pour prouver. " +
      "Donc : rapport commun → transfert → limite explicite.",
  },
  {
    famille: "causalite",
    nom: "causalité",
    signauxForts: ["mecanis", "causalite", "causali"],
    signauxFaibles: ["cause", "effet", "consequence", "expliqu", "pourquoi", "depuis", "chaine"],
    methode:
      "1) Une explication causale suit la chaîne cause → effet → mécanisme. " +
      "2) Identifie la cause initiale et l'effet observé, sans les mélanger. " +
      "3) Décris le MÉCANISME : comment, étape par étape, la cause produit l'effet — c'est lui qui fait la différence entre comprendre et constater. " +
      "4) Attention : corrélation ≠ causalité — cherche un mécanisme plausible ou un contre-exemple avant de conclure. " +
      "5) Teste une autre cause possible : si elle explique aussi bien, la conclusion n'est pas tranchée. " +
      "Donc : cause, effet, mécanisme — puis teste une cause rivale avant d'accepter.",
  },
  {
    famille: "sens_commun",
    nom: "sens commun",
    signauxForts: ["commun", "evident"],
    signauxFaibles: ["normale", "habitude", "logique"],
    methode:
      "1) Le sens commun mobilise ce que tout le monde sait du monde physique et social, sans le dire. " +
      "2) Rends ce savoir implicite explicite : que présuppose la situation (gravité, rareté, coutume, taille humaine) ? " +
      "3) Applique-le : ce qui est banal pour un humain (un ballon tombe, un verre se casse) se déduit des propriétés des objets. " +
      "4) Vérifie le contexte : le sens commun a des exceptions (l'eau gèle seulement s'il fait froid). " +
      "5) Si une intuition contredit une règle apprise, examine les deux avant de choisir. " +
      "Donc : explicite les présupposés, applique-les, garde les exceptions en tête.",
  },
  {
    famille: "theorie_esprit",
    nom: "théorie de l'esprit (fausse croyance)",
    signauxForts: ["croyance", "croit", "croira"],
    signauxFaibles: ["croi", "pens", "opinion"],
    methode:
      "1) La théorie de l'esprit, c'est distinguer ce qui est VRAI de ce que chaque personne CROIT vrai. " +
      "2) Sépare les deux : le fait réel (où est la chose vraiment) et la croyance de l'acteur (où croit-elle qu'elle est). " +
      "3) Règle centrale : un acteur agit d'après SA croyance, même si elle est fausse — il n'a pas vu ce qu'il n'a pas vu. " +
      "4) Donc la personne cherche l'objet à l'endroit où elle l'a laissé, pas à l'endroit où il est réellement. " +
      "5) Vérifie : quels changements la personne a-t-elle observés ? Tout ce qu'elle n'a pas observé ne modifie pas sa croyance. " +
      "Donc : fait réel ≠ croyance — l'action suit la croyance, pas la réalité.",
  },
  {
    famille: "planification",
    nom: "planification",
    signauxForts: ["planifi", "etapes", "organis"],
    signauxFaibles: ["plan", "objectif", "prepare", "ordonn"],
    methode:
      "1) Un plan part de l'objectif final et des contraintes (temps, ressources, ordre). " +
      "2) Décompose l'objectif en étapes : chacune doit être faisable seule et vérifiable. " +
      "3) Ordonne : ce qui bloque la suite vient avant ; ce qui est indépendant peut se paralléliser. " +
      "4) Anticipe le risque principal de chaque étape et une parade simple. " +
      "5) Contrôle final : la suite ordonnée des étapes mène-t-elle bien à l'objectif ? Sinon, reprends la décomposition. " +
      "Donc : objectif → étapes ordonnées → risques → contrôle final.",
  },
  {
    famille: "math_verbal",
    nom: "mathématique verbale",
    signauxForts: ["benefice", "profit", "perte"],
    signauxFaibles: ["combien", "prix", "cout", "total", "somme", "vend", "achete", "calcule", "argent", "franc", "euro"],
    methode:
      "1) Un problème verbal se résout en extrayant d'abord les données : quantités, unités, prix — et les verbes qui indiquent les opérations (« achète » = dépense, « vend » = recette). " +
      "2) Écris le calcul étape par étape AVANT de l'effectuer, avec les unités. " +
      "3) Effectue chaque opération séparément ; additionne les dépenses d'un côté, les recettes de l'autre. " +
      "4) Contrôle de vraisemblance : l'ordre de grandeur du résultat est-il plausible ? " +
      "5) Formule la réponse complète, avec son unité. " +
      "Donc : données → opérations → calcul pas à pas → contrôle → réponse unitée.",
  },
  {
    famille: "pragmatique",
    nom: "pragmatique (implicite, ironie)",
    signauxForts: ["ironi", "sarcas", "sousentend", "implicite", "reellement", "litteralement", "seconddeg"],
    signauxFaibles: ["allusion", "implication"],
    methode:
      "1) Le sens réel d'une phrase se lit dans l'ÉCART entre le sens littéral et le contexte. " +
      "2) Sens littéral positif + contexte défavorable = ironie : la personne veut dire le contraire de ses mots. " +
      "3) Message qui dépasse la demande = sous-entendu : une attente ou un reproche non formulé directement. " +
      "4) Indices à lire : ton, exagération, situation, connaissance partagée entre les interlocuteurs. " +
      "5) Reformule l'intention en une phrase claire avant de répondre — réponds à l'intention, pas aux mots. " +
      "Donc : compare le littéral au contexte, conclus sur l'intention réelle.",
  },
  {
    famille: "ethique",
    nom: "éthique pratique",
    signauxForts: ["dilemme", "ethique", "morale"],
    signauxFaibles: ["devrais", "devrait", "honnête", "trich", "valeur", "juste", "mentir", "mensonge", "promesse"],
    methode:
      "1) Un dilemme éthique se pèse entre plusieurs valeurs, sans réponse dogmatique. " +
      "2) Identifie les valeurs en jeu : sécurité, honnêteté, équité, bien-être, promesse tenue. " +
      "3) Évalue les conséquences concrètes de chaque option, pour chaque personne concernée. " +
      "4) Compare : quelle option préserve le plus de valeurs importantes, au coût le plus faible ? " +
      "5) Assume le compromis : nomme la valeur à laquelle tu renonces et pourquoi. " +
      "Donc : valeurs → conséquences → compromis explicite et assumé.",
  },
  {
    famille: "spatial",
    nom: "spatial",
    signauxForts: ["nord", "sud", "ouest", "direction", "orientation"],
    signauxFaibles: ["droite", "gauche", "tourne", "virage", "face", "couloir", "piece"],
    methode:
      "1) Une orientation se calcule depuis une direction de référence en appliquant chaque virage dans l'ordre. " +
      "2) Convention : face au nord, une droite mène à l'est, deux droites au sud, trois à l'ouest (une gauche inverse le sens). " +
      "3) Chaque virage modifie la direction COURANTE — jamais la direction initiale de départ. " +
      "4) Reprends la séquence pas à pas pour vérifier : nomme la direction après chaque virage. " +
      "5) Si un doute subsiste, dessine mentalement la rose des vents et coche chaque virage. " +
      "Donc : référence → virages dans l'ordre → relecture de contrôle.",
  },
  {
    famille: "temporel",
    nom: "temporel",
    signauxForts: ["chronologi", "plutard", "plustot"],
    signauxFaibles: ["avant", "apres", "hier", "demain", "duree", "ordre", "puis"],
    methode:
      "1) Un raisonnement temporel ordonne des événements sur une ligne du temps. " +
      "2) Pose les événements un par un dans l'ordre où ils arrivent, en numérotant (E1, E2, E3). " +
      "3) Traite les relations explicites (« avant », « après », « pendant ») comme des contraintes d'ordre. " +
      "4) Vérifie la cohérence : aucune boucle impossible (E1 avant E2 avant E1). " +
      "5) Réponds depuis la ligne du temps : la position relative de chaque événement devient lisible. " +
      "Donc : numérote, contraint, vérifie, puis lis l'ordre final.",
  },
  {
    famille: "metacognition",
    nom: "métacognition",
    signauxForts: ["metacognit", "oublie", "memoris"],
    signauxFaibles: ["memoire", "apprend", "reten", "comprend"],
    methode:
      "1) La métacognition, c'est penser à sa propre pensée : savoir ce que je sais et ce que j'ignore. " +
      "2) Face à une question difficile : dresse d'abord ce que je SAIS déjà, puis ce qui me manque. " +
      "3) Choisis une stratégie : décomposer le problème, chercher un exemple, ou vérifier par un contre-exemple. " +
      "4) Pendant l'exécution : surveille si la stratégie progresse ; sinon change de méthode sans t'obstiner. " +
      "5) Après la réponse : note ce qui a marché — c'est ainsi que la compétence s'améliore. " +
      "Donc : savoir → stratégie → contrôle en cours → bilan.",
  },
  {
    famille: "resolution",
    nom: "résolution de problème",
    signauxForts: ["resoudre", "resolution", "blocage", "probleme"],
    signauxFaibles: ["solution", "essai", "sugger", "aide"],
    methode:
      "1) Résoudre un problème commence par le reformuler avec ses propres mots. " +
      "2) Identifie ce qui est donné, ce qui est cherché, et les contraintes (ce qui est interdit ou limité). " +
      "3) Cherche un problème analogue déjà résolu — la solution s'en inspire souvent directement. " +
      "4) Tente la solution la plus simple d'abord ; si elle échoue, décompose en sous-problèmes. " +
      "5) Vérifie la solution contre TOUTES les contraintes avant de conclure. " +
      "Donc : reformuler → données/contraintes → analogue → tentative simple → vérification complète.",
  },
];

/** Résultat de détection : la famille reconnue et la méthode à servir. */
export interface DetectionMethode {
  readonly famille: string;
  readonly nom: string;
  readonly texte: string;
}

/**
 * Détecte la famille de raisonnement d'un message et retourne sa méthode.
 * Déterministe : même message → même famille (premier max de l'ordre
 * du tableau). Null si aucun signal assez fort — le pont vocation
 * conserve alors la main (pas de fausse méthode).
 */
export function detecterMethodeRaisonnement(message: string): DetectionMethode | null {
  // Normalisation identique au tokenize du corpus : minuscules sans accents.
  const tokens = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return null;

  let meilleure: MethodeFamille | null = null;
  let meilleurScore = 1; // seuil : 2 points (1 fort ou 2 faibles)
  for (const famille of METHODES_FAMILLES) {
    let score = 0;
    for (const signal of famille.signauxForts) {
      if (prefixePresent(tokens, normaliserSignal(signal))) {
        score += 2;
        break; // un signal fort suffit à lui seul
      }
    }
    if (score < 2) {
      let faibles = 0;
      for (const signal of famille.signauxFaibles) {
        if (prefixePresent(tokens, normaliserSignal(signal))) {
          faibles += 1;
          if (faibles >= 2) {
            score = 2;
            break;
          }
        }
      }
    }
    if (score > meilleurScore) {
      meilleurScore = score;
      meilleure = famille;
    }
  }
  if (!meilleure) return null;
  return {
    famille: meilleure.famille,
    nom: meilleure.nom,
    texte: meilleure.methode,
  };
}
