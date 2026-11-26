/**
 * LIVE EVENT BUS — bus d'événements central (mission Phase 1 : « transmission
 * des événements », « historique des événements »). Pub/Sub en mémoire +
 * persistance via store injectable. Chaque mode (vocal, caméra, écran,
 * agent, collaboration) publie ICI : un seul historique commun (mission
 * Phase 9 : « un historique commun »), des abonnés filtrés par type/mode.
 */

import { randomUUID } from "node:crypto";

import type { EvenementLive, ModeLive, StoreEvenementsLive } from "./live-core-types";

type Abonne = (evenement: EvenementLive) => void;

export interface BusEvenements {
  publier(evenement: Omit<EvenementLive, "id" | "horodatage"> & { id?: string; horodatage?: number }): Promise<EvenementLive>;
  abonner(filtre: { types?: string[]; mode?: ModeLive | "participant" | "systeme" }, abonne: Abonne): () => void;
  historique(sessionId: string, limite?: number): Promise<EvenementLive[]>;
}

const globalBus = globalThis as typeof globalThis & { __gen3iaLiveBus?: BusEvenements };

export function obtenirBusEvenements(store?: StoreEvenementsLive): BusEvenements {
  if (globalBus.__gen3iaLiveBus && !store) return globalBus.__gen3iaLiveBus;
  const abonnements: Array<{ filtre: { types?: string[]; mode?: string }; abonne: Abonne }> = [];
  const bus: BusEvenements = {
    async publier(brut) {
      const evenement: EvenementLive = {
        id: brut.id ?? randomUUID(),
        sessionId: brut.sessionId,
        type: brut.type,
        source: brut.source,
        emetteur: brut.emetteur,
        horodatage: brut.horodatage ?? Date.now(),
        charge: brut.charge,
      };
      if (store) await store.ajouter(evenement);
      for (const { filtre, abonne } of abonnements) {
        if (filtre.types && !filtre.types.includes(evenement.type)) continue;
        if ("mode" in filtre && filtre.mode && filtre.mode !== evenement.source) continue;
        try { abonne(evenement); } catch { /* un abonné défaillant ne bloque pas le bus */ }
      }
      return evenement;
    },
    abonner(filtre, abonne) {
      abonnements.push({ filtre, abonne });
      return () => {
        const i = abonnements.findIndex((a) => a.abonne === abonne);
        if (i >= 0) abonnements.splice(i, 1);
      };
    },
    async historique(sessionId, limite) {
      return store ? store.historique(sessionId, limite) : [];
    },
  };
  if (!store) globalBus.__gen3iaLiveBus = bus; // bus singleton en production
  return bus;
}

export function reinitialiserBus(): void {
  delete globalBus.__gen3iaLiveBus;
}
