import Link from "next/link";

import { AppDownloads } from "@/components/home/app-downloads";
import { VitrineHeader } from "@/components/home/vitrine-header";
import { GenChatWidget } from "@/components/gen/gen-chat";

/**
 * Vitrine SaaS de Gen3ia — page d'accueil publique.
 *
 * Design « Runable » : dégradé ciel bleu, typographie serif éditoriale,
 * cartes blanches très arrondies, boîte de prompt centrale, section
 * storytelling crème, pied de page brun avec ligne arc-en-ciel.
 * Animations : entrées en cascade au chargement, révélation au scroll
 * (ScrollReveal), halos pulsants — désactivées si prefers-reduced-motion.
 */

const PRODUCT_LINKS = [
  { href: "/studio", label: "Studio" },
  { href: "/live", label: "Agent Live" },
  { href: "/marketplace", label: "Marketplace" },
];

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://gen3ia.online";

/**
 * FAQ publique : questions/réponses concises ET données structurées
 * schema.org (FAQPage, SoftwareApplication, Organization, WebSite).
 * Les moteurs de réponse (ChatGPT, Perplexity, Gemini, Google AI Overviews)
 * citent en priorité les contenus structurés, complets et factuels — c'est
 * le canal de recommandation « IA vers utilisateurs » de Gen3ia.
 */
const FAQ_ITEMS = [
  {
    question: "Qu'est-ce que Gen3ia ?",
    answer:
      "Gen3ia est une plateforme d'agents IA autonomes. Vous décrivez un objectif en une phrase : un agent personnalisé le planifie, l'exécute (recherche web, documents, génération d'images, applications connectées) et livre un résultat vérifié. Les actions sensibles sont toujours validées par un humain.",
  },
  {
    question: "Gen3ia peut-il générer des images ?",
    answer:
      "Oui. Dans le chat IA et le chat de vos agents, demandez « génère une image de… » : l'image est réellement générée par IA (Agnes Image 2.5 Flash) et affichée directement dans la conversation.",
  },
  {
    question: "Quelles applications mes agents peuvent-ils utiliser ?",
    answer:
      "Plus de 800 applications via le hub d'intégrations : Gmail, Google Calendar, Google Drive, Sheets, Slack, Notion, GitHub, HubSpot, Salesforce, Shopify, Stripe, WhatsApp, Telegram, LinkedIn et bien d'autres. Tous les connecteurs au statut « connecté » sont automatiquement disponibles pour vos agents.",
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
];

const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: "Gen3ia",
      url: SITE_URL,
      description:
        "Plateforme d'agents IA autonomes : exécution réelle d'objectifs en langage naturel, connecteurs applicatifs, marketplace d'extensions.",
      logo: `${SITE_URL}/icons/icon-192.png`,
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      url: SITE_URL,
      name: "Gen3ia",
      inLanguage: "fr",
      publisher: { "@id": `${SITE_URL}/#organization` },
    },
    {
      "@type": "SoftwareApplication",
      name: "Gen3ia AI Studio",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web, Android, iOS, Windows, Linux",
      url: SITE_URL,
      description:
        "Agents IA autonomes pour entrepreneurs, créateurs et équipes : planification et exécution d'objectifs, génération d'images, 800+ applications connectées, validation humaine et facturation à l'usage.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "EUR",
        description: "Inscription gratuite, facturation à l'usage via wallet intégré.",
      },
      featureList: [
        "Agents IA personnalisés avec mémoire permanente",
        "Exécution réelle de tâches (recherche, documents, code, images)",
        "Génération d'images par IA dans le chat",
        "800+ connecteurs applicatifs (Gmail, Slack, Notion, GitHub…)",
        "Marketplace de skills, tools et workflows",
        "Validation humaine des actions sensibles",
        "Planification 24/7 et agent Live sur PC",
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ_ITEMS.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ],
};

const STATS = [
  { value: "3 espaces", label: "Studio, Live & Marketplace intégrés" },
  { value: "24/7", label: "Agents autonomes planifiables" },
  { value: "100%", label: "Actions sensibles validées par un humain" },
  { value: "XAF/EUR", label: "Facturation à l'usage, wallet intégré" },
];

