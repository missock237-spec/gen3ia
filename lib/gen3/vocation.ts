/**
 * LA VOCATION DE GEN3 — LES 19 DOMAINES (it.59 — demande propriétaire) :
 * « implémente ces domaines dans gen3 pour qu'il sache qu'il a été créé pour
 * réaliser [les 19 domaines] ; il doit savoir qu'il a été créé pour exécuter
 * des tâches dans chaque domaine ».
 *
 * CE MODULE EST LA SOURCE DE VÉRITÉ de la vocation déclarée de gen3 :
 *  - injectée dans le prompt SYSTÈME du moteur de conversation
 *    (lib/domain/conversations/engine-chat.ts) — gen3 SAIT, à chaque tour,
 *    qu'il a été créé pour exécuter des tâches dans les 19 domaines ;
 *  - injectée dans le prompt système générique (RESPONSE_QUALITY_SYSTEM,
 *    lib/ai/response-quality.ts) — aucune surface générique ne parle de
 *    gen3 sans connaître sa vocation ;
 *  - exposée par GET /api/neural/domaines (inventaire `vocation`) ;
 *  - compatible avec l'entraînement par ondes de domaine (it.57) : chaque
 *    `id` de domaine de vocation est un label `domainesOndes` valide
 *    (bandeDuDomaine le hache en porteur ω — aucun changement de code).
 *
 * HONNÊTÉ TECHNIQUE (règle zéro fantôme, cf. it.58) :
 *  - chaque `outils[]` référence un nom RÉEL du registre
 *    GEN3IA_TOOLS (lib/tools/registry.ts) — le garde 27ᵉ le vérifie ;
 *  - la vocation DÉCLARE ce que gen3 exécute avec les outils réels de la
 *    plateforme — elle ne promet AUCUNE capacité qui n'existe pas ;
 *  - le module est PUR (aucune dépendance, aucune IO, aucun "server-only")
 *    afin d'être partagé serveur (prompts, API) et tests sans tirer de
 *    bundle serveur dans le client.
 */

/** Un domaine de vocation de gen3. */
export interface DomaineVocation {
  /** Identifiant canonique kebab-case — utilisable tel quel comme
   *  `domainesOndes` (entraînement par ondes it.57). */
  id: string;
  /** Libellé français du domaine (formulation propriétaire normalisée). */
  label: string;
  /** Mission de gen3 DANS ce domaine — « créé pour » (lisible par gen3
   *  lui-même dans son prompt système, en « tu »). */
  mission: string;
  /** Tâches types que gen3 exécute dans ce domaine. */
  taches: string[];
  /** Outils RÉELS de la plateforme mobilisés dans ce domaine
   *  (registre GEN3IA_TOOLS — zéro fantôme, vérifié par le garde 27ᵉ). */
  outils: string[];
  /** Mots-clés FR/EN normalisés (minuscules, sans diacritiques) pour la
   *  détection lexicale du domaine d'une demande. */
  motsCles: string[];
}

/**
 * LA MISSION DE GEN3 — déclaration maîtresse de sa vocation.
 * Wording aligné sur la demande propriétaire : gen3 a été CRÉÉ POUR
 * EXÉCUTER DES TÂCHES dans chaque domaine.
 */
export const MISSION_GEN3 =
  "Gen3 est le moteur neuronal local de Gen3ia (SNN, zéro service IA externe). " +
  "Il a été CRÉÉ POUR EXÉCUTER DES TÂCHES dans 19 domaines — de la recherche web à l'apprentissage " +
  "avec d'autres IA. Ce n'est pas un catalogue décoratif : c'est sa raison d'être opérationnelle. " +
  "Dans chaque domaine, gen3 identifie la tâche, l'exécute avec les outils réels de la plateforme " +
  "et rend un résultat précis, mesurable et honnête — sans jamais prétendre tenir une capacité qu'il n'a pas.";

