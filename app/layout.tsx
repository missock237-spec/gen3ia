import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";

import { AppShell } from "@/components/nav/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { PwaRegister } from "@/components/pwa-register";
import { DeployWatcher } from "@/components/deploy-watcher";
import { UpdateBanner } from "@/components/nav/update-banner";
import { ScrollReveal } from "@/components/nav/scroll-reveal";
import { ViewportHeightSync } from "@/components/nav/viewport-height-sync";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  // Inter reste PRÉCHARGÉE : police du corps de texte présente sur 100 %
  // des pages, le preload élimine le flash de substitution.
});

/** V2 « Aurora OS » : display techy-premium pour titres et marque.
 * preload:false (Task 96-d, budget bundle /layout à 100 %) : cette police
 * décorative n'est utilisée que par les titres — pas besoin de la
 * précharger sur TOUTES les routes (~30-90 Ko de requête de police en moins
 * au premier chargement). display:swap évite tout blocage de texte. */
const display = Space_Grotesk({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  preload: false,
});

/** V2 : mono dédiée pour le code, la console et les métadonnées techniques.
 * preload:false (Task 96-d) : idem Space_Grotesk — réservée aux surfaces
 * techniques (console, IDE), pas représentative du trafic général. */
const jet = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jet",
  preload: false,
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  // Sur Android, le clavier virtuel réduit le viewport de MISE EN PAGE (et
  // non seulement le viewport visuel) : les surfaces de chat plein écran
  // rétrécissent avec lui et le composer reste visible au-dessus du clavier.
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#05060C" },
    { media: "(prefers-color-scheme: light)", color: "#F1F2F8" },
  ],
};

/**
 * Bootstrap anti-FOUC du thème : appliqué AVANT la première peinture.
 * V2 « Aurora OS » : le thème sombre est l'identité de TOUTE l'interface
 * (vitrine incluse) — le thème clair « porcelaine » reste disponible via
 * le sélecteur, choisi explicitement par l'utilisateur.
 * Le meta theme-color (barre navigateur mobile) SUIT le choix utilisateur :
 * en son absence il reflète le thème réellement appliqué, pas le système.
 */
const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem("gen3ia-theme");var t=s||"dark";document.documentElement.setAttribute("data-theme",t);var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute("content",t==="light"?"#F1F2F8":"#05060C");}}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://gen3ia.online";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Gen3ia — Plateforme d'agents IA autonomes",
    template: "%s | Gen3ia",
  },
  description:
    "Gen3ia : décrivez un objectif, un agent IA personnalisé le planifie et l'exécute — recherche web, génération d'images, documents, 800+ applications connectées. Validation humaine des actions sensibles, facturation à l'usage.",
  keywords: [
    "agents IA autonomes",
    "agent IA",
    "plateforme d'agents IA",
    "génération d'images IA",
    "automatisation d'entreprise IA",
    "chatbot d'entreprise",
    "intégrations IA",
    "marketplace d'extensions IA",
    "agent IA francophone",
    "Gen3ia",
  ],
  applicationName: "Gen3ia",
  manifest: "/manifest.webmanifest",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Gen3ia",
    title: "Gen3ia — Plateforme d'agents IA autonomes",
    description:
      "Décrivez un objectif en une phrase : un agent IA Gen3ia le planifie, l'exécute et livre un résultat vérifié. Images par IA, 800+ connecteurs, marketplace d'extensions.",
    locale: "fr_FR",
    images: [
      {
        url: "/og-image.png",
        width: 1312,
        height: 736,
        alt: "Gen3ia — agents IA autonomes : décrivez, l'agent exécute",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Gen3ia — Plateforme d'agents IA autonomes",
    description:
      "Décrivez un objectif : un agent IA le planifie, l'exécute et livre un résultat vérifié. Images par IA, 800+ connecteurs.",
    images: ["/og-image.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Gen3ia",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png?v=g3-logo-1", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png?v=g3-logo-1", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-192.png?v=g3-logo-1", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png?v=g3-logo-1", sizes: "180x180" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      className={`${inter.variable} ${display.variable} ${jet.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
        {/* Performance : pré-établissement des connexions TLS vers les
            endpoints Firebase Auth consultés par CHAQUE page au démarrage
            (onAuthStateChanged → identitytoolkit / securetoken ; popup OAuth
            → apis.google.com). crossOrigin=anonymous : les SDK passent par
            fetch (mode CORS) — sans cet attribut la connexion préétablie
            ne serait pas réutilisée. */}
        <link rel="preconnect" href="https://apis.google.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://identitytoolkit.googleapis.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://securetoken.googleapis.com" crossOrigin="anonymous" />
        {/* Monétisation (Task 40) : DNS+TLS AdSense préétablis — le loader
            ne se charge que sur les pages vitrine (AdSenseAd), la connexion
            ne coûte rien aux surfaces applicatives et élimine ~100 ms de
            handshake sur le premier rendu publicitaire. dns-prefetch en
            repli pour les navigateurs sans support preconnect. */}
        <link rel="preconnect" href="https://pagead2.googlesyndication.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://pagead2.googlesyndication.com" />
        {/* Connexion Google AdSense (Task 41) — snippet officiel de
            vérification de site + Auto Ads, servi SSR dans le head de
            CHAQUE page : c'est ce marqueur que le robot AdSense vient
            lire pour valider gen3ia.online (avec /ads.txt). Conditionné
            à NEXT_PUBLIC_ADSENSE_CLIENT (public par conception) : sans
            variable, rien n'est rendu — aucune régression locale. Le
            composant AdSenseAd n'embarque PAS son propre loader (dédup). */}
        {process.env.NEXT_PUBLIC_ADSENSE_CLIENT?.trim() ? (
          <script
            async
            src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${process.env.NEXT_PUBLIC_ADSENSE_CLIENT.trim()}`}
            crossOrigin="anonymous"
          />
        ) : null}
      </head>
      <body className="antialiased font-sans">
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
        <ScrollReveal />
        <PwaRegister />
        {/* Task 51 : le nouveau build Vercel atteint les onglets ouverts
            SANS navigation — DeployWatcher sonde /api/deploy-info (empreinte
            du déploiement actif, jamais cachée) et détecte tout écart avec
            le relevé du chargement ; UpdateBanner applique AUTOMATIQUEMENT
            la nouvelle version au terme d'un compte à rebours annulable,
            sans jamais couper une saisie en cours. */}
        <DeployWatcher />
        <UpdateBanner />
        <ViewportHeightSync />
      </body>
    </html>
  );
}
