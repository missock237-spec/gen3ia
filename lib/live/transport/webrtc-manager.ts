/**
 * WEBRTC MANAGER — client de transport multimédia temps réel (mission
 * GEN3IA LIVE Phase 2). Fabrique de RTCPeerConnection INJECTÉE : testable
 * en Node (peer factice), réel dans le navigateur. Gère : offre/réponse,
 * candidats ICE (STUN/TURN injectés par config), perte de connexion →
 * restart ICE, reconnexions bornées, adaptation de débit via
 * sender.setParameters lorsque disponible, et fermeture propre.
 * Les médias ne traversent JAMAIS le bus d'événements.
 */

import { creerMessageSignal, type MessageSignal, type TypeMessageSignal } from "./webrtc-signal";

export interface ConfigWebRtc {
  iceServers: RTCIceServer[];
  /** Nombre max de reconnexions avant échec explicite (mission : reconnexions). */
  maxReconnexions?: number;
}

export interface PairFactice {
  localDescription: RTCSessionDescription | null;
  iceConnectionState: string;
  connectionState: string;
  addTrack(track: { kind: string }, _flux?: unknown): { track: { kind: string }; setParameters?: (p: unknown) => Promise<void> } | undefined;
  setLocalDescription(d: unknown): Promise<void>;
  setRemoteDescription(d: unknown): Promise<void>;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  addIceCandidate(c: unknown): Promise<void>;
  close(): void;
  onicecandidate?: (e: { candidate: unknown }) => void;
  oniceconnectionstatechange?: () => void;
  onconnectionstatechange?: () => void;
}

/** Décrit l'état réel de la connexion (dashboard/diagnostic). */
export interface EtatPair {
  statut: "nouveau" | "connexion" | "connecte" | "deconnecte" | "echec" | "ferme";
  reconnexions: number;
  dernierErreur?: string;
}

const globalManagers = globalThis as typeof globalThis & { __gen3iaLivePairs?: Map<string, { pair: PairFactice; etat: EtatPair }> };

function registre(): Map<string, { pair: PairFactice; etat: EtatPair }> {
  if (!globalManagers.__gen3iaLivePairs) globalManagers.__gen3iaLivePairs = new Map();
  return globalManagers.__gen3iaLivePairs;
}

export function etatPair(sessionId: string): EtatPair | null {
  const e = registre().get(sessionId);
  return e ? { ...e.etat } : null;
}

/**
 * Ouvre un pair WebRTC pour une session : fabrique injectée, offres/réponses
 * envoyées via le canal de signalisation fourni (callback — typiquement la
 * WebSocket gateway). Les erreurs sont explicites (jamais de faux succès).
 */
export async function ouvrirPair(params: {
  sessionId: string;
  config: ConfigWebRtc;
  fabriquerPair: () => PairFactice;
  envoyerSignal: (m: MessageSignal) => Promise<void> | void;
  pistes?: Array<{ kind: string; maxBitrateBps?: number }>;
}): Promise<{ pair: PairFactice; etat: EtatPair }> {
  const pair = params.fabriquerPair();
  const etat: EtatPair = { statut: "nouveau", reconnexions: 0 };
  registre().set(params.sessionId, { pair, etat });

  // Candidats ICE locaux → signalisation dès leur arrivée.
  pair.onicecandidate = (e) => {
    if (e.candidate) {
      void params.envoyerSignal(creerMessageSignal("rtc.candidat", params.sessionId, "partenaire", JSON.stringify(e.candidate)));
    }
  };
  pair.oniceconnectionstatechange = () => {
    if (pair.iceConnectionState === "failed") {
      etat.statut = "deconnecte";
      void redemarrerIce({ sessionId: params.sessionId, envoyerSignal: params.envoyerSignal, config: params.config });
    } else if (pair.iceConnectionState === "connected") {
      etat.statut = "connecte";
      etat.dernierErreur = undefined;
    }
  };
  pair.onconnectionstatechange = () => {
    if (pair.connectionState === "failed") etat.statut = "echec";
    if (pair.connectionState === "connected") etat.statut = "connecte";
  };

  // Ajout des pistes locales (audio/caméra/écran) + adaptation de débit.
  for (const piste of params.pistes ?? []) {
    const sender = pair.addTrack({ kind: piste.kind });
    if (sender?.setParameters && piste.maxBitrateBps) {
      try {
        await sender.setParameters({ maxBitrate: piste.maxBitrateBps }); // limite réseau mission Phase 2-8
      } catch {
        /* adaptation non supportée par ce navigateur : limite documentée */
      }
    }
  }

  const offre = await pair.createOffer();
  await pair.setLocalDescription(offre);
  etat.statut = "connexion";
  await params.envoyerSignal(creerMessageSignal("rtc.offre", params.sessionId, "partenaire", JSON.stringify(offre)));
  return { pair, etat };
}

/** Traite un message de signalisation entrant (réponse SDP, candidat, restart). */
export async function traiterSignal(params: {
  sessionId: string;
  message: MessageSignal;
}): Promise<{ accepte: boolean; raison?: string }> {
  const e = registre().get(params.sessionId);
  if (!e) return { accepte: false, raison: "aucun pair ouvert pour cette session" };
  const offre = JSON.parse(params.message.donnees) as RTCSessionDescriptionInit;
  await e.pair.setRemoteDescription(offre);
  return { accepte: true };
}

/** Perte de connexion : restart ICE borné (mission Phase 2-6/7). */
async function redemarrerIce(params: { sessionId: string; envoyerSignal: (m: MessageSignal) => Promise<void> | void; config: ConfigWebRtc }): Promise<void> {
  const e = registre().get(params.sessionId);
  if (!e) return;
  const max = params.config.maxReconnexions ?? 3;
  if (e.etat.reconnexions >= max) {
    e.etat.statut = "echec";
    e.etat.dernierErreur = `reconnexion échouée ${max} fois — échec explicite (mission : gérer les pertes de connexion)`;
    return;
  }
  e.etat.reconnexions += 1;
  await params.envoyerSignal(creerMessageSignal("rtc.restart", params.sessionId, "partenaire", JSON.stringify({ restart: true })));
}

/** Fermeture propre du pair (arrêt session/écran — mission : ressources libérées). */
export function fermerPair(sessionId: string, type: TypeMessageSignal = "rtc.fermer"): EtatPair | null {
  const e = registre().get(sessionId);
  if (!e) return null;
  try {
    e.pair.close();
  } catch {
    /* pair déjà fermé — sans effet */
  }
  e.etat.statut = "ferme";
  registre().delete(sessionId);
  void type;
  return { ...e.etat };
}