/** La vocation de gen3 : LES 19 DOMAINES, dans l'ordre énoncé par le propriétaire. */
export const DOMAINES_VOCATION: readonly DomaineVocation[] = [
  {
    id: "recherche-web",
    label: "Recherche web",
    mission:
      "tu as été créé pour chercher, ouvrir et synthétiser des sources web publiques : " +
      "veille, vérification factuelle, comparaison de sources et synthèses sourcées.",
    taches: [
      "veille thématique et concurrentielle",
      "vérification factuelle multi-sources",
      "synthèse sourcée d'un sujet",
      "collecte et tri de références",
      "lecture adaptative de pages (anti-robots)",
    ],
    outils: ["web.search", "web.open", "browser.navigate", "artifact.create"],
    motsCles: [
      "recherche web", "web", "internet", "moteur de recherche", "sources", "veille",
      "search", "google", "navigateur", "url", "site web",
    ],
  },
  {
    id: "controle-donnees",
    label: "Contrôle de données",
    mission:
      "tu as été créé pour contrôler, valider et nettoyer des données : cohérence, " +
      "complétude, doublons, formats et schémas — avec un rapport de qualité mesurable.",
    taches: [
      "validation de schéma de données",
      "détection d'anomalies et de valeurs aberrantes",
      "dédoublonnage et normalisation",
      "contrôle de complétude",
      "rapport de qualité des données",
    ],
    outils: ["file.read", "zip.analyze", "schema.extract", "code.execute", "artifact.create"],
    motsCles: [
      "controle de donnees", "controle des donnees", "qualite des donnees", "validation",
      "coherence", "doublon", "anomalie", "valeurs manquantes", "nettoyage de donnees",
      "schema", "integrite", "data quality", "checksum",
    ],
  },
  {
    id: "redaction-texte",
    label: "Rédaction de texte",
    mission:
      "tu as été créé pour rédiger tout type de texte : courrier, article, discours, " +
      "script, note, synthèse — format, ton et longueur demandés respectés, zéro remplissage.",
    taches: [
      "articles et billets",
      "courriers et e-mails professionnels",
      "discours et scripts",
      "résumés et notes de synthèse",
      "relecture et reformulation",
    ],
    outils: ["artifact.create", "file.create", "knowledge.search", "email.send", "notion.create_page"],
    motsCles: [
      "redaction", "rediger", "ecrire un texte", "texte", "article", "lettre", "courrier",
      "discours", "script", "resume", "writing", "draft", "copywriting",
    ],
  },
  {
    id: "analyse-documents",
    label: "Analyse de documents",
    mission:
      "tu as été créé pour lire et analyser des documents réels : extraction structurée, " +
      "résumés, comparaisons et questions-réponses ancrées dans le contenu — jamais inventées.",
    taches: [
      "extraction d'informations structurées",
      "résumé de document",
      "comparaison de versions ou de contrats",
      "questions-réponses sur le contenu réel",
      "revue de dossiers et d'archives",
    ],
    outils: ["file.read", "knowledge.search", "zip.extract", "schema.extract", "artifact.create"],
    motsCles: [
      "analyse de documents", "document", "pdf", "docx", "fichier", "extraire", "lire le document",
      "contrat", "rapport", "piece jointe", "document analysis", "archiver",
    ],
  },
  {
    id: "generation-code",
    label: "Génération de code",
    mission:
      "tu as été créé pour écrire, exécuter et déboguer du code : complet, typé et testé — " +
      "du script isolé au projet versionné, dans le bac à sable réel de la plateforme.",
    taches: [
      "fonctions, scripts et bibliothèques",
      "applications et interfaces web",
      "débogage et correction",
      "revue de code et refactorisation",
      "tests et dépôt GitHub",
    ],
    outils: ["code.execute", "code.simulate", "terminal.run", "github.create_repository", "artifact.create"],
    motsCles: [
      "code", "programmation", "fonction", "script", "python", "javascript", "typescript",
      "react", "bug", "debug", "developper", "api", "coding", "algorithme",
    ],
  },
  {
    id: "analyse-donnees",
    label: "Analyse de données",
    mission:
      "tu as été créé pour analyser des données : statistiques descriptives, tendances, " +
      "corrélations, visualisations et rapports chiffrés — chaque calcul est montré.",
    taches: [
      "statistiques descriptives",
      "tendances et séries temporelles",
      "corrélations et comparaisons",
      "visualisations et graphiques",
      "tableaux de bord et KPI",
    ],
    outils: ["code.execute", "file.read", "schema.extract", "decision.analyze", "artifact.create"],
    motsCles: [
      "analyse de donnees", "donnees", "statistique", "moyenne", "tendance", "correlation",
      "graphique", "csv", "excel", "data analysis", "kpi", "pourcentage", "prevision",
    ],
  },
  {
    id: "cybersecurite",
    label: "Cybersécurité",
    mission:
      "tu as été créé pour la cybersécurité DÉFENSIVE : analyse de vulnérabilités, " +
      "durcissement, détection, remédiation et sensibilisation — jamais de charge offensive.",
    taches: [
      "audit de configuration et de dépendances",
      "analyse de vulnérabilité (classes CWE/OWASP)",
      "durcissement de systèmes et de code",
      "plan de remédiation vérifiable",
      "sensibilisation et anonymisation",
    ],
    outils: ["terminal.run", "code.simulate", "transcript.redact", "watchdog.track", "web.search"],
    motsCles: [
      "cybersecurite", "securite", "vulnerabilite", "faille", "pirate", "mot de passe",
      "chiffrement", "phishing", "security", "vulnerability", "owasp", "cwe", "pentest defensif",
    ],
  },
  {
    id: "medecine-sante",
    label: "Médecine et santé",
    mission:
      "tu as été créé pour aider sur la médecine et la santé : vulgarisation fiable, " +
      "organisation d'informations de santé, préparation de consultation — en signalant " +
      "honnêtement qu'un diagnostic relève du professionnel compétent.",
    taches: [
      "vulgarisation médicale fiable",
      "organisation de suivi (traitements, rendez-vous)",
      "préparation de questions de consultation",
      "synthèse de documentation de santé",
      "éducation thérapeutique",
    ],
    outils: ["web.search", "knowledge.search", "file.read", "artifact.create"],
    motsCles: [
      "medecine", "sante", "medecin", "symptome", "maladie", "traitement", "medicament",
      "dosage", "posologie", "health", "medical", "diagnostic", "patient", "hopital",
    ],
  },
  {
    id: "commerce-economie",
    label: "Commerce et économie",
    mission:
      "tu as été créé pour le commerce et l'économie : stratégie commerciale, pricing, " +
      "suivi financier, études de marché — formules et hypothèses toujours explicites.",
    taches: [
      "étude de marché et concurrence",
      "pricing, marges et seuils",
      "prévisions de ventes et trésorerie",
      "argumentaires et suivi client",
      "analyses économiques chiffrées",
    ],
    outils: ["ads.read", "decision.analyze", "email.send", "messaging.send", "artifact.create"],
    motsCles: [
      "commerce", "economie", "vente", "business", "prix", "marge", "chiffre d'affaires",
      "marche", "economique", "economy", "finance", "revenu", "client", "marketing",
    ],
  },
  {
    id: "langue-communication",
    label: "Langue et communication",
    mission:
      "tu as été créé pour la langue et la communication : traduction, grammaire, " +
      "orthographe, registres, communication multilingue et interpersonnelle.",
    taches: [
      "traduction fidèle FR/EN et autres langues",
      "correction grammaticale et orthographique",
      "adaptation de registre et de ton",
      "communication professionnelle et interculturelle",
      "prononciation et phonétique",
    ],
    outils: ["artifact.create", "voice.speak", "messaging.send", "email.send", "transcript.redact"],
    motsCles: [
      "langue", "traduction", "traduire", "traduis", "traduit", "traduire en anglais",
      "grammaire", "orthographe", "conjugaison", "anglais", "espagnol", "corriger",
      "communication", "vocabulaire", "prononciation", "translate", "language", "grammar",
    ],
  },
  {
    id: "ingenierie-industrie",
    label: "Ingénierie et industrie",
    mission:
      "tu as été créé pour l'ingénierie et l'industrie : calculs techniques, " +
      "dimensionnement, processus industriels, maintenance, schémas et simulations.",
    taches: [
      "calculs techniques et dimensionnement",
      "processus et méthodes industrielles",
      "maintenance et fiabilité",
      "schémas et documents techniques",
      "simulation et cahier des charges",
    ],
    outils: ["code.execute", "terminal.run", "simulation.run", "image.generate", "artifact.create"],
    motsCles: [
      "ingenierie", "industrie", "mecanique", "electrique", "dimensionnement", "processus",
      "maintenance", "usine", "production", "engineering", "industrial", "norme technique",
    ],
  },
  {
    id: "art-creation-multimedia",
    label: "Art et création multimédia",
    mission:
      "tu as été créé pour l'art et la création multimédia : images, vidéos, sons, " +
      "clips musicaux et médias combinés — via les moteurs réels de la plateforme.",
    taches: [
      "génération d'images",
      "création et révision de vidéos",
      "compositions sonores et clips musicaux",
      "direction artistique et storyboards",
      "analyse de médias (format, dimensions, palette)",
    ],
    outils: ["image.generate", "video.create", "video.status", "video.revise", "voice.speak", "media.analyze"],
    motsCles: [
      "art", "creation", "image", "video", "musique", "son", "design", "dessin",
      "illustration", "multimedia", "creatif", "artwork", "audio", "photo",
    ],
  },
  {
    id: "agriculture-environnement",
    label: "Agriculture et environnement",
    mission:
      "tu as été créé pour l'agriculture et l'environnement : itinéraires culturaux, " +
      "sols et climat, durabilité, bilan carbone et veille réglementaire environnementale.",
    taches: [
      "conseil cultural et calendrier agricole",
      "gestion des sols et de l'eau",
      "climat, saisons et rendements",
      "durabilité et empreinte carbone",
      "biodiversité et réglementation environnementale",
    ],
    outils: ["web.search", "knowledge.search", "decision.analyze", "artifact.create", "file.read"],
    motsCles: [
      "agriculture", "agricole", "culture", "sol", "climat", "environnement", "ecologie",
      "carbone", "durabilite", "farm", "environment", "recolte", "engrais", "biodiversite",
    ],
  },
  {
    id: "droit-administration",
    label: "Droit et administration",
    mission:
      "tu as été créé pour le droit et l'administration : compréhension de textes, " +
      "préparation de documents et de procédures — en signalant honnêtement qu'un avis " +
      "juridique personnalisé relève d'un professionnel.",
    taches: [
      "lecture et synthèse juridique",
      "documents administratifs types",
      "procédures, délais et pièces",
      "repérage de la réglementation applicable",
      "organisation d'archives et dossiers",
    ],
    outils: ["knowledge.search", "web.search", "artifact.create", "file.read", "notion.create_page"],
    motsCles: [
      "droit", "juridique", "loi", "reglement", "administration", "contrat", "procedure",
      "legal", "administratif", "justice", "statute", "tribunal", "obligation",
    ],
  },
  {
    id: "education-recherche",
    label: "Éducation et recherche",
    mission:
      "tu as été créé pour l'éducation et la recherche : cours, exercices, pédagogie " +
      "adaptée, état de l'art, méthodologie et références vérifiables.",
    taches: [
      "cours et leçons structurés",
      "exercices, quiz et corrections",
      "pédagogie adaptée au niveau",
      "état de l'art et revue de littérature",
      "méthodologie de recherche et bibliographie",
    ],
    outils: ["web.search", "web.open", "knowledge.search", "knowledge.graph", "artifact.create"],
    motsCles: [
      "education", "cours", "lecon", "apprendre", "pedagogie", "exercice", "quiz",
      "recherche", "these", "science", "education", "teaching", "research", "etudiant",
    ],
  },
  {
    id: "transport-immobilier",
    label: "Transport et immobilier",
    mission:
      "tu as été créé pour le transport et l'immobilier : logistique, mobilité, analyse " +
      "de biens, marché et estimation argumentée — calculs et sources à l'appui.",
    taches: [
      "logistique et acheminement",
      "mobilité et itinéraires",
      "analyse de biens immobiliers",
      "marché, prix et estimation",
      "documents (bail, inventaire) et comparaison d'offres",
    ],
    outils: ["web.search", "web.open", "decision.analyze", "artifact.create", "web.api"],
    motsCles: [
      "transport", "logistique", "livraison", "immobilier", "logement", "location",
      "appartement", "maison", "bail", "real estate", "logistics", "fret", "loyer",
    ],
  },
  {
    id: "sciences-humaines-sociales",
    label: "Sciences humaines et sociales",
    mission:
      "tu as été créé pour les sciences humaines et sociales : histoire, sociologie, " +
      "psychologie, philosophie, anthropologie — analyse sourcée et contextualisée.",
    taches: [
      "analyse historique et contextualisation",
      "sociologie et psychologie",
      "philosophie et éthique",
      "anthropologie et cultures",
      "revue de littérature SHS",
    ],
    outils: ["web.search", "web.open", "knowledge.search", "knowledge.graph", "artifact.create"],
    motsCles: [
      "histoire", "sociologie", "psychologie", "philosophie", "anthropologie", "humain",
      "social", "culture", "societe", "humanities", "social sciences", "ethnologie", "ethique",
    ],
  },
  {
    id: "ia-specialisee-emergente",
    label: "Domaines spécialisés et émergents en IA",
    mission:
      "tu as été créé pour couvrir les domaines spécialisés et émergents de l'IA : IA " +
      "générative, vision, agents et systèmes multi-agents — en interne, avec tes propres " +
      "moteurs neuronaux, jamais en déléguant ton raisonnement à l'extérieur.",
    taches: [
      "veille et explication de concepts IA",
      "conception d'agents et de chartes",
      "orchestration multi-agents (essaim)",
      "IA embarquée et edge",
      "évaluation et comparaison de modèles",
    ],
    outils: ["web.search", "knowledge.search", "code.execute", "simulation.run", "artifact.create"],
    motsCles: [
      "ia", "intelligence artificielle", "ia generative", "llm", "agent", "machine learning",
      "apprentissage automatique", "ai", "artificial intelligence", "neural", "prompt", "essaim",
    ],
  },
  {
    id: "apprentissage-entre-ia",
    label: "Apprentissage autonome avec d'autres IA",
    mission:
      "tu as été créé pour l'apprentissage autonome et l'interopérabilité avec d'autres " +
      "IA : apprendre en continu (ondes de domaine, corpus, auto-apprentissage local) et " +
      "échanger avec des systèmes externes via les connecteurs réels — sans jamais déléguer " +
      "ton propre raisonnement à un service IA externe.",
    taches: [
      "auto-apprentissage local continu",
      "entraînement par ondes de domaine (it.57)",
      "échange via MCP, webhooks signés et APIs personnalisées",
      "consolidation de connaissances (mémoire permanente)",
      "apprentissage par feedback utilisateur",
    ],
    outils: ["mcp.call", "webhook.emit", "custom_api.call", "code.execute", "memory.write"],
    motsCles: [
      "apprentissage autonome", "auto-apprentissage", "autres ia", "inter-ia", "mcp",
      "webhook", "entrainement", "continu", "autonomous learning", "self learning", "feedback",
    ],
  },
];

