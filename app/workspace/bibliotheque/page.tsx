"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { SectionHeader } from "@/components/shells/section-header";
import { EmptyState, LoadingState } from "@/components/shells/states";
import { authFetch } from "@/lib/firebase/auth-client";
import type { WorkspaceProject } from "@/lib/domain/projects/repository";

/**
 * /workspace/bibliotheque — les modules métier (Marketing, Sales, RH,
 * Finance…) ne sont plus des destinations de navigation : ce sont des
 * capacités contextuelles. Chaque capacité ouvre une conversation avec un
 * prompt de départ adapté, dans le projet de votre choix.
 */

interface Capability {
  id: string;
  label: string;
  icon: string;
  description: string;
  category: string;
  starterPrompt: string;
}

const CAPABILITIES: Capability[] = [
  {
    id: "marketing-landing",
    label: "Landing Page",
    icon: "▶",
    description: "Générer une page d'atterrissage convaincante à partir de votre offre.",
    category: "Marketing",
    starterPrompt:
      "Crée une landing page complète pour mon offre : accroche, bénéfices, preuve sociale, FAQ et appel à l'action clair.",
  },
  {
    id: "marketing-webinar",
    label: "Webinar → Contenus",
    icon: "◉",
    description: "Transformer un webinaire en articles, posts et séquences e-mail.",
    category: "Marketing",
    starterPrompt:
      "À partir du transcript de mon webinaire, produis un article de blog, trois posts LinkedIn et une séquence de trois e-mails.",
  },
  {
    id: "sales-call-intelligence",
    label: "Call Intelligence",
    icon: "◍",
    description: "Analyser un appel commercial : objections, prochaines étapes, score.",
    category: "Sales",
    starterPrompt:
      "Analyse le transcript de cet appel commercial : identifie les objections, les signaux d'achat, le next step recommandé et rédige le compte rendu.",
  },
  {
    id: "hr-leaves",
    label: "Congés",
    icon: "◷",
    description: "Compter les jours ouvrés, vérifier les soldes, planifier.",
    category: "RH",
    starterPrompt:
      "Calcule les jours ouvrés d'une demande de congés du 5 au 16 du mois prochain en excluant les jours fériés, et rédige la réponse de validation.",
  },
  {
    id: "hr-training",
    label: "Formations",
    icon: "◇",
    description: "Construire un parcours de formation structuré.",
    category: "RH",
    starterPrompt:
      "Construis un parcours de formation en 6 modules pour onboarder un commercial : objectifs, contenus, quiz et critères de validation.",
  },
  {
    id: "documents-contracts",
    label: "Contrats",
    icon: "≡",
    description: "Générer un contrat ou une convention structurée.",
    category: "Documents",
    starterPrompt:
      "Rédige un contrat de prestation de services clair : parties, objet, livrables, pénalités, confidentialité, réversibilité et conditions de paiement.",
  },
  {
    id: "compliance-gdpr",
    label: "RGPD",
    icon: "⚖",
    description: "Registre de traitement, politique de confidentialité.",
    category: "Conformité",
    starterPrompt:
      "Rédige le registre des traitements RGPD pour une PME utilisant un CRM et une newsletter, puis la politique de confidentialité associée.",
  },
  {
    id: "operations-maintenance",
    label: "Maintenance",
    icon: "⚙",
    description: "Plan de maintenance préventive et échéances.",
    category: "Opérations",
    starterPrompt:
      "Établis un plan de maintenance préventive trimestriel pour mes équipements : fréquences, checklists et responsables.",
  },
  {
    id: "finance-cashflow",
    label: "Cashflow",
    icon: "₣",
    description: "Prévision de trésorerie sur 12 semaines.",
    category: "Finance",
    starterPrompt:
      "À partir de ces encaissements et décaissements prévus, construis une prévision de trésorerie sur 12 semaines avec le point bas identifié.",
  },
  {
    id: "finance-unpaid",
    label: "Impayés",
    icon: "◈",
    description: "Relances graduées et suivi des règlements.",
    category: "Finance",
    starterPrompt:
      "Rédige une séquence de relance graduée (courtoise, ferme, mise en demeure) pour une facture échue depuis 30 jours.",
  },
  {
    id: "automation",
    label: "Automatisations",
    icon: "✦",
    description: "Décrire un workflow événementiel à mettre en place.",
    category: "Automatisation",
    starterPrompt:
      "Mets en place une automatisation : quand une facture dépasse 30 jours d'échéance, crée une tâche de relance et notifie le responsable.",
  },
  {
    id: "research",
    label: "Recherche web",
    icon: "⌕",
    description: "Veille et synthèse sourcée sur un sujet.",
    category: "Général",
    starterPrompt:
      "Recherche sur le web les trois tendances majeures de mon secteur cette année et produis une synthèse sourcée.",
  },
];

