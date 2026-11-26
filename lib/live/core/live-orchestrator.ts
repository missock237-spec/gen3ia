/**
 * ORCHESTRATEUR — les cinq services à travers l'architecture UNIQUE (mission
 * LOT 9) : activation combinée sur une session core, interruptions entre
 * services (arrêter l'écran ne coupe pas le vocal), ressources partagées
 * (verrous) et ARRÊT D'URGENCE GLOBAL (LOT 10-13 : stoppe TOUS les modes,
 * libère TOUS les verrous, ferme la conversation vocale et publie
 * « urgence.arret » dans l'historique commun — vérifiable par audit).
 * Le scénario obligatoire est exécuté en test réel : écran + micro +
 * analyse + invitation d'un participant.
 */

import { LiveEngine } from "./live-engine";
import { acquerirVerrou, libererVerrou, reinitialiserEtatLive } from "./live-state-manager";
import { reinitialiserBus } from "./live-event-bus";
import type { ModeLive, RoleParticipant, StoreSessionsLive } from "./live-core-types";

export interface EtatOrchestrateur {
  sessionId: string;
  modesActifs: ModeLive[];
  presents: string[];
}

/** Résumé process-global des ressources vivantes (arrêt d'urgence complet). */
export interface ArretUrgence {
  sessionId: string;
  modesArretes: ModeLive[];
  verrousLiberes: string[];
  horodatage: number;
}

const globalUrgence = globalThis as typeof globalThis & {
  __gen3iaLiveArretes?: Set<string>; // sessions verrouillées après arrêt d'urgence
};

function sessionsArretes(): Set<string> {
  if (!globalUrgence.__gen3iaLiveArretes) globalUrgence.__gen3iaLiveArretes = new Set();
  return globalUrgence.__gen3iaLiveArretes;
}

export interface Orchestrateur {
  /** Ouvre la session d'orchestration (une seule pour les cinq services). */
  ouvrir(propietaireId: string): Promise<EtatOrchestrateur>;
  /** Active un mode avec gestion des conflits de ressources partagées. */
  activer(mode: ModeLive, demandeurId: string): Promise<{ ok: boolean; raison?: string }>;
  /** Désactive un mode SANS toucher aux autres (mission : interruptions entre services). */
  desactiver(mode: ModeLive, demandeurId: string): Promise<{ ok: boolean; raison?: string }>;
  /** Invite un participant (LOT 9 : l'autre utilisateur suit la session). */
  inviter(participantId: string, nom: string, role: RoleParticipant): Promise<{ ok: boolean; raison?: string }>;
  /** Scénario obligatoire LOT 9 (injecté : cerveau + sources réelles de la session). */
  scenarioIntegration(cerveau: { repondre(texte: string, contexte?: string): Promise<string> }): Promise<{
    etapes: Array<{ nom: string; ok: boolean; detail?: string }>;
    reponseVocale?: string;
  }>;
  /** ARRÊT D'URGENCE GLOBAL (LOT 10-13) : tout s'arrête, verrouillé. */
  arretUrgence(demandeurId: string): Promise<ArretUrgence>;
  /** La session est-elle verrouillée par un arrêt d'urgence ? */
  verrouilleUrgence(): boolean;
  etat(): Promise<EtatOrchestrateur>;
}

const MODES_TOUS: ModeLive[] = ["vocal", "camera", "ecran", "agent", "collaboration"];

