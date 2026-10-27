import "server-only";

import type { Workflow } from "@/lib/workflows/types";

/**
 * AGENTS VERTICAUX CLÉS EN MAIN (P3 — « fais fonctionner de bout en bout
 * 3 agents verticaux : restaurant WhatsApp, prospection et contenu »).
 *
 * Pour CHAQUE vertical, ce module fournit :
 *   1. la définition d'agent (charte : type wizard, compétences, outils
 *      déclarés — outils VÉRIFIÉS présents dans lib/tools/registry.ts) ;
 *   2. un template de workflow PRÊT À INSTANCIER (graphe réel exécutable
 *      par lib/workflows/executor.ts : nœuds agent → condition → tool →
 *      output) + son déclencheur (webhook ou cron, P2) ;
 *   3. un test unitaire garantit : charte construite, outils existants au
 *      registre, workflow validé par validateWorkflow, déclencheurs
 *      cohérents — la preuve mécanique du « bout en bout » sans besoin des
 *      credentials externes (WhatsApp/LLM) qui restent à configurer par
 *      le propriétaire.
 *
 * Les verticaux « prospection » et « contenu » s'appuient sur les types
 * wizard existants (sales / content) : ce module ajoute leurs TEMPLATES de
 * workflow et borne leurs outils. Le vertical « restaurant-whatsapp » est
 * NOUVEAU dans le wizard (P3).
 */

export interface TemplateNoeud {
  id: string;
  type: "agent" | "tool" | "condition" | "parallel" | "approval" | "transform" | "output";
  name: string;
  config: Record<string, unknown>;
  x: number;
  y: number;
}

export interface VerticalDefinition {
  /** Clé du type wizard (WIZARD_AGENT_TYPES) associé. */
  key: string;
  /** Nouveau type wizard ajouté par ce module (sinon false). */
  nouveauTypeWizard: boolean;
  baseType: "universal" | "content" | "code" | "research" | "automation";
  label: string;
  description: string;
  /** Clientèle cible (AIvation Labs). */
  clientele: string;
  competences: string[];
  /** Outils métier — chacun DOIT exister dans TOOL_REGISTRY (testé). */
  outils: string[];
  /** Variables attendues dans les templates ({{input.…}}). */
  entreesAttendues: string[];
  /** Déclencheur recommandé du template : webhook (restaurant) ou cron. */
  declencheur: { type: "webhook" | "cron"; intervalMinutes?: number };
  /** Description métier du template (créé à l'instanciation). */
  workflowNom: string;
  workflowDescription: string;
  /** Graphe du template (nœuds + arêtes). */
  noeuds: TemplateNoeud[];
  arêtes: Array<{ source: string; target: string; condition?: string }>;
}

/* ──────────────────────────────────────────────────────────────────── */
/* 1. RESTAURANT WHATSAPP — prise de commande en bout en bout           */
/* ──────────────────────────────────────────────────────────────────── */