const CATEGORY_ORDER = ["Général", "Marketing", "Sales", "RH", "Documents", "Conformité", "Opérations", "Finance", "Automatisation"];

export default function LibraryPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [projectId, setProjectId] = useState<string>("");
  const [category, setCategory] = useState<string>("Toutes");
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    authFetch("/api/workspace/projects?limit=50", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data = (await response.json()) as { projects: WorkspaceProject[] };
        if (!cancelled) setProjects(data.projects);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(
    () => ["Toutes", ...CATEGORY_ORDER.filter((c) => CAPABILITIES.some((cap) => cap.category === c))],
    [],
  );

  const visible = useMemo(
    () => (category === "Toutes" ? CAPABILITIES : CAPABILITIES.filter((cap) => cap.category === category)),
    [category],
  );

  const startConversation = async (capability: Capability) => {
    setStartingId(capability.id);
    setError("");
    try {
      const response = await authFetch("/api/workspace/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: capability.label,
          ...(projectId ? { projectId } : {}),
        }),
      });
      if (!response.ok) throw new Error("Création de la conversation impossible.");
      const data = (await response.json()) as { conversation: { id: string } };
      // Premier message : la capacité devient un prompt de départ réel.
      await authFetch(`/api/workspace/conversations/${data.conversation.id}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: capability.starterPrompt, ...(projectId ? { projectId } : {}) }),
      });
      router.push(`/workspace/conversations/${data.conversation.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Démarrage impossible.");
      setStartingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="ESPACE DE TRAVAIL"
        title="Bibliothèque"
        highlight="de capacités"
        description="Les modules métier deviennent des capacités activables dans vos conversations : chaque capacité démarre une conversation avec un objectif pré-rempli, dans le contexte du projet choisi."
        action={
          <Link href="/studio/agents" className="g3-btn g3-btn-ghost text-xs">
            Agents spécialisés →
          </Link>
        }
      />

      <div className="g3-card flex flex-wrap items-center gap-3 !p-3">
        <label className="flex items-center gap-2 text-xs text-[var(--g3-muted)]">
          Démarrer dans
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            className="g3-select !min-h-0 !w-auto !py-1.5 text-xs"
            aria-label="Projet de contexte pour les nouvelles conversations"
          >
            <option value="">Sans projet</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                ▦ {project.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filtrer les capacités">
          {categories.map((c) => (
            <button key={c} type="button" data-selected={category === c} onClick={() => setCategory(c)} className="g3-chip text-[11px]">
              {c}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-[rgba(246,98,110,0.35)] bg-[var(--g3-danger-soft)] px-3 py-2 text-xs text-[var(--g3-danger-strong)]" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <LoadingState label="Chargement de la bibliothèque…" />
      ) : visible.length === 0 ? (
        <EmptyState icon="◇" title="Aucune capacité dans cette catégorie" description="Choisissez une autre catégorie." />
      ) : (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" role="list">
          {visible.map((capability) => (
            <li key={capability.id} className="g3-card flex flex-col !p-4">
              <div className="flex items-center gap-2.5">
                <span className="grid size-9 place-items-center rounded-xl bg-[var(--g3-deep)] text-sm text-white" aria-hidden>
                  {capability.icon}
                </span>
                <div>
                  <p className="text-sm font-semibold text-[var(--g3-text)]">{capability.label}</p>
                  <p className="text-[10px] uppercase tracking-wide text-[var(--g3-faint)]">{capability.category}</p>
                </div>
              </div>
              <p className="mt-2.5 flex-1 text-xs leading-relaxed text-[var(--g3-muted)]">{capability.description}</p>
              <button
                type="button"
                onClick={() => void startConversation(capability)}
                disabled={startingId !== null}
                className="g3-btn g3-btn-primary mt-3 w-full text-xs"
              >
                {startingId === capability.id ? "Ouverture de la conversation…" : "Lancer dans une conversation"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11px] leading-relaxed text-[var(--g3-muted)]">
        Ces capacités s&apos;appuient sur les six moteurs communs de la plateforme (IA, documents, workflow,
        planification, analytique, données) et sur vos connecteurs. Les agents spécialisés restent disponibles
        dans <Link href="/studio/agents" className="underline underline-offset-2">l&apos;espace Agents</Link>.
      </p>
    </div>
  );
}
