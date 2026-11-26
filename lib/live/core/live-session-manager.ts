/**
 * LIVE SESSION MANAGER — cycle de vie UNIQUE des sessions (mission Phase 1,
 * API cible POST /api/live/sessions, start/pause/resume/stop/join/leave,
 * expiration automatique, récupération après déconnexion). Réutilise le
 * modèle existant (lib/live/types) et un store injectable (mémoire/Firestore).
 * Le manager est le SEUL à écrire les sessions : aucune décision concurrente.
 */

import { randomUUID } from "node:crypto";

import { MODES_LIVE, nouvelleSession, type ModeLive, type ParticipantLive, type RoleParticipant, type SessionLive, type StoreSessionsLive } from "./live-core-types";

export interface GestionnaireSessions {
  creer(params: { proprietaireId: string; dureeMaxMs?: number; maintenant?: number }): Promise<SessionLive>;
  lire(sessionId: string): Promise<SessionLive>;
  activerMode(sessionId: string, mode: ModeLive, demandeurId: string): Promise<SessionLive>;
  desactiverMode(sessionId: string, mode: ModeLive, demandeurId: string): Promise<SessionLive>;
  demarrer(sessionId: string, demandeurId: string): Promise<SessionLive>;
  pauser(sessionId: string, demandeurId: string): Promise<SessionLive>;
  reprendre(sessionId: string, demandeurId: string): Promise<SessionLive>;
  arreter(sessionId: string, demandeurId: string): Promise<SessionLive>;
  rejoindre(params: { sessionId: string; participantId: string; nom: string; role: RoleParticipant }): Promise<ParticipantLive>;
  quitter(sessionId: string, participantId: string): Promise<void>;
  pouls(sessionId: string, participantId: string): Promise<void>;
  /** Récupération après déconnexion : les participants muets sont marqués absents, la session reste ré-joinable. */
  balayage(): Promise<{ expirees: string[]; absents: string[] }>;
}

const POULS_EXPIRATION_MS = 120_000; // cohérent avec le watchdog 75 s du gateway

export function creerGestionnaireSessions(store: StoreSessionsLive, maintenant: () => number = () => Date.now()): GestionnaireSessions {
  function autoriseProprietaireOuAdmin(s: SessionLive, id: string): boolean {
    const p = s.participants.get(id);
    return s.proprietaireId === id || p?.role === "administrateur";
  }

  async function majStatut(sessionId: string, statut: SessionLive["statut"], demandeurId: string): Promise<SessionLive> {
    const s = await lire(sessionId);
    if (!autoriseProprietaireOuAdmin(s, demandeurId)) {
      throw new Error(`participant ${demandeurId} non autorisé à modifier la session ${sessionId} (propriétaire ou administrateur requis)`);
    }
    s.statut = statut;
    if (statut === "active" && s.expireA - maintenant() < s.dureeMaxMs / 2) {
      s.expireA = maintenant() + s.dureeMaxMs; // reprise prolonge la fenêtre
    }
    await store.maj(s);
    return s;
  }

  async function lire(sessionId: string): Promise<SessionLive> {
    const s = await store.lire(sessionId);
    if (!s) throw new Error(`session ${sessionId} inconnue`);
    return s;
  }

  return {
    async creer(params) {
      const s = nouvelleSession({ proprietaireId: params.proprietaireId, dureeMaxMs: params.dureeMaxMs, maintenant: params.maintenant ?? maintenant() });
      s.participants.set(params.proprietaireId, {
        id: params.proprietaireId,
        nom: "propriétaire",
        role: "proprietaire",
        permissions: [],
        present: true,
        dernierPouls: maintenant(),
      });
      await store.creer(s);
      return s;
    },

    lire,

    async activerMode(sessionId, mode, demandeurId) {
      const s = await lire(sessionId);
      if (!MODES_LIVE.includes(mode)) throw new Error(`mode inconnu : ${mode}`);
      if (s.statut !== "active" && s.statut !== "pending") {
        throw new Error(`session ${sessionId} en statut ${s.statut} — modes indisponibles`);
      }
      if (s.proprietaireId !== demandeurId) {
        const p = s.participants.get(demandeurId);
        if (!p || (p.role !== "administrateur" && p.role !== "collaborateur")) {
          throw new Error(`participant ${demandeurId} non autorisé à activer le mode ${mode}`);
        }
      }
      s.modesActifs.add(mode); // les modes s'activent indépendamment (mission Phase 9)
      await store.maj(s);
      return s;
    },

    async desactiverMode(sessionId, mode, demandeurId) {
      const s = await lire(sessionId);
      if (s.proprietaireId !== demandeurId && s.participants.get(demandeurId)?.role !== "administrateur") {
        throw new Error(`participant ${demandeurId} non autorisé à désactiver le mode ${mode}`);
      }
      s.modesActifs.delete(mode);
      await store.maj(s);
      return s;
    },

    demarrer: (id, demandeur) => majStatut(id, "active", demandeur),
    pauser: (id, demandeur) => majStatut(id, "pause", demandeur),
    reprendre: (id, demandeur) => majStatut(id, "active", demandeur),
    arreter: (id, demandeur) => majStatut(id, "terminee", demandeur),

    async rejoindre({ sessionId, participantId, nom, role }) {
      const s = await lire(sessionId);
      if (s.statut === "terminee" || s.statut === "expiree") {
        throw new Error(`session ${sessionId} fermée — join refusé`);
      }
      const existant = s.participants.get(participantId);
      const participant: ParticipantLive = existant
        ? { ...existant, present: true, dernierPouls: maintenant(), nom: nom || existant.nom, role }
        : { id: participantId, nom, role, permissions: [], present: true, dernierPouls: maintenant() };
      s.participants.set(participantId, participant);
      await store.maj(s);
      return participant;
    },

    async quitter(sessionId, participantId) {
      const s = await lire(sessionId);
      const p = s.participants.get(participantId);
      if (p) {
        p.present = false;
        await store.maj(s);
      }
    },

    async pouls(sessionId, participantId) {
      const s = await lire(sessionId);
      const p = s.participants.get(participantId);
      if (p) {
        p.dernierPouls = maintenant();
        p.present = true;
        await store.maj(s);
      }
    },

    async balayage() {
      const sessions = await store.lister();
      const expirees: string[] = [];
      const absents: string[] = [];
      const t = maintenant();
      for (const s of sessions) {
        if ((s.statut === "active" || s.statut === "pause") && t >= s.expireA) {
          s.statut = "expiree"; // expiration automatique (mission Phase 1)
          await store.maj(s);
          expirees.push(s.id);
        }
        for (const p of s.participants.values()) {
          if (p.present && t - p.dernierPouls > POULS_EXPIRATION_MS) {
            p.present = false; // déconnexion : marqué absent, ré-joinable
            absents.push(`${s.id}/${p.id}`);
          }
        }
        if (absents.length > 0 && s.statut !== "terminee" && s.statut !== "expiree") await store.maj(s);
      }
      return { expirees, absents };
    },
  };
}

/** Identité d'appairage locale (jeton à durée limitée — mission Phase 10). */
export function nouveauJetonAppairage(dureeMs = 5 * 60_000): { jeton: string; expireA: number } {
  return { jeton: randomUUID(), expireA: Date.now() + dureeMs };
}