export function creerOrchestrateur(options: { store: StoreSessionsLive }): Orchestrateur {
  let sessionId: string | null = null;

  return {
    async ouvrir(propietaireId) {
      reinitialiserEtatLive();
      reinitialiserBus();
      const session = await LiveEngine.ouvrirSession({ store: options.store, proprietaireId: propietaireId });
      sessionId = session.id;
      await LiveEngine.pouls({ store: options.store, sessionId: session.id, participantId: propietaireId });
      return { sessionId: session.id, modesActifs: [], presents: [propietaireId] };
    },

    async activer(mode, demandeurId) {
      if (!sessionId) return { ok: false, raison: "aucune session d'orchestration ouverte" };
      if (sessionsArretes().has(sessionId)) {
        return { ok: false, raison: "session verrouillée par un ARRÊT D'URGENCE — aucun mode ne peut être réactivé sans nouvelle session (mission LOT 10)" };
      }
      try {
        await LiveEngine.activerMode({ store: options.store, sessionId, mode, demandeurId });
        return { ok: true };
      } catch (erreur) {
        return { ok: false, raison: erreur instanceof Error ? erreur.message : String(erreur) };
      }
    },

    async desactiver(mode, demandeurId) {
      if (!sessionId) return { ok: false, raison: "aucune session d'orchestration ouverte" };
      try {
        await LiveEngine.desactiverMode({ store: options.store, sessionId, mode, demandeurId });
        return { ok: true };
      } catch (erreur) {
        return { ok: false, raison: erreur instanceof Error ? erreur.message : String(erreur) };
      }
    },

    async inviter(participantId, nom, role) {
      if (!sessionId) return { ok: false, raison: "aucune session d'orchestration ouverte" };
      try {
        await LiveEngine.rejoindre({ store: options.store, sessionId, participantId, nom, role });
        return { ok: true };
      } catch (erreur) {
        return { ok: false, raison: erreur instanceof Error ? erreur.message : String(erreur) };
      }
    },

    async scenarioIntegration(cerveau) {
      const etapes: Array<{ nom: string; ok: boolean; detail?: string }> = [];
      if (!sessionId) return { etapes: [{ nom: "session", ok: false, detail: "aucune session" }] };
      // 1. partage d'écran (propriétaire) — permission serveur screen.read
      const r1 = await this.activer("ecran", "proprio");
      etapes.push({ nom: "partage écran", ok: r1.ok, detail: r1.raison });
      // 2. micro (vocal)
      const r2 = await this.activer("vocal", "proprio");
      etapes.push({ nom: "micro", ok: r2.ok, detail: r2.raison });
      // 3. demande d'analyse à Gen3ia (contexte visuel réel si le moteur vision est branché — ici cerveau injecté)
      let reponseVocale: string | undefined;
      try {
        reponseVocale = await cerveau.repondre("analyse ce que je partage");
        etapes.push({ nom: "analyse Gen3ia", ok: Boolean(reponseVocale) });
      } catch (erreur) {
        etapes.push({ nom: "analyse Gen3ia", ok: false, detail: erreur instanceof Error ? erreur.message : String(erreur) });
      }
      // 4. invitation d'un autre utilisateur
      const r4 = await this.inviter("invite-1", "Collaborateur", "collaborateur");
      etapes.push({ nom: "invitation", ok: r4.ok, detail: r4.raison });
      return { etapes, reponseVocale };
    },

    async arretUrgence(demandeurId) {
      if (!sessionId) throw new Error("aucune session d'orchestration ouverte");
      const session = await LiveEngine.vue({ store: options.store, sessionId });
      if (session.session.proprietaireId !== demandeurId) {
        throw new Error(`seul le propriétaire peut déclencher l'arrêt d'urgence (demandeur : ${demandeurId})`);
      }
      const modesArretes: ModeLive[] = [];
      for (const mode of MODES_TOUS) {
        if (session.session.modesActifs.has(mode)) {
          await LiveEngine.desactiverMode({ store: options.store, sessionId, mode, demandeurId });
          libererVerrou(sessionId, `mode:${mode}`, demandeurId);
          modesArretes.push(mode);
        }
      }
      const etat = await LiveEngine.vue({ store: options.store, sessionId });
      // Statut : la session core passe en "terminee" — un arrêt d'urgence est
      // terminal (mission LOT 10-13 : tout s'arrête et ne repart pas seul).
      etat.session.statut = "terminee";
      await options.store.maj(etat.session);
      sessionsArretes().add(sessionId);
      const arret: ArretUrgence = { sessionId, modesArretes, verrousLiberes: modesArretes.map((m) => `mode:${m}`), horodatage: Date.now() };
      const { obtenirBusEvenements } = await import("./live-event-bus");
      await obtenirBusEvenements().publier({
        sessionId,
        type: "urgence.arret",
        source: "systeme",
        emetteur: demandeurId,
        charge: arret,
      });
      return arret;
    },

    verrouilleUrgence: () => (sessionId ? sessionsArretes().has(sessionId) : false),

    async etat() {
      if (!sessionId) throw new Error("aucune session d'orchestration ouverte");
      const vue = await LiveEngine.vue({ store: options.store, sessionId });
      return {
        sessionId,
        modesActifs: [...vue.session.modesActifs],
        presents: vue.presents,
      };
    },
  };
}