const RESTAURANT: VerticalDefinition = {
  key: "restaurant-whatsapp",
  nouveauTypeWizard: true,
  baseType: "universal",
  label: "Restaurant WhatsApp",
  description:
    "Agent de prise de commande pour restaurant : reçoit la commande du client par WhatsApp, vérifie qu'elle est complète (plats, quantités, adresse, créneau), confirme et transmet en cuisine.",
  clientele: "Restaurants, snack, livraison — réception et confirmation automatisées des commandes.",
  competences: [
    "Prise de commande WhatsApp",
    "Saisie structurée (plats, quantités, adresse)",
    "Confirmation client",
    "Relance d'information manquante",
    "Transmission cuisine",
  ],
  outils: ["messaging.send", "artifact.create"],
  entreesAttendues: ["message", "client", "telephone"],
  declencheur: { type: "webhook" },
  workflowNom: "Commande WhatsApp — restaurant",
  workflowDescription:
    "Déclenché par le webhook du canal WhatsApp (P2) : analyse le message du client, détermine si la commande est complète, confirme ou demande l'information manquante.",
  noeuds: [
    {
      id: "analyse-commande",
      type: "agent",
      name: "Analyse de la commande",
      config: {
        instructions:
          "Tu es l'agent de commande d'un restaurant. Analyse le message client {{input.message}} (client {{input.client}}, téléphone {{input.telephone}}). Extrais : plats, quantités, adresse de livraison, créneau. Réponds en JSON : {complete: bool, resume: string, informationManquante: string}. N'invente RIEN : si une information manque, complete=false.",
        task: "Analyser la commande client : {{input.message}}",
      },
      x: 80,
      y: 80,
    },
    {
      id: "commande-complete",
      type: "condition",
      name: "Commande complète ?",
      config: { target: "analyse-commande", op: "contains", value: "complete" },
      x: 320,
      y: 80,
    },
    {
      id: "confirmation-client",
      type: "tool",
      name: "Confirmation WhatsApp au client",
      config: {
        toolName: "messaging.send",
        input: {
          channel: "whatsapp",
          to: "{{input.telephone}}",
          text: "Commande reçue et confirmée : {{analyse-commande}}",
        },
      },
      x: 560,
      y: 20,
    },
    {
      id: "bon-cuisine",
      type: "tool",
      name: "Bon de commande en cuisine",
      config: {
        toolName: "artifact.create",
        input: {
          title: "Commande {{input.client}}",
          content: "{{analyse-commande}}",
        },
      },
      x: 560,
      y: 140,
    },
    {
      id: "demande-manquant",
      type: "tool",
      name: "Demande d'information manquante",
      config: {
        toolName: "messaging.send",
        input: {
          channel: "whatsapp",
          to: "{{input.telephone}}",
          text: "Pour finaliser votre commande, il nous manque : {{analyse-commande}}",
        },
      },
      x: 560,
      y: 260,
    },
    {
      id: "fin",
      type: "output",
      name: "Résultat",
      config: {},
      x: 800,
      y: 80,
    },
  ],
  arêtes: [
    { source: "analyse-commande", target: "commande-complete" },
    // Le routage true/false suit la convention du nœud condition (executor).
    { source: "commande-complete", target: "confirmation-client", condition: "true" },
    { source: "commande-complete", target: "demande-manquant", condition: "false" },
    { source: "confirmation-client", target: "bon-cuisine" },
    { source: "bon-cuisine", target: "fin" },
    { source: "demande-manquant", target: "fin" },
  ],
};

/* ──────────────────────────────────────────────────────────────────── */
/* 2. PROSPECTION — séquence de relance quotidienne (cron)              */
/* ──────────────────────────────────────────────────────────────────── */

const PROSPECTION: VerticalDefinition = {
  key: "sales",
  nouveauTypeWizard: false,
  baseType: "universal",
  label: "Commercial",
  description:
    "Agent de prospection : qualification de leads, séquences de contact et relances planifiées.",
  clientele: "PME et indépendants — prospection sortante régulière sans équipe commerciale dédiée.",
  competences: [
    "Prospection",
    "Qualification de leads",
    "Argumentaire de vente",
    "Séquence de relance",
    "Proposition commerciale",
  ],
  outils: ["messaging.send", "artifact.create"],
  entreesAttendues: ["lead", "offre"],
  declencheur: { type: "cron", intervalMinutes: 1440 },
  workflowNom: "Séquence de prospection quotidienne",
  workflowDescription:
    "Chaque jour (cron P2) : rédige le message de relance adapté au lead, le sauvegarde comme artefact à valider, et prépare l'envoi WhatsApp.",
  noeuds: [
    {
      id: "redige-relance",
      type: "agent",
      name: "Rédaction de la relance",
      config: {
        instructions:
          "Tu es chargé de prospection. Rédige un message de relance court, professionnel et personnalisé pour le lead {{input.lead}}, autour de l'offre {{input.offre}}. Une seule demande d'action claire. N'invente aucun fait sur le lead.",
        task: "Rédiger la relance pour {{input.lead}}",
      },
      x: 80,
      y: 80,
    },
    {
      id: "sauvegarde-brouillon",
      type: "tool",
      name: "Brouillon à valider",
      config: {
        toolName: "artifact.create",
        input: {
          title: "Relance — {{input.lead}}",
          content: "{{redige-relance}}",
        },
      },
      x: 320,
      y: 80,
    },
    {
      id: "envoi-whatsapp",
      type: "tool",
      name: "Envoi WhatsApp au lead",
      config: {
        toolName: "messaging.send",
        input: {
          channel: "whatsapp",
          to: "{{input.telephone}}",
          text: "{{redige-relance}}",
        },
      },
      x: 560,
      y: 80,
    },
    {
      id: "fin",
      type: "output",
      name: "Résultat",
      config: {},
      x: 800,
      y: 80,
    },
  ],
  arêtes: [
    { source: "redige-relance", target: "sauvegarde-brouillon" },
    { source: "sauvegarde-brouillon", target: "envoi-whatsapp" },
    { source: "envoi-whatsapp", target: "fin" },
  ],
};