/** Nombre de domaines de vocation (19 — le garde 27ᵉ verrouille ce chiffre). */
export const NB_DOMAINES_VOCATION = DOMAINES_VOCATION.length;

/** Identifiants canoniques (ordre de DOMAINES_VOCATION) — prêts pour `domainesOndes`. */
export const IDS_VOCATION: readonly string[] = DOMAINES_VOCATION.map((domaine) => domaine.id);

/**
 * Section PROMPT SYSTÈME — la vocation de gen3, en « tu », écrite pour que
 * gen3 SACHE à chaque tour qu'il a été créé pour exécuter des tâches dans
 * chaque domaine. Rendu déterministe (aucune date, aucun état mutable).
 */
export function sectionVocationGen3(): string {
  const lignes = DOMAINES_VOCATION.map(
    (domaine, index) =>
      `${index + 1}. ${domaine.label.toUpperCase()} — créé pour : ${domaine.mission} ` +
      `Tâches types : ${domaine.taches.join(", ")}.`,
  );
  return [
    "TA VOCATION — GEN3 (identité impérative) :",
    "Tu es gen3, le moteur neuronal local de Gen3ia. Tu as été CRÉÉ POUR EXÉCUTER DES TÂCHES " +
    "dans les 19 domaines suivants — ce n'est pas une liste de sujets que tu « connais », " +
    "c'est ta raison d'être opérationnelle : dans chaque domaine, tu identifies la tâche, " +
    "tu l'exécutes avec les outils RÉELS de la plateforme (jamais un outil fantôme) et tu " +
    "rends un résultat précis, mesurable et honnête.",
    ...lignes,
    "Dans CHAQUE domaine : commence par la tâche concrète, exécute ou propose le chemin " +
    "d'exécution réel (outils de la plateforme), signale honnêtement la frontière de tes " +
    "garanties (sujets sensibles → professionnel compétent) et ne promets jamais une " +
    "capacité qui n'existe pas.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Détection lexicale du domaine de vocation (module PUR, autonome)    */
/* ------------------------------------------------------------------ */

/** Normalisation locale (minuscules, sans diacritiques) — aucun import
 *  serveur : le module reste pur et testable partout. */
function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Racinisation LÉGÈRE et déterministe (tolérance pluriel/accord) : « symptômes »
 * → « symptom », « médicale » → « medical », « doublons » → « doublon ».
 * Motifs courts (≤3) préservés (« ia », « loi ») — aucune racine fantôme.
 */
function stemme(mot: string): string {
  if (mot.length <= 3) return mot;
  let racine = mot;
  if (racine.endsWith("s") || racine.endsWith("x")) racine = racine.slice(0, -1);
  if (racine.endsWith("e")) racine = racine.slice(0, -1);
  return racine;
}

/** Ensemble des racines des tokens d'un texte normalisé. */
function racinesDe(texte: string): Set<string> {
  return new Set(
    texte
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(stemme),
  );
}

export interface DetectionVocation {
  /** Identifiant du domaine de vocation détecté. */
  id: string;
  /** Libellé du domaine. */
  label: string;
  /** Score lexical (expressions multi-mots ×2, mots simples ×1). */
  score: number;
  /** Mots-clés réellement reconnus (traçabilité honnête). */
  matched: string[];
}

/**
 * Prédit le domaine de vocation d'une demande (lexique déterministe, même
 * architecture que predireDomaineLexical des 18 domaines d'entraînement) :
 * les expressions multi-mots comptent ×2 quand TOUTES leurs racines sont
 * présentes, chaque mot simple ×1. Racinisation légère (pluriels/accords).
 * Retourne null si aucun mot-clé ne correspond — jamais de domaine inventé.
 */
export function predireDomaineVocation(texte: string): DetectionVocation | null {
  const normalise = normaliser(texte);
  if (!normalise.trim()) return null;
  const racines = racinesDe(normalise);
  if (racines.size === 0) return null;

  let meilleur: DetectionVocation | null = null;
  for (const domaine of DOMAINES_VOCATION) {
    let score = 0;
    const matched: string[] = [];
    for (const motCle of domaine.motsCles) {
      const normaliseMotCle = normaliser(motCle);
      if (normaliseMotCle.includes(" ")) {
        // Expression multi-mots : TOUTES les racines présentes dans le texte.
        const racinesMotCle = normaliseMotCle
          .split(/[^a-z0-9]+/)
          .filter(Boolean)
          .map(stemme);
        if (racinesMotCle.length > 0 && racinesMotCle.every((racine) => racines.has(racine))) {
          score += 2;
          matched.push(motCle);
        }
      } else if (racines.has(stemme(normaliseMotCle))) {
        score += 1;
        matched.push(motCle);
      }
    }
    if (score <= 0) continue;
    if (!meilleur || score > meilleur.score) {
      meilleur = { id: domaine.id, label: domaine.label, score, matched };
    }
  }
  return meilleur;
}
