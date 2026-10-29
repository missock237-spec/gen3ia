#!/usr/bin/env node
/**
 * Génère les 9 fichiers app/<segment>/error.tsx (containment segmentaire).
 * Usage: node scripts/gen_segment_errors.mjs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "app");

const SEGMENTS = [
  {
    dir: "dashboard",
    titre: "Le tableau de bord n'a pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant l'affichage de la conversation. Vos conversations, vos agents et vos données restent intacts — vous pouvez réessayer tout de suite.",
    retour: { href: "/", label: "Accueil" },
  },
  {
    dir: "admin",
    titre: "La console d'administration n'a pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant le chargement des indicateurs plateforme. Aucune donnée n'est affectée — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
  {
    dir: "settings",
    titre: "Les paramètres n'ont pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant l'affichage des réglages. Vos préférences enregistrées restent intactes — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
  {
    dir: "team",
    titre: "L'espace équipe n'a pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant l'affichage de l'équipe. Vos espaces partagés et vos missions restent intacts — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
  {
    dir: "developer",
    titre: "L'espace développeur n'a pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant l'affichage des outils de développement. Vos intégrations restent intactes — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
  {
    dir: "live",
    titre: "La session live n'a pas pu démarrer complètement",
    message:
      "Une erreur technique est survenue pendant l'initialisation de la session vocale. Aucune conversation n'est perdue — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
  {
    dir: "billing",
    titre: "La facturation n'a pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant l'affichage de la facturation. Vos abonnements et vos paiements restent intacts — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
  {
    dir: "memory",
    titre: "Les mémoires n'ont pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant l'affichage des souvenirs permanents. Vos mémoires restent intactes — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
  {
    dir: "neural",
    titre: "L'espace neural n'a pas pu s'afficher complètement",
    message:
      "Une erreur technique est survenue pendant l'affichage de l'espace neural. Vos modèles et vos données restent intacts — réessayez ou revenez au tableau de bord.",
    retour: { href: "/dashboard", label: "Tableau de bord" },
  },
];

const TEMPLATE = (s) => `"use client";

import SegmentError from "@/components/error/segment-error";

/**
 * Boundary d'erreur du segment /${s.dir} : contient tout crash de rendu de ce
 * segment (et de ses sous-routes) au lieu de le laisser remonter à
 * app/error.tsx qui remplacerait la page entière. Voir
 * components/error/segment-error.tsx pour le rendu partagé et la capture
 * Sentry (tag segment="${s.dir}").
 */
export default function ${s.dir[0].toUpperCase()}${s.dir.slice(1)}Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <SegmentError
      error={error}
      reset={reset}
      segment="${s.dir}"
      titre="${s.titre.replace(/'/g, "&apos;")}"
      message="${s.message.replace(/'/g, "&apos;")}"
      retourHref="${s.retour.href}"
      retourLabel="${s.retour.label}"
    />
  );
}
`;

let n = 0;
for (const s of SEGMENTS) {
  const file = join(ROOT, s.dir, "error.tsx");
  writeFileSync(file, TEMPLATE(s), "utf8");
  n++;
  console.log("écrit:", file);
}
console.log(`${n} boundaries segmentaires générées.`);
