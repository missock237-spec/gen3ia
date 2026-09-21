"use client";

import Link from "next/link";
import { FeatureAuthGate } from "@/components/auth/feature-auth-gate";

/**
 * Page « Fonctionnalités cachées » : inventaire des capacités Gen3ia qui
 * existent déjà dans la plateforme mais n'ont pas d'entrée de menu visible.
 * Chaque fiche indique comment y accéder (lien direct, API, réservation).
 */

type AccessKind = "lien" | "api" | "reservé";

type HiddenFeature = {
  title: string;
  description: string;
  path: string;
  access: AccessKind;
  href?: string;
  note?: string;
};

const FEATURES: HiddenFeature[] = [
  {
    title: "Portail client",
    description: "Partagez un agent IA personnalisé avec vos clients : ils discutent avec lui depuis une page dédiée, sans compte Gen3ia. Idéal pour un support produit ou un assistant commercial.",
    path: "/client/{agentId}",
    access: "lien",
    note: "Copiez l'identifiant de votre agent depuis le Studio, puis transmettez le lien.",
  },
  {
    title: "Approbation à distance",
    description: "Quand une action sensible est mise en attente (envoi d'email, paiement, publication), vous pouvez la confirmer depuis votre téléphone via un lien sécurisé reçu par email ou SMS — sans ouvrir l'application.",
    path: "/approvals/{approvalId}",
    access: "lien",
    note: "Le lien est envoyé automatiquement avec la notification d'approbation.",
  },
  {
    title: "API publique des agents",
    description: "Intégrez n'importe quel agent Gen3ia dans votre propre application : une requête GET récupère la présentation de l'agent, une requête POST lui envoie un message et reçoit la réponse (classification chat/tâche incluse).",
    path: "/api/public/agents/{agentId}",
    access: "api",
    note: "Authentification par session ou token Firebase. Réponses JSON.",
  },
  {
    title: "Webhooks de déclenchement",
    description: "Déclenchez une mission agent depuis un système externe (formulaire, CRM, Zapier, automate) : chaque trigger possède un token dédié qui lance l'exécution planifiée de l'agent.",
    path: "/api/webhooks/agent-triggers/{token}",
    access: "api",
    note: "Le token est fourni à la création du trigger dans le Studio.",
  },
  {
    title: "Agents d'appel téléphonique",
    description: "L'infrastructure de téléphonie (Twilio / Plivo) est déjà branchée : numéros, appels et suivi de conversation vocale. Un agent créé en mode « Agent d'appel » peut passer sur ce canal.",
    path: "/api/voice",
    access: "api",
    note: "Configuration du numéro et des voix depuis le Studio (agent d'appel).",
  },
  {
    title: "Orchestrateur multi-agents",
    description: "Décomposez un objectif en sous-tâches exécutées par plusieurs agents spécialisés : plans d'action, actions partagées et exécutions coordonnées. L'orchestrateur est prêt et accessible par API.",
    path: "/api/orchestrator",
    access: "api",
    note: "Interface dédiée prévue ; l'API accepte objectif + contraintes.",
  },
  {
    title: "Serveurs MCP (Model Context Protocol)",
    description: "Branchez des serveurs MCP externes : leurs outils sont découverts automatiquement et deviennent utilisables par vos agents (mcp.call), sans code.",
    path: "/integrations/mcp",
    access: "lien",
    href: "/integrations",
    note: "Gestion depuis l'espace Intégrations.",
  },
  {
    title: "Atelier d'interfaces",
    description: "Les agents de type « code » peuvent générer et manipuler des interfaces (composants ui.components) dans un atelier isolé — la couche low-code de la plateforme.",
    path: "/studio/interface-lab",
    access: "reservé",
    href: "/studio/interface-lab",
    note: "Réservé aux agents de code : créez un agent type « code » dans le Studio.",
  },
  {
    title: "Administration des extensions",
    description: "Console d'administration du marketplace : validation des extensions, versions, entitlements et rapports. Réservée aux comptes administrateurs.",
    path: "/admin/extensions",
    access: "reservé",
    href: "/admin/extensions",
    note: "Visible uniquement avec un compte admin Gen3ia.",
  },
  {
    title: "Application installable (PWA & desktop)",
    description: "Gen3ia s'installe comme une application : PWA depuis le navigateur (icône, mode hors-ligne léger) et clients desktop Windows/Linux dans le dépôt (dossier desktop/).",
    path: "PWA · desktop/",
    access: "lien",
    note: "PWA : « Installer » depuis le menu de votre navigateur sur gen3ia.online.",
  },
];

const ACCESS_STYLE: Record<AccessKind, { label: string; className: string }> = {
  lien: { label: "Lien direct", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  api: { label: "API", className: "border-sky-200 bg-sky-50 text-sky-700" },
  "reservé": { label: "Réservé", className: "border-amber-200 bg-amber-50 text-amber-700" },
};

function FeaturesContent() {
  return (
    <div className="min-h-full bg-[#f6f4ef] text-neutral-900">
      <div className="mx-auto max-w-5xl px-4 py-10 md:px-8 md:py-14">
        <header className="anim-fade-up text-center">
          <p className="g3-eyebrow">Gen3ia · Capacités avancées</p>
          <h1 className="mt-3 font-serif text-4xl font-semibold tracking-tight md:text-5xl">
            Fonctionnalités cachées.
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-7 text-neutral-500 md:text-base">
            Ces capacités sont déjà présentes dans la plateforme mais n&apos;apparaissent pas dans le
            menu. Cette page les rend accessibles : ouvrez une fiche, suivez le chemin indiqué et
            utilisez la fonctionnalité immédiatement.
          </p>
        </header>

        <div className="mt-10 grid gap-4 md:grid-cols-2">
          {FEATURES.map((feature, index) => {
            const style = ACCESS_STYLE[feature.access];
            const body = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-serif text-lg font-semibold text-neutral-900">{feature.title}</h2>
                  <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${style.className}`}>
                    {style.label}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-6 text-neutral-500">{feature.description}</p>
                <p className="mt-3 truncate rounded-lg bg-neutral-50 px-2.5 py-1.5 font-mono text-[11px] text-neutral-600">{feature.path}</p>
                {feature.note && <p className="mt-2 text-[11px] leading-5 text-neutral-400">{feature.note}</p>}
                <p className="mt-3 text-[11px] font-semibold text-violet-700 group-hover:text-violet-900">
                  {feature.href ? "Ouvrir →" : feature.access === "api" ? "Appeler via votre code →" : "Utiliser le chemin indiqué →"}
                </p>
              </>
            );
            return feature.href ? (
              <Link
                key={feature.title}
                href={feature.href}
                className="group anim-fade-up rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.05)] transition hover:border-violet-200 hover:shadow-[0_14px_40px_-18px_rgba(28,27,24,0.22)]"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                {body}
              </Link>
            ) : (
              <div
                key={feature.title}
                className="group anim-fade-up rounded-3xl border border-[rgba(23,23,20,0.09)] bg-white p-5 shadow-[0_2px_10px_rgba(15,23,42,0.05)]"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                {body}
              </div>
            );
          })}
        </div>

        <p className="mt-10 text-center text-xs text-neutral-400">
          Une capacité vous semble manquer ? L&apos;API publique et les webhooks permettent déjà de la composer.
        </p>
      </div>
    </div>
  );
}

export default function FeaturesPage() {
  return (
    <FeatureAuthGate
      feature="Fonctionnalités cachées"
      description="Connectez-vous pour accéder à l'inventaire des capacités avancées de Gen3ia."
    >
      <FeaturesContent />
    </FeatureAuthGate>
  );
}
