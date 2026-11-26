/**
 * LIVE STORE ADAPTERS — connexions réelles entre le Live Engine central
 * (core/) et les composants EXISTANTS (règle mission : « ne pas créer de
 * fausses intégrations » ; « toute dépendance externe encapsulée dans un
 * adaptateur remplaçable »).
 *
 *  · adapterEvenementsAgent — le bus d'événements d'une session AGENT
 *    persiste via recordLiveEvent (repository Firestore EXISTANT, sous-collection
 *    events) : réutilisation stricte, aucun doublon d'historique.
 *    La dépendance Firestore est chargée DYNAMIQUEMENT : les tests restent
 *    sans Firebase, le remplacement de l'adaptateur reste trivial.
 *  · storeProduction — sessions des cinq services multimodaux en mémoire
 *    process-global (présence/verrous déjà process-global) : la persistance
 *    Firestore des sessions multimodes est prévue au LOT 9 (contexte partagé
 *    des cinq services) — déclarée NON VALIDÉE tant qu'elle n'existe pas.
 */

import { createStoreMemoire, type SessionLive, type StoreSessionsLive, type StoreEvenementsLive, type EvenementLive } from "./live-core-types";

/** Adaptateur événements d'une session AGENT → recordLiveEvent existant. */
export function adapterEvenementsAgent(sessionIdAgent: string): StoreEvenementsLive {
  return {
    async ajouter(evenement: EvenementLive): Promise<void> {
      const repository = await import("../repository");
      await repository.recordLiveEvent(sessionIdAgent, {
        type: evenement.type,
        source: evenement.source,
        emetteur: evenement.emetteur ?? null,
        charge: evenement.charge ?? null,
        horodatage: evenement.horodatage,
      });
    },
    async historique(): Promise<EvenementLive[]> {
      // L'historique des sessions agent reste lu par la route /events existante
      // (aucun doublon de lecture) : l'adapter n'expose que l'écriture.
      throw new Error("historique des sessions agent : lire via GET /api/live/sessions/:id/events (route existante)");
    },
  };
}

/** Store de production des sessions multimodales (mémoire global, borné). */
const globalStore = globalThis as typeof globalThis & { __gen3iaLiveStoreProd?: StoreSessionsLive };

export function storeProduction(): StoreSessionsLive {
  if (!globalStore.__gen3iaLiveStoreProd) {
    globalStore.__gen3iaLiveStoreProd = createStoreMemoire();
  }
  return globalStore.__gen3iaLiveStoreProd;
}

/** Session core ↔ session agent : champs partagés (audit de concurrence). */
export function mapperSessionCoreVersAgent(session: SessionLive): {
  id: string;
  ownerId: string;
  modesActifs: string[];
} {
  return {
    id: session.id,
    ownerId: session.proprietaireId,
    modesActifs: [...session.modesActifs],
  };
}
