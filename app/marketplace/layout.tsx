import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Metadata SEO du segment /marketplace (audit UX 2-c — P1) : les pages du
 * segment sont "use client" et ne peuvent pas exporter de metadata ; ce
 * layout SERVEUR les porte. Le layout racine porte déjà les balises
 * html et body : un layout imbriqué ne les redéclare JAMAIS (App Router).
 *
 * `title.absolute` bypass le template racine « %s | Gen3ia » pour produire
 * exactement « Marketplace — Gen3ia ».
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://gen3ia.online";

export const metadata: Metadata = {
  title: { absolute: "Marketplace — Gen3ia" },
  description:
    "Marketplace Gen3ia : extensions professionnelles pour enrichir vos agents IA — tools, skills, workflows et intégrations prêtes à l'emploi, validées côté serveur.",
  alternates: { canonical: "/marketplace" },
  openGraph: {
    type: "website",
    url: `${SITE_URL}/marketplace`,
    siteName: "Gen3ia",
    title: "Marketplace — Gen3ia",
    description:
      "Extensions professionnelles pour enrichir vos agents IA : tools, skills, workflows et intégrations prêtes à l'emploi.",
    locale: "fr_FR",
    images: [{ url: "/og-image.png", width: 1312, height: 736, alt: "Marketplace Gen3ia" }],
  },
};

export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return children;
}