/* ──────────────────────────────────────────────────────────────────── */
/* 3. CONTENU — pipeline de rédaction planifié (cron)                   */
/* ──────────────────────────────────────────────────────────────────── */

const CONTENU: VerticalDefinition = {
  key: "content",
  nouveauTypeWizard: false,
  baseType: "content",
  label: "Création de contenu",
  description:
    "Agent de contenu : articles, posts réseaux sociaux, scripts vidéo — planifiables et prêts à publier.",
  clientele: "Marques et créateurs — production de contenu régulière sans agence.",
  competences: [
    "Rédaction web",
    "Storytelling",
    "Posts réseaux sociaux",
    "Script vidéo",
    "Calendrier éditorial",
  ],
  outils: ["artifact.create", "web.search"],
  entreesAttendues: ["sujet", "format", "audience"],
  declencheur: { type: "cron", intervalMinutes: 1440 },
  workflowNom: "Pipeline de contenu quotidien",
  workflowDescription:
    "Chaque jour (cron P2) : documente le sujet (recherche web réelle), rédige le contenu au format demandé, le sauvegarde comme artefact prêt à publier.",
  noeuds: [
    {
      id: "documentation",
      type: "tool",
      name: "Documentation du sujet",
      config: {
        toolName: "web.search",
        input: { query: "{{input.sujet}}" },
      },
      x: 80,
      y: 80,
    },
    {
      id: "redaction",
      type: "agent",
      name: "Rédaction du contenu",
      config: {
        instructions:
          "Tu es rédacteur professionnel. À partir de la documentation {{documentation}} et du sujet {{input.sujet}}, rédige un contenu au format {{input.format}} pour l'audience {{input.audience}}. Aucun fait inventé : tout chiffre/source provient de la documentation ou est marqué [À VÉRIFIER].",
        task: "Rédiger un {{input.format}} sur {{input.sujet}}",
      },
      x: 320,
      y: 80,
    },
    {
      id: "publication",
      type: "tool",
      name: "Contenu prêt à publier",
      config: {
        toolName: "artifact.create",
        input: {
          title: "{{input.format}} — {{input.sujet}}",
          content: "{{redaction}}",
        },
      },
      x: 560,
      y: 80,
    },
    {
      id: "fin",
      type: "output",
      name: "Résultat",
      config: {},
      x: 800,
      y: 80,
    },
  ],
  arêtes: [
    { source: "documentation", target: "redaction" },
    { source: "redaction", target: "publication" },
    { source: "publication", target: "fin" },
  ],
};

/** Les 3 verticaux clés en main (demande P3). */
export const VERTICAUX: readonly VerticalDefinition[] = [RESTAURANT, PROSPECTION, CONTENU];

export function verticalParCle(key: string): VerticalDefinition | undefined {
  return VERTICAUX.find((v) => v.key === key);
}

/** Construit le workflow INSTANCIABLE du vertical (conforme WorkflowSchema). */
export function construireWorkflowTemplate(vertical: VerticalDefinition): Workflow {
  return {
    id: `tpl-verticale-${vertical.key}`,
    name: vertical.workflowNom,
    version: 1,
    nodes: vertical.noeuds.map((n) => ({
      id: n.id,
      type: n.type,
      name: n.name,
      config: n.config,
      position: { x: n.x, y: n.y },
      enabled: true,
    })),
    edges: vertical.arêtes.map((a, i) => ({
      id: `e${i}-${a.source}->${a.target}`,
      source: a.source,
      target: a.target,
      ...(a.condition ? { condition: a.condition } : {}),
    })),
  };
}
