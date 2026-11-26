/**
 * LIVE CORE TYPES + STORE — fondation du Live Engine central (mission
 * GEN3IA LIVE Phase 1). Réutilise les contrats existants de lib/live/types
 * (permissions zod, statuts) et étend sans casser : modes des cinq services,
 * participants/rôles, événements typés. Le store est INJECTABLE : mémoire
 * (tests/état temporaire) ou Firestore (production, via repository) —
 * honnêteté : Redis n'existe pas encore dans ce projet, la mission le
 * prévoit cible et l'adaptation sera ajoutée sans changer ces interfaces.
 */

import { randomUUID } from "node:crypto";

import type { LivePermission } from "../types";

/** Les cinq services Live (mission §1) — modes indépendants d'une session. */
export const MODES_LIVE = ["vocal", "camera", "ecran", "agent", "collaboration"] as const;
export type ModeLive = (typeof MODES_LIVE)[number];

/** Rôles collaboratifs (mission Phase 8 — tableau des permissions). */
export type RoleParticipant = "proprietaire" | "administrateur" | "collaborateur" | "observateur" | "agent";

export interface ParticipantLive {
  id: string;
  nom: string;
  role: RoleParticipant;
  permissions: LivePermission[];
  present: boolean;
  dernierPouls: number;
}

export interface SessionLive {
  id: string;
  proprietaireId: string;
  statut: "pending" | "active" | "pause" | "terminee" | "expiree";
  modesActifs: Set<ModeLive>;
  participants: Map<string, ParticipantLive>;
  /** Date ms — expiration automatique (mission Phase 1 : expiration). */
  expireA: number;
  creeA: number;
  /** Durée limite de session selon l'offre (ms) — Phase 12. */
  dureeMaxMs: number;
}

/** Événement Live typé (bus + historique). */
export interface EvenementLive {
  id: string;
  sessionId: string;
  type: string;
  source: ModeLive | "systeme" | "participant";
  emetteur?: string;
  horodatage: number;
  charge?: unknown;
}

/** Contrat de persistance injectable (mémoire pour tests, Firestore prod). */
export interface StoreSessionsLive {
  creer(session: SessionLive): Promise<void>;
  lire(id: string): Promise<SessionLive | null>;
  maj(session: SessionLive): Promise<void>;
  lister(filtre?: { proprietaireId?: string; statut?: SessionLive["statut"] }): Promise<SessionLive[]>;
}

export interface StoreEvenementsLive {
  ajouter(evenement: EvenementLive): Promise<void>;
  historique(sessionId: string, limite?: number): Promise<EvenementLive[]>;
}

/** Store mémoire (tests, état temporaire — remplace Redis tant qu'absent). */
export function createStoreMemoire(): StoreSessionsLive & StoreEvenementsLive & { vider(): void } {
  const sessions = new Map<string, SessionLive>();
  const evenements: EvenementLive[] = [];
  return {
    async creer(s) { sessions.set(s.id, s); },
    async lire(id) { return sessions.get(id) ?? null; },
    async maj(s) { sessions.set(s.id, s); },
    async lister(f = {}) {
      return [...sessions.values()].filter((s) =>
        (!f.proprietaireId || s.proprietaireId === f.proprietaireId) && (!f.statut || s.statut === f.statut));
    },
    async ajouter(e) { evenements.push(e); if (evenements.length > 5000) evenements.shift(); },
    async historique(sessionId, limite = 100) {
      return evenements.filter((e) => e.sessionId === sessionId).slice(-limite);
    },
    vider() { sessions.clear(); evenements.length = 0; },
  };
}

/** Nouvelle session avec propriétaire et durée limite. */
export function nouvelleSession(params: {
  proprietaireId: string;
  dureeMaxMs?: number;
  maintenant?: number;
}): SessionLive {
  const maintenant = params.maintenant ?? Date.now();
  return {
    id: randomUUID(),
    proprietaireId: params.proprietaireId,
    statut: "pending",
    modesActifs: new Set(),
    participants: new Map(),
    expireA: maintenant + (params.dureeMaxMs ?? 2 * 60 * 60 * 1000),
    creeA: maintenant,
    dureeMaxMs: params.dureeMaxMs ?? 2 * 60 * 60 * 1000,
  };
}
