/**
 * SFU ADAPTER — v1 honnête (mission Phase 2 : « les services SFU ne sont
 * nécessaires que lorsque plusieurs participants doivent recevoir les flux
 * simultanément. Une communication directe WebRTC peut suffire pour les
 * premières versions »). Le projet limite déjà les viewers à 3 (gateway,
 * MAX_VIEWERS_PER_SESSION) : le mode DIRECT pair-à-pair suffit ; l'adaptateur
 * expose la bascule vers un SFU externe sans changer les contrats.
 */

import { PLAN_TRANSPORT } from "./webrtc-signal";

export type ModeDiffusion = "direct" | "sfu";

export function choisirModeDiffusion(nbParticipantsReceveurs: number): { mode: ModeDiffusion; raison: string } {
  if (nbParticipantsReceveurs >= PLAN_TRANSPORT.sfuSeuilParticipants) {
    return {
      mode: "sfu",
      raison: `${nbParticipantsReceveurs} receveurs ≥ seuil ${PLAN_TRANSPORT.sfuSeuilParticipants} — un SFU externe (cible mission) doit être configuré via GEN3IA_LIVE_GATEWAY_URL avant activation`,
    };
  }
  return {
    mode: "direct",
    raison: `${nbParticipantsReceveurs} receveurs < seuil ${PLAN_TRANSPORT.sfuSeuilParticipants} — pair-à-pair direct WebRTC (aucune infrastructure supplémentaire requise)`,
  };
}
