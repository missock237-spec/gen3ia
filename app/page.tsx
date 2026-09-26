import Link from "next/link";

import { AppDownloads } from "@/components/home/app-downloads";
import { VitrineHeader } from "@/components/home/vitrine-header";
import { Gen3iaLogo } from "@/components/brand/gen3ia-logo";

/**
 * Vitrine Gen3ia — VERSION 2 « Aurora OS ».
 *
 * Identité nouvelle née de zéro : espace profond, halos aurora animés,
 * verre dépoli, frontière lumineuse dégradée (violet → fuchsia → cyan),
 * typographie display Space Grotesk. Le contenu référencable (FAQ,
 * données structurées schema.org, liens) est préservé intégralement :
 * la V2 change la peau, pas le fond GEO/SEO.
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
  { href: "/workspace/conversations", label: "Planification", icon: "M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" },
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
    text: "Scripts, visages de marque, carrousels et publications planifiées : décrivez une idée en langage naturel, l'agent produit, planifie et publie, vous validez.",
    href: "/workspace/conversations",
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
    title: "Studio d'agents IA",
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
    title: "Marketplace d'extensions",
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
      <div className="rounded-2xl border border-[rgba(148,153,255,0.14)] bg-[var(--g3-deep)]/80 p-4" aria-hidden="true">
        <p className="rounded-xl bg-[var(--g3-gradient)] bg-[length:160%_100%] px-4 py-2.5 text-xs font-medium text-white shadow-[0_8px_24px_-10px_rgba(124,92,255,0.7)]">
          « Lance une veille concurrentielle chaque matin et prépare-moi un résumé. »
        </p>
        <p className="mt-2.5 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)]/70 px-3.5 py-2 text-xs text-[var(--g3-muted)]">
          Très bien — je planifie la recherche, les sources et le rapport.
        </p>
      </div>
    ),
  },
  {
    title: "Son agent travaille, valide et exécute.",
    body: (
      <div className="rounded-2xl border border-[rgba(148,153,255,0.14)] bg-[var(--g3-deep)]/80 p-4" aria-hidden="true">
        <div className="flex items-center justify-between border-b border-[var(--g3-border)] pb-2.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Exécution</span>
          <span className="rounded-full bg-[var(--g3-success-soft)] px-2 py-0.5 text-[10px] font-bold text-[var(--g3-success-strong)]">Validée</span>
        </div>
        <div className="mt-3 space-y-2">
          <div className="h-2 w-3/4 rounded-full bg-[var(--g3-elevated)]" />
          <div className="h-2 w-1/2 rounded-full bg-[var(--g3-elevated)]" />
          <div className="h-2 w-2/3 rounded-full bg-[var(--g3-gradient)] bg-[length:200%_100%]" />
        </div>
      </div>
    ),
  },
  {
    title: "Le rapport l'attend, chaque matin.",
    body: (
      <div className="rounded-2xl border border-[rgba(148,153,255,0.14)] bg-[var(--g3-deep)]/80 p-4" aria-hidden="true">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--g3-faint)]">Résumés</p>
        <p className="gradient-text mt-1.5 font-[family-name:var(--font-display)] text-3xl font-semibold">+38 %</p>
        <p className="mt-1.5 text-xs text-[var(--g3-muted)]">Temps gagné sur la veille le premier mois.</p>
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

/* __V2_JSX__ */
export default function HomePage() {
  // Vitrine publique servie à la racine : indispensable au référencement
  // (Google/Bing) ET à la recommandation par les LLM (ChatGPT, Perplexity,
  // Claude…) qui doivent lire FAQ + données structurées. Les utilisateurs
  // connectés continuent via le lien « Tableau de bord » (header).
  return (
    <div className="g3-noise flex min-h-full flex-col bg-[var(--g3-bg)] text-[var(--g3-text)]">
      {/* ---------- Navigation (verre Aurora, sticky) ---------- */}
      <VitrineHeader />

      <div className="flex-1">
        {/* ---------- Héros Aurora : espace profond + prompt verre ---------- */}
        <section className="sky-hero relative overflow-hidden">
          <div className="aurora" aria-hidden="true" />
          <div className="aurora-glow" aria-hidden="true" />
          <div className="grid-bg absolute inset-0" aria-hidden="true" />
          <div className="relative mx-auto max-w-6xl px-4 pb-24 pt-20 sm:px-6 sm:pt-28">
            <div className="mx-auto max-w-3xl text-center">
              {/* Badge V2 */}
              <p className="anim-fade-up mx-auto inline-flex items-center gap-2 rounded-full border border-[rgba(124,92,255,0.4)] bg-[var(--g3-primary-soft)] px-4 py-1.5 text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--g3-primary-strong)] shadow-[0_0_24px_-6px_rgba(124,92,255,0.6)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--g3-gradient)]" aria-hidden />
                Interface V2 · Aurora
              </p>

              <h1 className="anim-fade-up anim-delay-1 mt-7 font-[family-name:var(--font-display)] text-5xl font-bold leading-[1.02] tracking-tight sm:text-7xl">
                Décrivez-le.
                <br />
                <span className="gradient-text">L&apos;agent l&apos;exécute.</span>
              </h1>
              <p className="anim-fade-up anim-delay-2 mx-auto mt-6 max-w-xl text-base leading-8 text-[var(--g3-text-secondary)] sm:text-lg">
                Un seul agent IA pour transformer une idée en projet qui tourne :
                il crée, exécute le travail et continue de grandir pour vous.
              </p>

              {/* Boîte de prompt — verre, frontière lumineuse */}
              <form action="/signup" className="anim-fade-up anim-delay-3 mx-auto mt-12 max-w-2xl text-left">
                <div className="g3-gradient-border p-4 shadow-[0_30px_90px_-30px_rgba(124,92,255,0.5)]">
                  <label htmlFor="hero-intent" className="sr-only">Décrivez votre idée</label>
                  <textarea
                    id="hero-intent"
                    name="intent"
                    rows={3}
                    placeholder="Décrivez ce que votre agent doit faire pour vous…"
                    className="w-full resize-none bg-transparent px-2 py-1.5 text-sm text-[var(--g3-text)] outline-none placeholder:text-[var(--g3-faint)] sm:text-base"
                  />
                  <div className="flex items-center justify-between px-2 pb-1">
                    <span className="text-xs text-[var(--g3-faint)]">Gen3ia s&apos;occupe du reste</span>
                    <button
                      type="submit"
                      aria-label="Commencer avec cette idée"
                      className="grid h-11 w-11 place-items-center rounded-full bg-[var(--g3-gradient)] bg-[length:160%_100%] text-white shadow-[0_10px_30px_-8px_rgba(124,92,255,0.8)] transition hover:scale-105 hover:brightness-110"
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 12h14M13 6l6 6-6 6" />
                      </svg>
                    </button>
                  </div>
                </div>
              </form>

              {/* Grille de capacités */}
              <ul className="anim-fade-up anim-delay-4 mx-auto mt-8 grid max-w-2xl grid-cols-2 gap-2.5 sm:grid-cols-3">
                {CAPABILITIES.map((capability) => (
                  <li key={capability.label}>
                    <Link
                      href={capability.href}
                      className="flex items-center justify-center gap-2 rounded-2xl border border-[rgba(148,153,255,0.16)] bg-white/[0.04] px-3 py-3 text-sm font-medium text-[var(--g3-text-secondary)] backdrop-blur transition hover:-translate-y-0.5 hover:border-[rgba(124,92,255,0.5)] hover:bg-white/[0.07] hover:text-white hover:shadow-[0_12px_34px_-16px_rgba(124,92,255,0.6)]"
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-[var(--g3-secondary)]">
                        <path d={capability.icon} />
                      </svg>
                      {capability.label}
                    </Link>
                  </li>
                ))}
              </ul>

              <p className="anim-fade-up anim-delay-5 mt-6 text-xs text-[var(--g3-faint)]">
                Web (Android &amp; iOS — installable depuis le navigateur) · Desktop Windows &amp; Linux
              </p>
            </div>
          </div>
        </section>

        {/* ---------- Storytelling (verre + halo) ---------- */}
        <section aria-label="Histoire d'utilisation" className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20">
          <div className="grid gap-5 md:grid-cols-3">
            {STORY_CARDS.map((card, index) => (
              <article
                key={card.title}
                className="cream-card card-glow reveal rounded-3xl p-6"
                style={{ ["--reveal-delay" as string]: `${index * 0.12}s` }}
              >
                <h2 className="font-[family-name:var(--font-display)] text-xl font-semibold leading-snug text-[var(--g3-text)]">{card.title}</h2>
                <div className="mt-5">{card.body}</div>
              </article>
            ))}
          </div>
          <figure className="reveal relative mx-auto mt-10 max-w-3xl overflow-hidden rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-8 text-center backdrop-blur">
            <div className="rainbow-line absolute inset-x-0 top-0" aria-hidden="true" />
            <blockquote className="font-[family-name:var(--font-display)] text-xl font-medium leading-relaxed text-[var(--g3-text)] sm:text-2xl">
              « C’est le premier outil qui travaille vraiment pendant que je dors. »
            </blockquote>
            <figcaption className="mt-4 text-sm text-[var(--g3-muted)]">— Aïcha, fondatrice d’une boutique en ligne</figcaption>
          </figure>
        </section>

        {/* ---------- Statistiques ---------- */}
        <section aria-label="Chiffres clés" className="mx-auto max-w-6xl px-4 pb-4 sm:px-6">
          <dl className="reveal grid grid-cols-2 gap-3 sm:grid-cols-4">
            {STATS.map((stat) => (
              <div key={stat.label} className="rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/70 p-5 text-center backdrop-blur transition hover:border-[rgba(124,92,255,0.45)]">
                <dd className="order-1 gradient-text font-[family-name:var(--font-display)] text-2xl font-bold">{stat.value}</dd>
                <dt className="order-2 mt-1.5 text-[11px] leading-4 text-[var(--g3-faint)]">{stat.label}</dt>
              </div>
            ))}
          </dl>
        </section>

        {/* ---------- Solutions (publics cibles) ---------- */}
        <section aria-label="Pour qui" className="mx-auto max-w-6xl px-4 pb-16 pt-14 sm:px-6 sm:pb-20">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="g3-eyebrow">Pour qui</p>
            <h2 className="mt-4 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-5xl">
              Une idée, menée <span className="gradient-text">jusqu&apos;au bout</span>
            </h2>
            <p className="mt-4 text-sm leading-7 text-[var(--g3-muted)] sm:text-base">
              Choisissez un profil et regardez le travail avancer — le même
              agent s&apos;adapte à votre façon de travailler.
            </p>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {SOLUTIONS.map((solution, index) => (
              <article
                key={solution.title}
                className="cream-card card-glow reveal flex flex-col rounded-3xl p-7"
                style={{ ["--reveal-delay" as string]: `${index * 0.12}s` }}
              >
                <span className="grid h-11 w-11 place-items-center rounded-2xl border border-[rgba(124,92,255,0.35)] bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)] shadow-[0_0_20px_-6px_rgba(124,92,255,0.6)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={solution.icon} />
                  </svg>
                </span>
                <h3 className="mt-5 font-[family-name:var(--font-display)] text-xl font-semibold text-[var(--g3-text)]">{solution.title}</h3>
                <p className="mt-2.5 flex-1 text-sm leading-6 text-[var(--g3-muted)]">{solution.text}</p>
                <Link
                  href={solution.href}
                  className="group mt-6 inline-flex w-fit items-center gap-1.5 text-sm font-semibold text-[var(--g3-secondary)] transition hover:text-white"
                >
                  {solution.cta}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
              </article>
            ))}
          </div>
        </section>

        {/* ---------- Produits ---------- */}
        <section id="produits" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-16 sm:px-6 sm:py-20">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="g3-eyebrow">Trois espaces, une plateforme</p>
            <h2 className="mt-4 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-5xl">
              Tout ce qu’il faut pour mettre <span className="gradient-text">les agents au travail</span>
            </h2>
            <p className="mt-4 text-sm leading-7 text-[var(--g3-muted)] sm:text-base">
              Chaque espace est accessible en un clic depuis votre tableau de
              bord — et vos agents, extensions et sessions restent synchronisés
              à votre compte.
            </p>
          </div>

          <div className="mt-12 grid gap-5 lg:grid-cols-3">
            {PRODUCTS.map((product, index) => (
              <article
                key={product.href}
                className="card-glow reveal flex flex-col rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-7 backdrop-blur"
                style={{ ["--reveal-delay" as string]: `${index * 0.12}s` }}
              >
                <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--g3-gradient)] bg-[length:160%_100%] text-white shadow-[0_10px_28px_-10px_rgba(124,92,255,0.8)]">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d={product.icon} />
                  </svg>
                </div>
                <p className="mt-5 text-[11px] font-bold uppercase tracking-[.25em] text-[var(--g3-faint)]">
                  {product.eyebrow}
                  {product.badge && (
                    <span className="ml-2 rounded-md bg-[var(--g3-warning-soft)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--g3-warning-strong)]">{product.badge}</span>
                  )}
                </p>
                <h3 className="mt-2.5 font-[family-name:var(--font-display)] text-2xl font-semibold text-[var(--g3-text)]">{product.title}</h3>
                <p className="mt-3 flex-1 text-sm leading-6 text-[var(--g3-muted)]">{product.description}</p>
                <ul className="mt-5 space-y-2.5">
                  {product.points.map((point) => (
                    <li key={point} className="flex items-start gap-2.5 text-sm text-[var(--g3-text-secondary)]">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--g3-success)]">
                        <path d="m5 12 5 5L20 7" />
                      </svg>
                      {point}
                    </li>
                  ))}
                </ul>
                <Link
                  href={product.href}
                  className="group mt-7 inline-flex w-fit items-center gap-1.5 rounded-full border border-[rgba(148,153,255,0.25)] bg-white/[0.04] px-5 py-2.5 text-sm font-semibold text-[var(--g3-text)] transition hover:border-transparent hover:bg-[var(--g3-gradient)] hover:bg-[length:160%_100%] hover:text-white hover:shadow-[0_10px_30px_-10px_rgba(124,92,255,0.7)]"
                >
                  {product.cta}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
                    <path d="M5 12h14M13 6l6 6-6 6" />
                  </svg>
                </Link>
              </article>
            ))}
          </div>
        </section>

        {/* ---------- Bento capacités ---------- */}
        <section aria-label="Capacités détaillées" className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 sm:pb-20">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {/* Mémoire permanente — grande tuile vedette */}
            <article className="g3-gradient-border card-glow reveal relative flex flex-col overflow-hidden p-7 sm:col-span-2">
              <div className="flex items-start gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--g3-primary-soft)] text-[var(--g3-primary-strong)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
                  </svg>
                </span>
                <div>
                  <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold">Mémoire permanente</h3>
                  <p className="mt-1.5 max-w-sm text-sm leading-6 text-[var(--g3-muted)]">
                    Vos agents se souviennent du contexte utile de vos projets, avec protection des secrets et contrôle propriétaire.
                  </p>
                </div>
              </div>
              <div className="mt-6 space-y-2" aria-hidden="true">
                <div className="anim-fade-in max-w-[85%] rounded-2xl rounded-bl-md border border-[var(--g3-border)] bg-[var(--g3-elevated)]/80 px-4 py-2.5 text-xs text-[var(--g3-text-secondary)]">Retiens la charte graphique du projet Nebula.</div>
                <div className="anim-fade-in ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-[var(--g3-gradient)] bg-[length:160%_100%] px-4 py-2.5 text-xs text-white shadow-[0_8px_24px_-10px_rgba(124,92,255,0.7)]" style={{ animationDelay: "0.3s", animationFillMode: "both" }}>Mémorisé — 3 souvenirs liés à ce projet.</div>
              </div>
            </article>

            {/* Sécurité */}
            <article className="card-glow reveal flex gap-4 rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-6 backdrop-blur">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--g3-success-soft)] text-[var(--g3-success-strong)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                </svg>
              </span>
              <div>
                <h3 className="text-sm font-bold">Sécurité par conception</h3>
                <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">Sandbox isolée, permissions granulaires, garde-fous anti-dépenses et validation humaine.</p>
              </div>
            </article>

            {/* Atelier 21st.dev — tuile vedette */}
            <article className="card-glow reveal relative flex flex-col overflow-hidden rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-6 backdrop-blur">
              <span className="absolute right-4 top-4 rounded-full bg-[var(--g3-primary-soft)] px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[var(--g3-primary-strong)]">Nouveau</span>
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--g3-secondary-soft)] text-[var(--g3-secondary)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />
                </svg>
              </span>
              <h3 className="mt-4 text-sm font-bold">Atelier d&apos;Interfaces 21st.dev</h3>
              <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">Composants et thèmes professionnels récupérés et adaptés par vos agents de code.</p>
              <pre className="g3-code mt-4 !max-h-24 !p-3 !text-[10px]" aria-hidden="true">{`<Hero variant="aurora" />\n<StatsGrid cols={4} />\n<BentoFeature />`}</pre>
            </article>

            {/* Facturation */}
            <article className="card-glow reveal flex gap-4 rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-6 backdrop-blur">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--g3-magenta-soft)] text-[var(--g3-magenta)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </span>
              <div>
                <h3 className="text-sm font-bold">Facturation à l&apos;usage</h3>
                <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">Wallet intégré, rechargement Mobile Money ou carte. Vous ne payez que ce que vos agents exécutent.</p>
              </div>
            </article>

            {/* Planification */}
            <article className="card-glow reveal flex gap-4 rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-6 backdrop-blur">
              <span className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--g3-warning-soft)] text-[var(--g3-warning-strong)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 8v4l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                </svg>
              </span>
              <div>
                <h3 className="text-sm font-bold">Planification automatique</h3>
                <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">Fenêtres horaires d&apos;activation : le serveur applique le planning même application fermée.</p>
              </div>
            </article>

            {/* Multi-appareils — grande tuile */}
            <article className="cream-card card-glow reveal relative flex flex-col overflow-hidden rounded-3xl p-7 sm:col-span-2">
              <div className="flex items-start gap-4">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--g3-secondary-soft)] text-[var(--g3-secondary)]">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2 3h20v14H2zM8 21h8M12 17v4" />
                  </svg>
                </span>
                <div>
                  <h3 className="font-[family-name:var(--font-display)] text-lg font-semibold">Multi-appareils</h3>
                  <p className="mt-1.5 max-w-sm text-sm leading-6 text-[var(--g3-muted)]">
                    Web app installable sur Android et iOS, application Desktop pour Windows et Linux. Vos données vous suivent partout.
                  </p>
                </div>
              </div>
              <div className="mt-5 flex flex-wrap gap-2" aria-hidden="true">
                {["Android", "iOS", "Windows", "Linux", "Web PWA"].map((device) => (
                  <span key={device} className="rounded-full border border-[rgba(148,153,255,0.18)] bg-white/[0.05] px-3.5 py-1.5 text-xs font-semibold text-[var(--g3-text-secondary)]">{device}</span>
                ))}
              </div>
            </article>

            {/* Espace développeur */}
            <article className="card-glow reveal flex gap-4 rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-6 backdrop-blur">
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-[var(--g3-border)] bg-[var(--g3-elevated)] text-[var(--g3-text-secondary)]">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />
                </svg>
              </span>
              <div>
                <h3 className="text-sm font-bold">Espace développeur</h3>
                <p className="mt-1.5 text-xs leading-5 text-[var(--g3-muted)]">Créez vos extensions avec le SDK Gen3ia, publiez-les et suivez vos revenus.</p>
              </div>
            </article>
          </div>
        </section>

        {/* ---------- Fonctionnement ---------- */}
        <section id="fonctionnement" className="scroll-mt-24 border-y border-[var(--g3-border)] bg-[var(--g3-deep)]/60 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="reveal mx-auto max-w-2xl text-center">
              <p className="g3-eyebrow">Fonctionnement</p>
              <h2 className="mt-4 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-5xl">Opérationnel en trois étapes</h2>
              <p className="mt-4 text-sm leading-7 text-[var(--g3-muted)] sm:text-base">
                Pas de configuration complexe : un compte, un objectif, une
                validation — puis vos agents travaillent pour vous.
              </p>
            </div>
            <ol className="mt-12 grid gap-5 md:grid-cols-3">
              {STEPS.map((step, index) => (
                <li
                  key={step.number}
                  className="card-glow reveal relative rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/70 p-7 backdrop-blur"
                  style={{ ["--reveal-delay" as string]: `${index * 0.12}s` }}
                >
                  <span className="gradient-text font-[family-name:var(--font-display)] text-4xl font-bold">{step.number}</span>
                  <h3 className="mt-4 font-[family-name:var(--font-display)] text-xl font-semibold">{step.title}</h3>
                  <p className="mt-2.5 text-sm leading-6 text-[var(--g3-muted)]">{step.text}</p>
                  {index < STEPS.length - 1 && (
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="absolute -right-3.5 top-1/2 hidden -translate-y-1/2 text-[var(--g3-primary)] md:block">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  )}
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ---------- Sécurité ---------- */}
        <section id="securite" className="mx-auto max-w-6xl scroll-mt-24 px-4 py-16 sm:px-6 sm:py-20">
          <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
            <div className="reveal">
              <p className="g3-eyebrow">Sécurité &amp; contrôle</p>
              <h2 className="mt-4 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-5xl">
                Des agents puissants, <span className="gradient-text">jamais incontrôlés</span>
              </h2>
              <p className="mt-4 text-sm leading-7 text-[var(--g3-muted)] sm:text-base">
                Chaque capacité dangereuse est encadrée : permissions
                explicites, sandbox isolée, double validation humaine et
                journalisation. Vous gardez le contrôle permanent sur ce que
                vos agents peuvent faire — et de ce qu’ils peuvent dépenser.
              </p>
              <ul className="mt-8 space-y-3.5">
                {SECURITY_POINTS.map((point) => (
                  <li key={point} className="flex items-start gap-3 text-sm leading-6 text-[var(--g3-text-secondary)]">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--g3-success-soft)]">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-[var(--g3-success-strong)]">
                        <path d="m5 12 5 5L20 7" />
                      </svg>
                    </span>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
            <div className="reveal card-glow rounded-3xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-7 backdrop-blur" style={{ ["--reveal-delay" as string]: "0.15s" }}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold">Journal d’activité (extrait)</p>
                <span className="rounded-full bg-[var(--g3-success-soft)] px-3 py-1 text-[10px] font-bold uppercase text-[var(--g3-success-strong)]">Contrôle actif</span>
              </div>
              <div className="mt-5 space-y-3 font-[family-name:var(--font-mono)] text-xs">
                {[
                  { tone: "text-[var(--g3-secondary)]", label: "agent.recherche", text: "Analyse concurrents — 12 sources" },
                  { tone: "text-[var(--g3-warning-strong)]", label: "permission.demandee", text: "Écriture fichier /rapports/q3.xlsx" },
                  { tone: "text-[var(--g3-success-strong)]", label: "humain.valide", text: "Publication campagne — approuvée" },
                  { tone: "text-[var(--g3-magenta)]", label: "wallet.execution", text: "Coût exécution : 12,50 XAF" },
                ].map((row, index) => (
                  <div
                    key={row.label}
                    className="anim-fade-in flex items-center gap-3 rounded-xl border border-[var(--g3-border)] bg-[var(--g3-deep)]/80 px-4 py-3"
                    style={{ animationDelay: `${0.4 + index * 0.25}s`, animationFillMode: "both" }}
                  >
                    <span className={`shrink-0 font-bold ${row.tone}`}>{row.label}</span>
                    <span className="truncate text-[var(--g3-muted)]">{row.text}</span>
                  </div>
                ))}
              </div>
              <p className="mt-5 text-xs leading-5 text-[var(--g3-faint)]">
                Toutes les opérations sensibles sont traçables, révocables et
                jamais silencieuses.
              </p>
            </div>
          </div>
        </section>

        {/* ---------- Téléchargez les apps ---------- */}
        <AppDownloads />

        {/* ---------- CTA final (frontière lumineuse + halo) ---------- */}
        <section className="px-4 pb-20 sm:px-6">
          <div className="g3-gradient-border reveal relative mx-auto max-w-5xl overflow-hidden p-10 text-center sm:p-14">
            <div className="aurora-glow" aria-hidden="true" />
            <h2 className="relative font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-5xl">
              Prêt à mettre <span className="gradient-text">vos agents au travail</span> ?
            </h2>
            <p className="relative mx-auto mt-4 max-w-xl text-sm leading-7 text-[var(--g3-muted)] sm:text-base">
              Créez votre compte en une minute, recevez votre solde de
              démonstration et ouvrez votre premier agent dès aujourd’hui.
            </p>
            <div className="relative mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-full bg-[var(--g3-gradient)] bg-[length:160%_100%] px-8 py-3.5 text-sm font-bold text-white shadow-[0_14px_40px_-12px_rgba(124,92,255,0.8)] transition hover:-translate-y-0.5 hover:brightness-110"
              >
                Commencer gratuitement
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M13 6l6 6-6 6" />
                </svg>
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center rounded-full border border-[rgba(148,153,255,0.3)] px-8 py-3.5 text-sm font-semibold text-[var(--g3-text-secondary)] transition hover:border-[rgba(124,92,255,0.6)] hover:bg-white/[0.05] hover:text-white"
              >
                J’ai déjà un compte
              </Link>
            </div>
            <div className="rainbow-line relative mx-auto mt-10 w-full max-w-md" aria-hidden="true" />
            <p className="relative mt-4 font-[family-name:var(--font-display)] text-lg text-[var(--g3-text-secondary)]">Créer — Exécuter — Grandir</p>
          </div>
        </section>

        {/* ---------- FAQ (contenu citable par les moteurs de réponse IA) ---------- */}
        <section id="faq" aria-label="Questions fréquentes" className="mx-auto max-w-4xl scroll-mt-24 px-4 pb-20 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <p className="g3-eyebrow">FAQ</p>
            <h2 className="mt-4 font-[family-name:var(--font-display)] text-3xl font-bold tracking-tight sm:text-4xl">
              Questions fréquentes sur Gen3ia
            </h2>
            <p className="mt-4 text-sm leading-7 text-[var(--g3-muted)]">
              Tout ce qu&apos;il faut savoir avant de confier vos premières
              tâches à un agent.
            </p>
          </div>
          <div className="mt-10 space-y-3">
            {FAQ_ITEMS.map((item) => (
              <details key={item.question} className="group rounded-2xl border border-[rgba(148,153,255,0.16)] bg-[var(--g3-surface)]/80 p-5 backdrop-blur transition hover:border-[rgba(124,92,255,0.45)]">
                <summary className="cursor-pointer list-none font-[family-name:var(--font-display)] text-lg font-semibold text-[var(--g3-text)] marker:hidden">
                  {item.question}
                </summary>
                <p className="mt-3 text-sm leading-7 text-[var(--g3-muted)]">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
      </div>

      {/* ---------- Données structurées (SEO + moteurs de réponse IA) ---------- */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />

      {/* ---------- Pied de page profond + ligne Aurora ---------- */}
      <footer className="mt-auto border-t border-[var(--g3-border)] bg-[var(--g3-deep)]">
        <div className="rainbow-line" aria-hidden="true" />
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Link href="/" className="flex items-center gap-2.5">
                <Gen3iaLogo size={36} alt="" />
                <span className="font-[family-name:var(--font-display)] text-sm font-bold">Gen3ia</span>
              </Link>
              <p className="mt-3 font-[family-name:var(--font-display)] text-xl font-medium text-[var(--g3-text)]">La meilleure façon de travailler avec l’IA</p>
              <p className="mt-4 max-w-xs text-xs leading-5 text-[var(--g3-faint)]">
                La plateforme d’agents IA autonomes : Studio, Agent Live et
                Marketplace, avec la sécurité et le contrôle humain au centre.
              </p>
            </div>
            <nav aria-label="Capacités">
              <p className="text-xs font-bold uppercase tracking-[.2em] text-[var(--g3-faint)]">Capacités</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                {PRODUCT_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">{link.label}</Link>
                  </li>
                ))}
                <li><Link href="/studio/interface-lab" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Atelier d&apos;Interfaces</Link></li>
                <li><Link href="/workspace/conversations" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Planification</Link></li>
              </ul>
            </nav>
            <nav aria-label="Espaces">
              <p className="text-xs font-bold uppercase tracking-[.2em] text-[var(--g3-faint)]">Votre espace</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li><Link href="/dashboard" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Tableau de bord</Link></li>
                <li><Link href="/team" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Équipes</Link></li>
                <li><Link href="/billing" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Facturation</Link></li>
                <li><Link href="/storage" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Stockage permanent</Link></li>
                <li><Link href="/developer" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Espace développeur</Link></li>
              </ul>
            </nav>
            <nav aria-label="Compte">
              <p className="text-xs font-bold uppercase tracking-[.2em] text-[var(--g3-faint)]">Compte</p>
              <ul className="mt-4 space-y-2.5 text-sm">
                <li><Link href="/signup" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Créer un compte</Link></li>
                <li><Link href="/login" className="text-[var(--g3-muted)] transition hover:text-[var(--g3-primary-strong)]">Se connecter</Link></li>
              </ul>
            </nav>
          </div>
          <div className="mt-12 flex flex-col items-center justify-between gap-3 border-t border-[var(--g3-border)] pt-6 text-sm text-[var(--g3-faint)] sm:flex-row">
            <p className="text-xs">© {new Date().getFullYear()} Gen3ia AI Studio. Tous droits réservés.</p>
            <p className="font-[family-name:var(--font-display)]">Créer <span className="mx-2 text-[var(--g3-border-strong)]">·</span> Exécuter <span className="mx-2 text-[var(--g3-border-strong)]">·</span> Grandir</p>
            <p className="text-xs">Conçu pour Android, iOS, Windows et Linux.</p>
          </div>
        </div>
      </footer>

    </div>
  );
}
