/**
 * Types d'agents & métadonnées — module FEUILLE volontairement PUR (aucune
 * dépendance zod ni serveur).
 *
 * NOTE PERFORMANCE (audit 09-2026) : ces constantes vivaient dans
 * lib/agents/schema.ts, qui importe zod pour valider les enregistrements.
 * Le composant client AgentChatPanel consomme `labelForAgent` (charter.ts),
 * qui n'a besoin que de AGENT_TYPE_META — un import en valeur vers schema.ts
 * tirait donc tout zod (~24 kB gzip) dans le bundle client des pages de chat.
 * Les constantes pures sont déplacées ici ; schema.ts les ré-exporte pour
 * préserver toutes les API existantes côté serveur.
 */

export const AGENT_TYPES = ["universal", "code", "marketing", "teaching", "commercial", "vocal", "content", "research", "automation", "custom"] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export const VOICE_LANGUAGES = ["fr-FR", "en-US", "en-GB", "es-ES", "de-DE"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const AGENT_TYPE_META: Record<AgentType, { label: string; description: string; securityLevel: "safe" | "standard" | "power" }> = {
  universal: { label: "Universel", description: "Agent polyvalent : raisonnement, recherche web et production de documents.", securityLevel: "standard" },
  code: { label: "Agent de code", description: "Agent developpeur : execution de code sandboxee + Atelier d’Interfaces exclusif.", securityLevel: "power" },
  marketing: { label: "Marketing", description: "Campagnes, contenus marketing, acquisition et communication.", securityLevel: "standard" },
  teaching: { label: "Enseignement", description: "Explication, accompagnement pédagogique et création de supports.", securityLevel: "safe" },
  commercial: { label: "Commercial", description: "Prospection, qualification, suivi commercial et contenus de vente.", securityLevel: "standard" },
  vocal: { label: "Vocal", description: "Interactions vocales, scripts, synthèse et expériences conversationnelles.", securityLevel: "standard" },
  content: { label: "Contenu", description: "Redaction, marketing, generation de documents et publications.", securityLevel: "standard" },
  research: { label: "Recherche", description: "Veille, analyse de marche et synthese documentaire via recherche web.", securityLevel: "standard" },
  automation: { label: "Automatisation", description: "Workflows repetitifs, planification et orchestration d'outils.", securityLevel: "standard" },
  custom: { label: "Personnalisé", description: "Agent spécialisé selon le type métier défini par l’utilisateur.", securityLevel: "standard" },
};
