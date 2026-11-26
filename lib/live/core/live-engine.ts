/**
 * LIVE ENGINE — façade UNIQUE des cinq services (mission Phase 1 et Phase 9).
 * Composition : gestionnaire de sessions (cycle de vie) + bus d'événements
 * (historique commun) + state manager (présence/verrous) + permissions
 * mappées sur le modèle zod existant (lib/live/types). Un seul cerveau
 * décisionnel : les moteurs spécialisés ne décident jamais en parallèle —
 * ils publient des événements et demandent au cerveau Gen3ia (pont à venir
 * Phase 3 : vision réelle ; canal Gemini conservé comme transport vocal).
 */

import { obtenirBusEvenements, reinitialiserBus } from "./live-event-bus";
import { acquerirVerrou, etatPresence, libererVerrou, marquerDeconnexion, marquerPresence, reinitialiserEtatLive } from "./live-state-manager";
import { creerGestionnaireSessions } from "./live-session-manager";
import type { ModeLive, RoleParticipant, StoreSessionsLive } from "./live-core-types";

/** Permissions du modèle existant exigées par mode (mission : permissions uniques). */
const PERMISSIONS_MODE: Record<ModeLive, { mode: ModeLive; description: string; permissionServeur?: string }> = {
  vocal: { mode: "vocal", description: "micro côté client — consentement utilisateur explicite, aucune permission serveur" },
  camera: { mode: "camera", description: "caméra côté client — consentement utilisateur explicite, aucune permission serveur" },
  ecran: { mode: "ecran", description: "partage d'écran — permission serveur screen.read", permissionServeur: "screen.read" },
  agent: { mode: "agent", description: "agent PC — permissions input/fichiers selon actions, HITL obligatoire" },
  collaboration: { mode: "collaboration", description: "espace partagé — rôle du participant détermine les droits" },
};

export interface LiveEngineOptions {
  store: StoreSessionsLive;
}

export const LiveEngine = {
  /** Ouvre une session (propriétaire + événement + expiration configurée). */
  async ouvrirSession(options: LiveEngineOptions & { proprietaireId: string; dureeMaxMs?: number }) {
    const gestionnaire = creerGestionnaireSessions(options.store);
    const session = await gestionnaire.creer({ proprietaireId: options.proprietaireId, dureeMaxMs: options.dureeMaxMs });
    await obtenirBusEvenements().publier({ sessionId: session.id, type: "session.creee", source: "systeme", charge: { proprietaireId: options.proprietaireId } });
    return session;
  },

  /**
   * Active un mode avec VERROU de ressource (une seule caméra/écran par
   * session) et événement tracé. Le refus est explicite, jamais silencieux.
   */
  async activerMode(options: LiveEngineOptions & { sessionId: string; mode: ModeLive; demandeurId: string }) {
    const gestionnaire = creerGestionnaireSessions(options.store);
    const session = await gestionnaire.activerMode(options.sessionId, options.mode, options.demandeurId);
    const ok = acquerirVerrou(options.sessionId, `mode:${options.mode}`, options.demandeurId);
    if (!ok) {
      throw new Error(`mode ${options.mode} déjà actif pour un autre participant de la session ${options.sessionId} — verrou de ressource refusé`);
    }
    await obtenirBusEvenements().publier({
      sessionId: options.sessionId,
      type: "mode.active",
      source: options.mode === "collaboration" ? "systeme" : options.mode,
      emetteur: options.demandeurId,
      charge: { mode: options.mode, permission: PERMISSIONS_MODE[options.mode].permissionServeur ?? null },
    });
    return session;
  },

  /** Désactive un mode et libère son verrou (arrêt immédiat, indépendant). */
  async desactiverMode(options: LiveEngineOptions & { sessionId: string; mode: ModeLive; demandeurId: string }) {
    const gestionnaire = creerGestionnaireSessions(options.store);
    const session = await gestionnaire.desactiverMode(options.sessionId, options.mode, options.demandeurId);
    libererVerrou(options.sessionId, `mode:${options.mode}`, options.demandeurId);
    await obtenirBusEvenements().publier({ sessionId: options.sessionId, type: "mode.desactive", source: "systeme", emetteur: options.demandeurId, charge: { mode: options.mode } });
    return session;
  },

  /** Le participant signe sa présence (pouls) — retourne les présents. */
  async pouls(options: LiveEngineOptions & { sessionId: string; participantId: string }) {
    const gestionnaire = creerGestionnaireSessions(options.store);
    await gestionnaire.pouls(options.sessionId, options.participantId);
    return marquerPresence(options.sessionId, options.participantId);
  },

  /** Déconnexion : présence retirée, session ré-joinable (récupération). */
  async deconnexion(options: LiveEngineOptions & { sessionId: string; participantId: string }) {
    const gestionnaire = creerGestionnaireSessions(options.store);
    await gestionnaire.quitter(options.sessionId, options.participantId);
    return marquerDeconnexion(options.sessionId, options.participantId);
  },

  /** Rejoint la session avec un rôle (propriétaire/admin/collab/observateur/agent). */
  async rejoindre(options: LiveEngineOptions & { sessionId: string; participantId: string; nom: string; role: RoleParticipant }) {
    const gestionnaire = creerGestionnaireSessions(options.store);
    return gestionnaire.rejoindre({ sessionId: options.sessionId, participantId: options.participantId, nom: options.nom, role: options.role });
  },

  /** Vue d'ensemble (dashboard) : session + présence + permissions du mode. */
  async vue(options: LiveEngineOptions & { sessionId: string }) {
    const gestionnaire = creerGestionnaireSessions(options.store);
    const session = await gestionnaire.lire(options.sessionId);
    return {
      session,
      presents: etatPresence(options.sessionId),
      modes: [...session.modesActifs].map((m) => PERMISSIONS_MODE[m]),
    };
  },

  /** Purge mémoire (tests). */
  reinitialiserMemoire(): void {
    reinitialiserBus();
    reinitialiserEtatLive();
  },
};
