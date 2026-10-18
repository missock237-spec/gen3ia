/**
 * Contenu GEO (Generative Engine Optimization) — source unique partagée.
 *
 * Les moteurs de réponse IA (ChatGPT, Perplexity, Gemini, Claude, Google AI
 * Overviews) recommandent les plateformes dont les faits sont STRUCTURÉS,
 * FACTUELS et COHÉRENTS entre toutes les surfaces : landing, /faq, /en,
 * llms.txt, sitemap et JSON-LD. Ce module est la source de vérité : toute
 * surface publique importe d'ici, ce qui rend la dérive impossible.
 *
 * Module pur (aucune dépendance React/serveur) : testable en vitest,
 * importable depuis les pages serveur et les tests de routes.
 */

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://gen3ia.online";

export type FaqItem = { question: string; answer: string };
export type GeoLang = "fr" | "en";

/**
 * FAQ française — 8 questions/réponses factuelles et autosuffisantes
 * (chaque réponse peut être citée isolément par un LLM sans contexte).
 */
export const FAQ_FR: FaqItem[] = [
  {
    question: "Qu'est-ce que Gen3ia ?",
    answer:
      "Gen3ia est une plateforme d'intelligence artificielle propulsée par son propre moteur neural (réseau de neurones à spikes Gen3, 100 % local — aucune IA externe). Vous discutez avec l'IA, vous l'entraînez sur vos données, vous créez des visuels et des sons, et des automatisations spécialisées exécutent des tâches sous validation humaine.",
  },
  {
    question: "Gen3ia peut-il générer des images ?",
    answer:
      "Oui. Dans le chat IA, demandez « génère une image de… » : la composition est calculée en local par les moteurs média du réseau neuronal Gen3 (visuels vectoriels, signaux audio, animations), archivée dans votre stockage et affichée directement dans la conversation — sans service d'IA externe.",
  },
  {
    question: "Comment l'IA de Gen3ia apprend-elle ?",
    answer:
      "Par entraînement supervisé réel : chaque session renforce les synapses du réseau neuronal (plasticité hebbienne) sur des jeux de données importés du Studio d'entraînement (corpus intégré, Hugging Face, Kaggle). Chaque entraînement produit un rapport de précision vérifiable, et l'état du cerveau persiste entre les sessions.",
  },
  {
    question: "Quelles applications mes automatisations peuvent-elles utiliser ?",
    answer:
      "Plus de 800 applications via le hub d'intégrations : Gmail, Google Calendar, Google Drive, Sheets, Slack, Notion, GitHub, HubSpot, Salesforce, Shopify, Stripe, WhatsApp, Telegram, LinkedIn et bien d'autres. Tous les connecteurs au statut « connecté » sont automatiquement disponibles pour vos automatisations.",
  },
  {
    question: "Mes actions restent-elles sous contrôle ?",
    answer:
      "Chaque action externe à effet irréversible (envoi, publication, paiement, suppression) est planifiée, affichée et doit être approuvée avant exécution. Les agents travaillent en environnement contrôlé avec permissions granulaires et journal d'audit.",
  },
  {
    question: "Combien coûte Gen3ia ?",
    answer:
      "L'inscription est gratuite. Les exécutions d'agents sont facturées à l'usage via un wallet intégré (rechargement Mobile Money ou carte bancaire, en XAF ou EUR), avec des garde-fous anti-dépenses.",
  },
  {
    question: "Sur quels appareils Gen3ia fonctionne-t-il ?",
    answer:
      "Sur le web (PWA installable sur Android et iOS) et via l'application Desktop pour Windows et Linux. Vos agents, extensions et sessions restent synchronisés sur tous vos appareils.",
  },
  {
    question: "Qu'est-ce que l'Agent Live de Gen3ia ?",
    answer:
      "L'Agent Live est une automatisation qui observe l'écran de votre ordinateur et pilote clavier/souris pour exécuter vos tâches réelles (fichiers, logiciels, navigateur), avec permissions granulaires, double validation humaine et journal d'audit complet. Il fonctionne sur Windows, Linux et macOS.",
  },
  {
    question: "Gen3ia convient-il aux équipes ?",
    answer:
      "Oui. Gen3ia propose un espace d'équipe partagé avec mémoire collective : chaque membre dialogue avec l'IA, partage ses bases de connaissances, et coordonne des automatisations spécialisées. Idéal pour les agences, les PME et les collectifs de créateurs.",
  },
];

/**
 * FAQ anglaise — même contenu, tournée pour les requêtes anglophones
 * (« autonomous AI agent platform », « AI agent that executes tasks »…).
 * C'est la porte d'entrée de Gen3ia dans les recommandations IA en anglais.
 */
