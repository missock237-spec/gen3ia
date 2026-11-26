import { describe, expect, it } from "vitest";

import { choisirModeDiffusion } from "./sfu-adapter";
import { creerMessageSignal, messageSignalAcceptable, PLAN_TRANSPORT } from "./webrtc-signal";
import { fermerPair, ouvrirPair, traiterSignal, type PairFactice } from "./webrtc-manager";

/**
 * TESTS PHASE 2 — GEN3IA LIVE : transport temps réel. Modules PUR avec
 * peer factice (fabrique injectée) : négociation offre/réponse, candidats
 * ICE → signalisation, perte de connexion → restart ICE borné, adaptation
 * de débit, fermeture propre. Séparation stricte médias (WebRTC) ≠
 * événements (WebSocket) vérifiée par PLAN_TRANSPORT.
 */

function fabriquerPairFactice(options: { etatIceInitial?: string } = {}) {
  const senders: Array<{ kind: string; setParameters?: (p: unknown) => Promise<void> }> = [];
  const pair: PairFactice = {
    localDescription: null,
    iceConnectionState: options.etatIceInitial ?? "new",
    connectionState: "new",
    addTrack(track) {
      const sender: { kind: string; setParameters?: (p: unknown) => Promise<void> } = { kind: track.kind };
      senders.push(sender);
      return sender;
    },
    async setLocalDescription(d) { pair.localDescription = d as RTCSessionDescription; },
    async setRemoteDescription() { /* accepté (factice) */ },
    async createOffer() { return { type: "offer", sdp: "v=0 SDP-FACTICE" }; },
    async createAnswer() { return { type: "answer", sdp: "v=0 SDP-FACTICE" }; },
    async addIceCandidate() { /* accepté */ },
    close() { pair.connectionState = "closed"; },
  };
  return { pair, senders };
}

describe("signalisation (séparation médias ≠ événements, mission Phase 2)", () => {
  it("PLAN_TRANSPORT : médias WebRTC direct, événements WebSocket", () => {
    expect(PLAN_TRANSPORT.medias).toBe("webrtc-direct");
    expect(PLAN_TRANSPORT.evenements).toBe("websocket-gateway");
    expect(PLAN_TRANSPORT.sfuSeuilParticipants).toBe(4);
  });

  it("messages valides acceptés, staleness et champs vides refusés", () => {
    const ok = creerMessageSignal("rtc.offre", "s1", "p1", "v=0", Date.now());
    expect(messageSignalAcceptable(ok)).toBe(true);
    const vieux = creerMessageSignal("rtc.offre", "s1", "p1", "v=0", Date.now() - 60_000);
    expect(messageSignalAcceptable(vieux)).toBe(false); // anti-rejeu fenêtre 30 s
    const vide = creerMessageSignal("rtc.offre", "s1", "p1", "", Date.now());
    expect(messageSignalAcceptable(vide)).toBe(false);
  });

  it("SFU : bascule seulement au-delà du seuil, direct en dessous (honnête)", () => {
    expect(choisirModeDiffusion(3).mode).toBe("direct");
    const sfu = choisirModeDiffusion(4);
    expect(sfu.mode).toBe("sfu");
    expect(sfu.raison).toContain("GEN3IA_LIVE_GATEWAY_URL"); // pas de promesse SFU fantôme
  });
});

describe("WebRTC manager avec peer factice (fabrique injectée)", () => {
  it("ouverture : offre créée et publiée, candidat ICE relayé, débit limité si supporté", async () => {
    const signals: string[] = [];
    const { pair, senders } = fabriquerPairFactice();
    senders[0].setParameters = async (p) => { void p; }; // navigateur supportant setParameters
    const res = await ouvrirPair({
      sessionId: "s1",
      config: { iceServers: [{ urls: "stun:stun.example.org" }] },
      fabriquerPair: () => pair,
      envoyerSignal: (m) => { signals.push(`${m.type}:${m.destinataire}`); },
      pistes: [{ kind: "audio", maxBitrateBps: 32_000 }, { kind: "video", maxBitrateBps: 1_500_000 }],
    });
    expect(res.etat.statut).toBe("connexion");
    expect(signals).toEqual(["rtc.offre:partenaire"]);
    expect(pair.localDescription?.type).toBe("offer");
    // candidat ICE local → signalisation (séparation médias/événements)
    pair.onicecandidate?.({ candidate: { candidate: "candidate-1" } });
    expect(signals).toContain("rtc.candidat:partenaire");
    // débit : setParameters appelé sans lever (limite acceptée)
    expect(senders.length).toBe(2);
  });

  it("réponse SDP entrante acceptée pour un pair ouvert ; refusée sans pair", async () => {
    const { pair } = fabriquerPairFactice();
    await ouvrirPair({ sessionId: "s2", config: { iceServers: [] }, fabriquerPair: () => pair, envoyerSignal: () => undefined });
    const res = await traiterSignal({ sessionId: "s2", message: creerMessageSignal("rtc.reponse", "s2", "s2", JSON.stringify({ type: "answer", sdp: "v=0" })) });
    expect(res.accepte).toBe(true);
    const horsSession = await traiterSignal({ sessionId: "inconnue", message: creerMessageSignal("rtc.reponse", "inconnue", "x", "{}") });
    expect(horsSession.accepte).toBe(false);
    expect(horsSession.raison).toContain("aucun pair ouvert");
  });

  it("perte de connexion → restart ICE borné, puis échec EXPLICITE (jamais de faux succès)", async () => {
    const signals: string[] = [];
    const { pair } = fabriquerPairFactice({ etatIceInitial: "connected" });
    await ouvrirPair({
      sessionId: "s3",
      config: { iceServers: [], maxReconnexions: 2 },
      fabriquerPair: () => pair,
      envoyerSignal: (m) => { signals.push(m.type); },
    });
    pair.iceConnectionState = "failed";
    pair.oniceconnectionstatechange?.();
    expect(signals).toContain("rtc.restart");
    const etat = (await import("./webrtc-manager")).etatPair("s3");
    expect(etat?.reconnexions).toBe(1);
    // deux autres échecs → dépassement du max → échec explicite
    pair.oniceconnectionstatechange?.();
    pair.iceConnectionState = "failed";
    pair.oniceconnectionstatechange?.();
    const final = (await import("./webrtc-manager")).etatPair("s3");
    expect(final?.statut).toBe("echec");
    expect(final?.dernierErreur).toContain("échec explicite");
  });

  it("fermeture propre : état fermé, registre purgé", async () => {
    const { pair } = fabriquerPairFactice({ etatIceInitial: "connected" });
    await ouvrirPair({ sessionId: "s4", config: { iceServers: [] }, fabriquerPair: () => pair, envoyerSignal: () => undefined });
    const ferme = fermerPair("s4");
    expect(ferme?.statut).toBe("ferme");
    expect(fermerPair("s4")).toBeNull(); // déjà purgé
  });
});
