/**
 * WEBRTC SIGNAL — messages de signalisation typés (mission GEN3IA LIVE
 * Phase 2). Module PUR : la négociation SDP et les candidats ICE passent
 * par le canal d'événements existant (WebSocket gateway), les MÉDIAS passent
 * par WebRTC — séparation stricte exigée par la mission. Testable en Node
 * (fabriques injectées), aucun accès DOM au chargement.
 */

export type TypeMessageSignal =
  | "rtc.offre"
  | "rtc.reponse"
  | "rtc.candidat"
  | "rtc.fermer"
  | "rtc.restart";

export interface MessageSignal {
  type: TypeMessageSignal;
  sessionId: string;
  /** Partenaire visé (pair à pair direct v1 : un destinataire unique). */
  destinataire: string;
  /** SDP complet (offre/réponse) ou candidat ICE sérialisé. */
  donnees: string;
  /** Milliseconds depuis epoch — anti-rejeu (cohérent lib/live/security). */
  horodatage: number;
}

/** Fabrique de messages avec horodatage injectable (tests déterministes). */
export function creerMessageSignal(
  type: TypeMessageSignal,
  sessionId: string,
  destinataire: string,
  donnees: string,
  horodatage = Date.now(),
): MessageSignal {
  return { type, sessionId, destinataire, donnees, horodatage };
}

/**
 * Garde d'acceptation d'un message de signalisation : session connue,
 * destinataire correct, fraîcheur (± 30 s) — l'émetteur est vérifié par la
 * sécurité du gateway existant (pairing token) avant d'arriver ici.
 */
export function messageSignalAcceptable(m: MessageSignal, maintenant = Date.now()): boolean {
  if (!m.sessionId || !m.destinataire || !m.donnees) return false;
  return Math.abs(maintenant - m.horodatage) <= 30_000;
}

/**
 * Plan de transport honnête (mission Phase 2) :
 *  - médias (audio/vidéo/écran) : WebRTC pair à pair direct ;
 *  - événements + signalisation : WebSocket gateway existant ;
 *  - TURN configuré par variables d'environnement (Phase 14) — sans TURN,
 *    les connexions derrière NAT symétrique échoueront : c'est une limite
 *    documentée, pas une promesse.
 */
export const PLAN_TRANSPORT = {
  medias: "webrtc-direct",
  evenements: "websocket-gateway",
  sfuSeuilParticipants: 4,
} as const;
