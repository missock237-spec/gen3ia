import type { Metadata } from "next";

import NovaChat from "@/components/chat/nova-chat";

export const metadata: Metadata = {
  title: { absolute: "Gen3ia — Votre IA souveraine" },
  description:
    "Conversez avec Gen3ia : agents spécialisés, automatisations en langage naturel, recherche web, images, documents et mémoire permanente — toute la plateforme depuis une seule conversation.",
};

/**
 * ACCUEIL = LE CHAT (demande propriétaire 2026-11-05 — repositionnement
 * « plateforme IA » à la Gemini).
 *
 * Avant : la racine était une vitrine SaaS (hero marketing, grilles de
 * fonctionnalités, pricing, FAQ) — le produit SE PRÉSENTAIT comme un SaaS
 * alors qu'il est une IA conversationnelle. Désormais, comme
 * gemini.google.com / chatgpt.com, la racine ouvre DIRECTEMENT la
 * conversation : salutation centrée, champ de saisie principal, cartes de
 * capacités, historique « Récents » groupé par date dans la barre latérale.
 *
 * - La vitrine marketing historique reste disponible sur /vitrine
 *   (page publique — SEO/GEO préservé : FAQ, JSON-LD, sitemap).
 * - /chat et /dashboard rendent le même NovaChat (surface canonique,
 *   voir app/chat/page.tsx) — AppShell les traite comme surfaces
 *   autonomes (isStandaloneChat) et immersives (isImmersiveChatRoute).
 * - Les fonctionnalités de la plateforme sont repositionnées comme des
 *   CAPACITÉS DU CHAT : section « Capacités » de la barre latérale
 *   (components/chat/nova-chat.tsx) + cartes d'accueil + outils du
 *   composer — et non plus des pages SaaS isolées.
 */
export default function AccueilPlateformeIA() {
  return <NovaChat />;
}
