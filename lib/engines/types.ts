/**
 * Types partagés des 6 moteurs communs de GEN3IA.
 *
 * Architecture produit (Task 15) : chaque module métier (Marketing, Sales,
 * RH, Documents, Conformité, Opérations, Finance, Automatisations) est une
 * composition fine des moteurs — jamais un silo autonome :
 *
 *  1. AI Engine         — génération, analyse, recommandations (lib/ai/router)
 *  2. Document Engine   — contrats, preuves, rapports (lib/documents)
 *  3. Workflow Engine   — automatisations événementielles et tâches
 *  4. Scheduling Engine — rendez-vous, échéances, congés, maintenance
 *  5. Analytics Engine  — KPI, agrégations, prévisions, rapports
 *  6. Data Engine       — enregistrements métier + cache Redis partagé
 *
 * Les entités Firestore des modules suivent toutes le même contrat :
 * `userId` (propriétaire), `createdAt`/`updatedAt` (epoch ms), et un
 * identifiant `id` injecté par les helpers de repository.
 */

/** Types d'événements métier écoutables par le Workflow Engine. */
export const BUSINESS_EVENT_TYPES = [
  "calendar.event_created",
  "sales.call_analyzed",
  "hr.leave_requested",
  "hr.leave_decided",
  "hr.training_completed",
  "documents.contract_signed",
  "documents.onboarding_completed",
  "gdpr.request_received",
  "gdpr.request_fulfilled",
  "operations.maintenance_recorded",
  "finance.invoice_created",
  "finance.invoice_reminded",
  "finance.invoice_paid",
  "marketing.landing_published",
  "marketing.content_generated",
] as const;

export type BusinessEventType = (typeof BUSINESS_EVENT_TYPES)[number];

/** Contexte transmis à un workflow déclenché par un événement. */
export interface BusinessEventInput {
  userId: string;
  eventType: BusinessEventType;
  payload: Record<string, unknown>;
}

/** Étiquette de module pour les traces d'usage AI (lib/ai/usage). */
export type EngineFeature =
  | "marketing-landing"
  | "marketing-webinar"
  | "sales-call-intelligence"
  | "hr-leaves"
  | "hr-training"
  | "documents-contracts"
  | "documents-onboarding"
  | "compliance-gdpr"
  | "operations-maintenance"
  | "finance-cashflow"
  | "finance-unpaid"
  | "automations-hub"
  | "analytics-report"
  /** Moteur conversationnel du workspace (Conversation-first). */
  | "conversation-turn";

/** Champs communs de toutes les entités modules (document Firestore brut). */
export interface BusinessDocBase {
  id: string;
  userId: string;
  createdAt: number;
  updatedAt: number;
}

/** Helpers de dates : les entités stockent des ISO strings lisibles. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function epochNow(): number {
  return Date.now();
}
