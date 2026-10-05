import type { Metadata } from "next";
import type { ReactNode } from "react";

import StudioLayoutClient from "./studio-layout-client";

/**
 * Layout SERVEUR du segment /studio : porte la metadata SEO (audit UX 2-c —
 * P1 ; la page est "use client" et ne peut pas l'exporter elle-même). Le
 * rendu (shell client, mode immersif chat) vit dans StudioLayoutClient.
 *
 * Le layout racine porte déjà les balises html et body : un layout imbriqué
 * ne les redéclare JAMAIS (App Router). `title.absolute` bypass le template
 * racine « %s | Gen3ia » pour produire exactement « Studio — Gen3ia ».
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://gen3ia.online";

export const metadata: Metadata = {
  title: { absolute: "Studio — Gen3ia" },
  description:
    "Le Studio Gen3ia : créez des agents IA métier en quelques minutes — missions, résultats, connexions, équipe et outils spécialisés (appels, documents, finance, RH, marketing).",
  alternates: { canonical: "/studio" },
  openGraph: {
    type: "website",
    url: `${SITE_URL}/studio`,
    siteName: "Gen3ia",
    title: "Studio — Gen3ia",
    description:
      "Créez des agents IA métier en quelques minutes : missions, résultats, connexions et outils spécialisés Gen3ia.",
    locale: "fr_FR",
    images: [{ url: "/og-image.png", width: 1312, height: 736, alt: "Studio Gen3ia" }],
  },
};

export default function StudioLayout({ children }: { children: ReactNode }) {
  return <StudioLayoutClient>{children}</StudioLayoutClient>;
}