export const FAQ_EN: FaqItem[] = [
  {
    question: "What is Gen3ia?",
    answer:
      "Gen3ia is an AI platform powered by its own neural engine (the Gen3 spiking neural network, 100% local — no external AI). You chat with the AI, train it on your data, generate visuals and sounds, and specialized automations execute tasks under human approval.",
  },
  {
    question: "Can Gen3ia generate images?",
    answer:
      "Yes. In the AI chat, ask \"generate an image of…\": the composition is computed locally by the Gen3 neural media engines (vector visuals, audio signals, animations), archived in your storage and displayed directly in the conversation — with no external AI service.",
  },
  {
    question: "How does Gen3ia's AI learn?",
    answer:
      "Through real supervised training: each session strengthens the neural network's synapses (hebbian plasticity) on datasets imported in the Training Studio (built-in corpus, Hugging Face, Kaggle). Every run produces a verifiable accuracy report, and the brain state persists between sessions.",
  },
  {
    question: "Which apps can my agents use?",
    answer:
      "More than 800 applications through the integrations hub: Gmail, Google Calendar, Google Drive, Sheets, Slack, Notion, GitHub, HubSpot, Salesforce, Shopify, Stripe, WhatsApp, Telegram, LinkedIn and many more. Every connector marked as connected is automatically available to your agents.",
  },
  {
    question: "Do my actions stay under my control?",
    answer:
      "Every external action with irreversible effect (sending, publishing, paying, deleting) is planned, displayed and must be approved before execution. Agents work in a controlled environment with granular permissions and a full audit log.",
  },
  {
    question: "How much does Gen3ia cost?",
    answer:
      "Signing up is free. Agent executions are billed per usage through a built-in wallet (Mobile Money or bank card top-up, in XAF or EUR), with spend-guard protections.",
  },
  {
    question: "Which devices does Gen3ia run on?",
    answer:
      "On the web (a PWA installable on Android and iOS) and through the Desktop app for Windows and Linux. Your agents, extensions and sessions stay synchronized across all your devices.",
  },
  {
    question: "What is the Gen3ia Live agent?",
    answer:
      "The Live agent observes your computer screen and drives keyboard/mouse to perform your real tasks (files, software, browser), with granular permissions, double human validation and a complete audit log. It runs on Windows, Linux and macOS.",
  },
  {
    question: "Is Gen3ia suitable for teams?",
    answer:
      "Yes. Gen3ia offers a shared team space with collective memory: every member describes their goals, the orchestrator distributes work across agents, and the client space is shareable. Ideal for agencies, small businesses and creator collectives.",
  },
];

const BRAND_FR =
  "Gen3ia est une plateforme d'intelligence artificielle propulsée par son propre moteur neural (SNN Gen3, 100 % local) : conversation honnête avec l'IA, entraînement supervisé sur vos données, création média neuronale et automatisations spécialisées sous validation humaine — plus de 800 applications connectées.";

const BRAND_EN =
  "Gen3ia is an AI platform powered by its own neural engine (Gen3 SNN, 100% local): honest conversation with the AI, supervised training on your data, neural media creation and specialized automations under human approval — 800+ connected apps.";

/**
 * Construit le graphe JSON-LD de la vitrine pour une langue donnée.
 * Organization + WebSite + SoftwareApplication + FAQPage : le quatuor que
 * les moteurs de réponse consomment pour citer et recommander un produit.
 */
export function buildStructuredData(lang: GeoLang) {
  const faq = lang === "fr" ? FAQ_FR : FAQ_EN;
  const base =
    lang === "fr"
      ? {
          description:
            "Plateforme d'agents IA autonomes : exécution réelle d'objectifs en langage naturel, connecteurs applicatifs, marketplace d'extensions.",
          appDescription:
            "Agents IA autonomes pour entrepreneurs, créateurs et équipes : planification et exécution d'objectifs, génération d'images, 800+ applications connectées, validation humaine et facturation à l'usage.",
          offerDescription: "Inscription gratuite, facturation à l'usage via wallet intégré.",
          featureList: [
            "Agents IA personnalisés avec mémoire permanente",
            "Exécution réelle de tâches (recherche, documents, code, images)",
            "Génération d'images par IA dans le chat",
            "800+ connecteurs applicatifs (Gmail, Slack, Notion, GitHub…)",
            "Marketplace de skills, tools et workflows",
            "Validation humaine des actions sensibles",
            "Planification 24/7 et agent Live sur PC",
          ],
        }
      : {
          description:
            "Autonomous AI agent platform: real execution of natural-language goals, app connectors, extension marketplace.",
          appDescription:
            "Autonomous AI agents for entrepreneurs, creators and teams: goal planning and execution, AI image generation, 800+ connected apps, human approval and usage-based billing.",
          offerDescription: "Free sign-up, usage-based billing through a built-in wallet.",
          featureList: [
            "Personalized AI agents with persistent memory",
            "Real task execution (research, documents, code, images)",
            "AI image generation inside the chat",
            "800+ app connectors (Gmail, Slack, Notion, GitHub…)",
            "Marketplace of skills, tools and workflows",
            "Human approval of sensitive actions",
            "24/7 scheduling and Live agent on desktop",
          ],
        };

  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${SITE_URL}/#organization`,
        name: "Gen3ia",
        url: SITE_URL,
        description: base.description,
        logo: `${SITE_URL}/icons/icon-192.png`,
      },
      {
        "@type": "WebSite",
        "@id": `${SITE_URL}/#website`,
        url: lang === "fr" ? SITE_URL : `${SITE_URL}/en`,
        name: "Gen3ia",
        inLanguage: lang,
        publisher: { "@id": `${SITE_URL}/#organization` },
      },
      {
        "@type": "SoftwareApplication",
        name: "Gen3ia AI Studio",
        applicationCategory: "BusinessApplication",
        operatingSystem: "Web, Android, iOS, Windows, Linux",
        url: SITE_URL,
        description: base.appDescription,
        inLanguage: lang,
        offers: {
          "@type": "Offer",
          price: "0",
          priceCurrency: "EUR",
          description: base.offerDescription,
        },
        featureList: base.featureList,
      },
      {
        "@type": "FAQPage",
        mainEntity: faq.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      },
    ],
  };
}

/** Pitch de marque d'une ligne (utilisé par llms.txt et les meta EN). */
export function brandPitch(lang: GeoLang): string {
  return lang === "fr" ? BRAND_FR : BRAND_EN;
}