const CAPABILITIES = [
  { href: "/studio", label: "Agents IA", icon: "M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-4Z" },
  { href: "/live", label: "Agent Live", icon: "M2 3h20v14H2zM8 21h8M12 17v4" },
  { href: "/marketplace", label: "Marketplace", icon: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4H6Z" },
  { href: "/studio/interface-lab", label: "Interfaces pro", icon: "m8 6-6 6 6 6M16 6l6 6-6 6" },
  { href: "/studio/schedules", label: "Planification", icon: "M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
  { href: "/storage", label: "Stockage", icon: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z" },
  { href: "/team", label: "Équipes", icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" },
  { href: "/developer", label: "Développeurs", icon: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" },
  { href: "/billing", label: "Wallet intégré", icon: "M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4Z" },
];

const SOLUTIONS = [
  {
    title: "Entrepreneurs & petites entreprises",
    text: "Veille concurrentielle, relances clients, rapports quotidiens : vos agents exécutent l'opérationnel pendant que vous faites grandir l'activité.",
    href: "/studio",
    cta: "Lancer un agent",
    icon: "M3 3h18v18H3zM3 9h18M9 21V9",
  },
  {
    title: "Créateurs de contenu",
    text: "Scripts, visages de marque, carrousels et publications planifiées : décrivez une idée, l'agent produit, vous validez, tout part au bon moment.",
    href: "/studio/schedules",
    cta: "Planifier du contenu",
    icon: "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z",
  },
  {
    title: "Équipes & agences",
    text: "Espace d'équipe partagé, mémoire collective et agents coordonnés : chaque membre décrit un objectif, l'orchestrateur répartit le travail.",
    href: "/team",
    cta: "Créer une équipe",
    icon: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm14 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  },
];

const PRODUCTS = [
  {
    href: "/studio",
    eyebrow: "Gen3ia Studio",
    title: "Studio d’agents IA",
    description:
      "Créez, équipez et déployez des agents autonomes en quelques minutes. Objectifs en langage naturel, orchestration automatique des compétences, mémoire permanente et environnement contrôlé.",
    points: ["Orchestration multi-compétences", "Mémoire persistante par agent", "Terminal sandboxé réservé aux agents"],
    cta: "Ouvrir le Studio",
    icon: "M12 2 4 6v6c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6l-8-4Zm-3 10 2 2 4-4",
    badge: null as string | null,
  },
  {
    href: "/live",
    eyebrow: "Gen3ia Live",
    title: "Agent Live sur votre PC",
    description:
      "Un agent qui observe votre écran et pilote clavier/souris pour exécuter vos tâches réelles, avec permissions granulaires, double validation humaine et journal d'audit complet.",
    points: ["Observation d'écran en direct", "Contrôle clavier & souris validé", "Réservé aux ordinateurs (Windows, Linux, macOS)"],
    cta: "Découvrir Agent Live",
    icon: "M2 3h20v14H2zM8 21h8M12 17v4m-2-8-2 2 2 2m4-4 2 2-2 2",
    badge: "PC",
  },
  {
    href: "/marketplace",
    eyebrow: "Gen3ia Marketplace",
    title: "Marketplace d’extensions",
    description:
      "Étendez vos agents avec des tools, skills et workflows créés par la communauté. Chaque extension est versionnée, notée, sandboxée et contrôlée par des permissions explicites.",
    points: ["Installation en un clic", "Permissions vérifiables avant achat", "Revenus développeur intégrés"],
    cta: "Parcourir la Marketplace",
    icon: "M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4H6Zm0 4h18M16 10a4 4 0 0 1-8 0",
    badge: null as string | null,
  },
];

const STORY_CARDS = [
  {
    title: "Aïcha décrit son objectif en une phrase.",
    body: (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4" aria-hidden="true">
        <p className="rounded-xl bg-gradient-to-br from-violet-500 to-indigo-500 px-4 py-2.5 text-xs font-medium text-white">
          « Lance une veille concurrentielle chaque matin et prépare-moi un résumé. »
        </p>
        <p className="mt-2.5 rounded-xl border border-white/10 px-3.5 py-2 text-xs text-white/55">
          Très bien — je planifie la recherche, les sources et le rapport.
        </p>
      </div>
    ),
  },
  {
    title: "Son agent travaille, valide et exécute.",
    body: (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4" aria-hidden="true">
        <div className="flex items-center justify-between border-b border-white/[0.06] pb-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-white/40">Exécution</span>
          <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] font-bold text-emerald-300">Validée</span>
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-2 w-3/4 rounded-full bg-white/10" />
          <div className="h-2 w-1/2 rounded-full bg-white/10" />
          <div className="h-2 w-2/3 rounded-full bg-cyan-400/30" />
        </div>
      </div>
    ),
  },
  {
    title: "Le rapport l’attend, chaque matin.",
    body: (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4" aria-hidden="true">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-white/40">Résumés</p>
        <p className="mt-1.5 nx-gradient-text text-3xl font-semibold">+38 %</p>
        <p className="mt-1.5 text-xs text-white/55">Temps gagné sur la veille le premier mois.</p>
      </div>
    ),
  },
];

const STEPS = [
  {
    number: "01",
    title: "Créez votre compte",
    text: "Inscription en une minute : prénom, nom, email. Votre wallet de démonstration est crédité automatiquement pour tester la plateforme.",
  },
  {
    number: "02",
    title: "Décrivez votre objectif",
    text: "En langage naturel, depuis le Studio. L'orchestrateur sélectionne les outils, compétences et extensions nécessaires, puis exécute dans un environnement contrôlé.",
  },
  {
    number: "03",
    title: "Validez et laissez tourner",
    text: "Les actions sensibles attendent votre validation. Vos agents planifiés continuent de travailler pour vous, 24h/24, dans le cadre que vous avez défini.",
  },
];

const SECURITY_POINTS = [
  "Aucun accès direct utilisateur au shell d'exécution — terminal réservé aux agents en sandbox",
  "Caméra et fichiers : uniquement après autorisation explicite de l'utilisateur",
  "Dépenses publicitaires et actions externes soumises à confirmation humaine",
  "Jetons OAuth stockés chiffrés côté serveur, sessions signées et expirables",
];

const ARROW = "M5 12h14M13 6l6 6-6 6";

function Icon({ d, size = 18, className = "" }: { d: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={d} />
    </svg>
  );
}

const MARQUEE_APPS = ["Gmail", "Slack", "Notion", "GitHub", "HubSpot", "Stripe", "Shopify", "WhatsApp", "Google Drive", "Salesforce", "Telegram", "LinkedIn", "Sheets", "Calendar"];

export default function HomePage() {
  // Vitrine publique servie à la racine : indispensable au référencement
  // (Google/Bing) ET à la recommandation par les LLM (ChatGPT, Perplexity,
  // Claude…) qui doivent lire FAQ + données structurées.
  return (
    <div className="nx-root flex min-h-full flex-col">
      <VitrineHeader />

      <div className="flex-1">
        {/* ---------- Héros ---------- */}
        <section className="relative overflow-hidden">
          <div className="nx-grid" aria-hidden="true" />
          <div className="nx-orb nx-orb-a" aria-hidden="true" />
          <div className="nx-orb nx-orb-b" aria-hidden="true" />
          <div className="relative mx-auto max-w-6xl px-4 pb-20 pt-16 sm:px-6 sm:pt-24">
            <div className="mx-auto max-w-3xl text-center">
              <Link href="/marketplace" className="nx-pill anim-fade-up">
                <span className="nx-pill-dot" /> Nouveau · Agent Live & 800+ connecteurs
                <Icon d={ARROW} size={13} />
              </Link>
              <h1 className="anim-fade-up anim-delay-1 mt-7 text-5xl font-semibold leading-[1.02] tracking-[-0.04em] text-white sm:text-7xl">
                Vos idées,{" "}
                <span className="nx-gradient-text">exécutées</span>
                <br />
                par des agents IA.
              </h1>
              <p className="anim-fade-up anim-delay-2 mx-auto mt-6 max-w-xl text-base leading-8 text-white/60 sm:text-lg">
                Décrivez un objectif en une phrase. Gen3ia planifie, agit sur vos
                applications et livre un résultat vérifié — vous gardez la main sur
                chaque action sensible.
              </p>

              {/* Composer */}
              <form action="/signup" className="anim-fade-up anim-delay-3 mx-auto mt-10 max-w-2xl text-left">
                <div className="nx-composer">
                  <label htmlFor="hero-intent" className="sr-only">Décrivez votre idée</label>
                  <textarea
                    id="hero-intent"
                    name="intent"
                    rows={3}
                    placeholder="Ex : chaque lundi, analyse mes ventes Shopify et envoie un résumé sur Slack…"
                    className="w-full resize-none bg-transparent px-2 py-1.5 text-[15px] text-white outline-none placeholder:text-white/35"
                  />
                  <div className="flex items-center justify-between gap-3 px-1 pt-2">
                    <div className="flex flex-wrap gap-1.5">
                      {["Recherche web", "Images", "Documents"].map((tag) => (
                        <span key={tag} className="nx-tag">{tag}</span>
                      ))}
                    </div>
                    <button type="submit" aria-label="Commencer avec cette idée" className="nx-send">
                      <Icon d={ARROW} size={17} />
                    </button>
                  </div>
                </div>
              </form>

              <ul className="anim-fade-up anim-delay-4 mx-auto mt-6 flex max-w-3xl flex-wrap justify-center gap-2">
                {CAPABILITIES.map((capability) => (
                  <li key={capability.label}>
                    <Link href={capability.href} className="nx-chip">
                      <Icon d={capability.icon} size={14} className="text-cyan-300" />
                      {capability.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            {/* Aperçu produit */}
            <div className="reveal relative mx-auto mt-16 max-w-5xl">
              <div className="nx-glow-frame">
                <div className="nx-window">
                  <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
                    <span className="ml-3 text-xs text-white/40">gen3ia.online/studio</span>
                  </div>
                  <div className="grid gap-0 md:grid-cols-[1.3fr_1fr]">
                    <div className="space-y-3 p-5 sm:p-6">
                      <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-br from-violet-500 to-indigo-500 px-4 py-2.5 text-sm text-white">
                        Lance une veille concurrentielle chaque matin et prépare-moi un résumé.
                      </div>
                      <div className="max-w-[90%] rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.04] px-4 py-3 text-sm text-white/75">
                        Plan établi : 12 sources, synthèse IA, envoi à 8h. J&apos;attends votre validation pour l&apos;envoi par email.
                      </div>
                      <div className="flex items-center gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-200">
                        <Icon d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" size={15} />
                        Action sensible : envoi d&apos;email — <strong className="font-semibold">Approuver ?</strong>
                      </div>
                    </div>
                    <div className="border-t border-white/[0.06] p-5 font-mono text-[11px] sm:p-6 md:border-l md:border-t-0">
                      <p className="mb-3 font-sans text-[10px] font-semibold uppercase tracking-[.2em] text-white/35">Exécution en direct</p>
                      {[
                        { c: "text-cyan-300", l: "agent.recherche", t: "12 sources analysées" },
                        { c: "text-violet-300", l: "tool.image", t: "Visuel généré" },
                        { c: "text-amber-300", l: "permission", t: "En attente d'approbation" },
                        { c: "text-emerald-300", l: "humain.valide", t: "Envoi approuvé" },
                        { c: "text-fuchsia-300", l: "wallet", t: "Coût : 12,50 XAF" },
                      ].map((row, index) => (
                        <div key={row.l} className="anim-fade-in mb-2 flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2" style={{ animationDelay: `${0.6 + index * 0.25}s`, animationFillMode: "both" }}>
                          <span className={`shrink-0 font-semibold ${row.c}`}>{row.l}</span>
                          <span className="truncate text-white/45">{row.t}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ---------- Défilement de logos ---------- */}
        <section aria-label="Applications connectées" className="border-y border-white/[0.06] py-6">
          <p className="mb-4 text-center text-[11px] font-semibold uppercase tracking-[.25em] text-white/35">Connecté à plus de 800 applications</p>
          <div className="nx-marquee">
            <div className="nx-marquee-track">
              {[...MARQUEE_APPS, ...MARQUEE_APPS].map((app, index) => (
                <span key={`${app}-${index}`} className="nx-marquee-item">{app}</span>
              ))}
            </div>
          </div>
        </section>

        {/* ---------- Statistiques ---------- */}
        <section aria-label="Chiffres clés" className="mx-auto max-w-6xl px-4 pt-20 sm:px-6">
          <dl className="reveal grid grid-cols-2 gap-px overflow-hidden rounded-3xl border border-white/[0.07] bg-white/[0.07] sm:grid-cols-4">
            {STATS.map((stat) => (
              <div key={stat.label} className="flex flex-col bg-[#0b0c12] p-6 text-center">
                <dd className="order-1 nx-gradient-text text-2xl font-semibold tracking-tight sm:text-3xl">{stat.value}</dd>
                <dt className="order-2 mt-2 text-xs leading-5 text-white/45">{stat.label}</dt>
              </div>
            ))}
          </dl>
        </section>

        {/* ---------- Produits ---------- */}
        <section id="produits" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-24 sm:px-6">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="nx-eyebrow">Trois espaces, une plateforme</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">
              Tout pour mettre les agents au travail
            </h2>
            <p className="mt-4 text-sm leading-7 text-white/55 sm:text-base">
              Vos agents, extensions et sessions restent synchronisés à votre compte, sur tous vos appareils.
            </p>
          </div>
          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {PRODUCTS.map((product, index) => (
              <article key={product.href} className="nx-card nx-card-hover reveal flex flex-col p-7" style={{ ["--reveal-delay" as string]: `${index * 0.12}s` }}>
                <div className="nx-icon"><Icon d={product.icon} size={22} /></div>
                <p className="mt-6 text-[11px] font-semibold uppercase tracking-[.22em] text-white/40">
                  {product.eyebrow}
                  {product.badge && <span className="ml-2 rounded-md bg-amber-400/15 px-1.5 py-0.5 text-[9px] text-amber-300">{product.badge}</span>}
                </p>
                <h3 className="mt-2 text-2xl font-semibold tracking-tight text-white">{product.title}</h3>
                <p className="mt-3 flex-1 text-sm leading-6 text-white/55">{product.description}</p>
                <ul className="mt-5 space-y-2.5">
                  {product.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-sm text-white/70">
                      <Icon d="m5 12 5 5L20 7" size={15} className="mt-0.5 shrink-0 text-emerald-400" />
                      {point}
                    </li>
                  ))}
                </ul>
                <Link href={product.href} className="group mt-7 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-white transition hover:text-cyan-300">
                  {product.cta}
                  <Icon d={ARROW} size={14} className="transition-transform group-hover:translate-x-1" />
                </Link>
              </article>
            ))}
          </div>
        </section>

        {/* ---------- Bento ---------- */}
        <section aria-label="Capacités détaillées" className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <article className="nx-card nx-card-hover reveal relative overflow-hidden p-7 sm:col-span-2">
              <div className="nx-icon"><Icon d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" /></div>
              <h3 className="mt-5 text-lg font-semibold text-white">Mémoire permanente</h3>
              <p className="mt-1.5 max-w-md text-sm leading-6 text-white/55">Vos agents se souviennent du contexte utile de vos projets, avec protection des secrets et contrôle propriétaire.</p>
              <div className="mt-6 space-y-2" aria-hidden="true">
                <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-white/[0.07] bg-white/[0.04] px-4 py-2.5 text-xs text-white/70">Retiens la charte graphique du projet Nebula.</div>
                <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-gradient-to-br from-violet-500 to-indigo-500 px-4 py-2.5 text-xs text-white">Mémorisé — 3 souvenirs liés à ce projet.</div>
              </div>
            </article>
            {[
              { t: "Sécurité par conception", d: "Sandbox isolée, permissions granulaires, garde-fous anti-dépenses et validation humaine.", i: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z", c: "text-emerald-300" },
              { t: "Facturation à l'usage", d: "Wallet intégré, Mobile Money ou carte. Vous ne payez que ce que vos agents exécutent.", i: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6", c: "text-fuchsia-300" },
              { t: "Planification 24/7", d: "Le serveur applique le planning même application fermée.", i: "M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", c: "text-amber-300" },
              { t: "Interfaces pro", d: "Composants et thèmes professionnels adaptés par vos agents de code.", i: "m8 6-6 6 6 6M16 6l6 6-6 6", c: "text-cyan-300" },
            ].map((tile) => (
              <article key={tile.t} className="nx-card nx-card-hover reveal p-6">
                <div className={`nx-icon ${tile.c}`}><Icon d={tile.i} /></div>
                <h3 className="mt-5 text-base font-semibold text-white">{tile.t}</h3>
                <p className="mt-1.5 text-sm leading-6 text-white/55">{tile.d}</p>
              </article>
            ))}
            <article className="nx-card nx-card-hover reveal relative overflow-hidden p-7 sm:col-span-2 lg:col-span-1">
              <div className="nx-icon"><Icon d="M2 3h20v14H2zM8 21h8M12 17v4" /></div>
              <h3 className="mt-5 text-base font-semibold text-white">Partout avec vous</h3>
              <p className="mt-1.5 text-sm leading-6 text-white/55">Web, PWA Android & iOS, Desktop Windows & Linux — tout reste synchronisé.</p>
            </article>
          </div>
        </section>

        {/* ---------- Pour qui ---------- */}
        <section aria-label="Pour qui" className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="nx-eyebrow">Pour qui</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">Une idée, menée jusqu&apos;au bout</h2>
          </div>
          <div className="mt-14 grid gap-5 md:grid-cols-3">
            {SOLUTIONS.map((solution, index) => (
              <article key={solution.title} className="nx-card nx-card-hover reveal flex flex-col p-7" style={{ ["--reveal-delay" as string]: `${index * 0.12}s` }}>
                <div className="nx-icon"><Icon d={solution.icon} size={20} /></div>
                <h3 className="mt-5 text-lg font-semibold text-white">{solution.title}</h3>
                <p className="mt-2.5 flex-1 text-sm leading-6 text-white/55">{solution.text}</p>
                <Link href={solution.href} className="group mt-6 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-cyan-300 transition hover:text-cyan-200">
                  {solution.cta}
                  <Icon d={ARROW} size={14} className="transition-transform group-hover:translate-x-1" />
                </Link>
              </article>
            ))}
          </div>
        </section>

        {/* ---------- Fonctionnement ---------- */}
        <section id="fonctionnement" className="mx-auto max-w-6xl scroll-mt-24 px-4 pb-24 sm:px-6">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="nx-eyebrow">Fonctionnement</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">De l&apos;idée au résultat en 3 étapes</h2>
          </div>
          <ol className="relative mt-14 grid gap-5 md:grid-cols-3">
            <div className="nx-steps-line hidden md:block" aria-hidden="true" />
            {STEPS.map((step, index) => (
              <li key={step.number} className="nx-card reveal relative p-7" style={{ ["--reveal-delay" as string]: `${index * 0.12}s` }}>
                <span className="nx-step-num">{step.number}</span>
                <h3 className="mt-5 text-lg font-semibold text-white">{step.title}</h3>
                <p className="mt-2.5 text-sm leading-6 text-white/55">{step.text}</p>
              </li>
            ))}
          </ol>
          <div className="mt-5 grid gap-5 md:grid-cols-3">
            {STORY_CARDS.map((card) => (
              <article key={card.title} className="nx-card reveal p-6">
                <h3 className="text-sm font-semibold text-white/85">{card.title}</h3>
                <div className="mt-4">{card.body}</div>
              </article>
            ))}
          </div>
        </section>

        {/* ---------- Sécurité ---------- */}
        <section id="securite" className="mx-auto max-w-6xl scroll-mt-24 px-4 pb-24 sm:px-6">
          <div className="nx-card reveal grid gap-10 overflow-hidden p-8 sm:p-12 lg:grid-cols-2">
            <div>
              <p className="nx-eyebrow">Sécurité & contrôle</p>
              <h2 className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">L&apos;autonomie, sans perdre le contrôle</h2>
              <ul className="mt-8 space-y-4">
                {SECURITY_POINTS.map((point) => (
                  <li key={point} className="flex items-start gap-3 text-sm leading-6 text-white/65">
                    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-emerald-400/15 text-emerald-300">
                      <Icon d="m5 12 5 5L20 7" size={13} />
                    </span>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative grid place-items-center">
              <div className="nx-shield" aria-hidden="true">
                <Icon d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Zm-3-10 2 2 4-4" size={72} />
              </div>
            </div>
          </div>
        </section>

        <div className="nx-downloads">
          <AppDownloads />
        </div>

        {/* ---------- CTA ---------- */}
        <section className="px-4 py-24 sm:px-6">
          <div className="nx-cta reveal relative mx-auto max-w-5xl overflow-hidden rounded-[32px] p-10 text-center sm:p-16">
            <h2 className="relative text-3xl font-semibold tracking-[-0.03em] text-white sm:text-5xl">Prêt à mettre vos agents au travail ?</h2>
            <p className="relative mx-auto mt-4 max-w-xl text-sm leading-7 text-white/70 sm:text-base">
              Créez votre compte en une minute, recevez votre solde de démonstration et lancez votre premier agent dès aujourd&apos;hui.
            </p>
            <div className="relative mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link href="/signup" className="nx-btn-light">
                Commencer gratuitement <Icon d={ARROW} size={16} />
              </Link>
              <Link href="/login" className="nx-btn-outline">J&apos;ai déjà un compte</Link>
            </div>
          </div>
        </section>

        {/* ---------- FAQ ---------- */}
        <section id="faq" aria-label="Questions fréquentes" className="mx-auto max-w-3xl scroll-mt-24 px-4 pb-24 sm:px-6">
          <div className="text-center">
            <p className="nx-eyebrow">FAQ</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-[-0.03em] text-white sm:text-4xl">Questions fréquentes sur Gen3ia</h2>
          </div>
          <div className="mt-10 space-y-3">
            {FAQ_ITEMS.map((item) => (
              <details key={item.question} className="nx-faq group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-base font-medium text-white marker:hidden">
                  {item.question}
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/10 text-white/60 transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-7 text-white/55">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
      </div>

      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }} />

      <footer className="mt-auto border-t border-white/[0.06]">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Link href="/" className="flex items-center gap-2.5">
                <span className="nx-logo">G3</span>
                <span className="text-sm font-semibold text-white">Gen3ia</span>
              </Link>
              <p className="mt-4 max-w-xs text-sm leading-6 text-white/45">
                La plateforme d&apos;agents IA autonomes : Studio, Agent Live et Marketplace, avec le contrôle humain au centre.
              </p>
            </div>
            {[
              { title: "Capacités", links: [...PRODUCT_LINKS, { href: "/studio/interface-lab", label: "Atelier d'Interfaces" }, { href: "/studio/schedules", label: "Planification" }] },
              { title: "Votre espace", links: [{ href: "/dashboard", label: "Tableau de bord" }, { href: "/team", label: "Équipes" }, { href: "/billing", label: "Facturation" }, { href: "/storage", label: "Stockage permanent" }, { href: "/developer", label: "Espace développeur" }] },
              { title: "Compte", links: [{ href: "/signup", label: "Créer un compte" }, { href: "/login", label: "Se connecter" }, { href: "/privacy", label: "Confidentialité" }] },
            ].map((col) => (
              <nav key={col.title} aria-label={col.title}>
                <p className="text-xs font-semibold uppercase tracking-[.2em] text-white/35">{col.title}</p>
                <ul className="mt-4 space-y-2.5 text-sm">
                  {col.links.map((link) => (
                    <li key={link.href}><Link href={link.href} className="text-white/55 transition hover:text-white">{link.label}</Link></li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
          <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-white/[0.06] pt-6 text-xs text-white/40 sm:flex-row">
            <p>© {new Date().getFullYear()} Gen3ia AI Studio. Tous droits réservés.</p>
            <p>Créer · Exécuter · Grandir</p>
          </div>
        </div>
      </footer>

      <GenChatWidget />
    </div>
  );
}
