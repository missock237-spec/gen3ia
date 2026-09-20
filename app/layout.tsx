import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";

import { AppShell } from "@/components/nav/app-shell";
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
  themeColor: "#f6f4ef",
};

export const metadata: Metadata = {
  title: {
    default: "Gen3ia AI Studio",
    template: "%s | Gen3ia AI Studio",
  },
  description:
    "Un seul agent IA pour créer, exécuter et faire grandir vos projets : agents autonomes, skills dynamiques, recherche en temps réel et marketplace.",
  applicationName: "Gen3ia AI Studio",
  manifest: "/manifest.webmanifest",
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
    <html lang="fr" className={`${inter.variable} ${sourceSerif.variable}`}>
      <body className="antialiased font-sans">
        <AppShell>{children}</AppShell>
        <ScrollReveal />
        <PwaRegister />
      </body>
    </html>
  );
}
