"use client";

import Link from "next/link";

import { LoadingState } from "@/components/shells/states";
import { useDeveloper } from "@/components/developer/developer-context";
import { Card, Panel, Rule } from "@/components/developer/tabs/panel";

/** Onglet Vue d'ensemble — métriques + raccourcis + sécurité des clés. */
const QUICK_LINKS: Array<[string, string, string]> = [
  ["Projets", "Créer une application isolée", "/developer/projects"],
  ["API & SDK", "Générer une clé liée à un projet", "/developer/api"],
  ["Build", "Créer un tool déclaratif", "/developer/build"],
  ["Monitoring", "Voir l'activité développeur", "/developer/monitoring"],
];

export function OverviewPanel() {
  const { projects, keys, extensions, revenue, resourceSummary, loaded } = useDeveloper();

  if (!loaded) return <LoadingState rows={3} />;

  return (
    <section className="space-y-5">
      <div className="grid gap-4 md:grid-cols-4">
        <Card title="Projets" value={projects.length} />
        <Card title="Clés actives" value={resourceSummary?.activeApiKeys ?? keys.filter((key) => key.status === "active").length} />
        <Card title="Extensions" value={resourceSummary?.extensions ?? extensions.length} />
        <Card title="Revenus nets" value={revenue ? `${(revenue.totalNetMinor / 100).toLocaleString("fr-FR")} ${revenue.currency}` : "—"} />
      </div>
      <div className="grid gap-5 lg:grid-cols-[1.4fr_.8fr]">
        <Panel title="Construire rapidement" subtitle="Les ressources sont persistées côté serveur.">
          <div className="grid gap-3 sm:grid-cols-2">
            {QUICK_LINKS.map(([label, description, href]) => (
              <Link key={href} href={href} className="rounded-2xl border p-4 text-left transition hover:border-neutral-400">
                <div className="font-semibold">{label}</div>
                <div className="mt-1 text-xs text-neutral-500">{description}</div>
              </Link>
            ))}
          </div>
        </Panel>
        <Panel title="Sécurité des clés" subtitle="Contrôle côté serveur">
          <div className="space-y-3">
            <Rule n="1" t="Chaque clé possède un projectId." />
            <Rule n="2" t="Chaque requête par clé doit envoyer X-Gen3ia-Project-Id." />
            <Rule n="3" t="Un projectId différent est refusé." />
            <Rule n="4" t="Une clé sans projet est refusée." />
          </div>
        </Panel>
      </div>
    </section>
  );
}
