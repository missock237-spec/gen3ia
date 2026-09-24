import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";

import { AppShell } from "@/components/nav/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { PwaRegister } from "@/components/pwa-register";
import { ScrollReveal } from "@/components/nav/scroll-reveal";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-source-serif",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#080A0F" },
    { media: "(prefers-color-scheme: light)", color: "#F6F4EF" },
  ],
};

/**
 * Bootstrap anti-FOUC du thème : appliqué AVANT la première peinture.
 * Défaut : sombre (identité plateforme) ; la vitrine (accueil/auth/privacy)
 * reste claire tant que l'utilisateur n'a pas choisi explicitement.
 */
const THEME_BOOTSTRAP = `(function(){try{var s=localStorage.getItem("gen3ia-theme");var p=location.pathname;var v=p==="/"||p.indexOf("/login")===0||p.indexOf("/signup")===0||p.indexOf("/privacy")===0;var t=s||(v?"light":"dark");document.documentElement.setAttribute("data-theme",t);}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

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
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
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
      className={`${inter.variable} ${sourceSerif.variable}`}
      data-theme="dark"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="antialiased font-sans">
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
        <ScrollReveal />
        <PwaRegister />
      </body>
    </html>
  );
}
