"use client";

/**
 * Nœud d'essaim P2P — chaque navigateur devient un nœud d'oscillateurs
 * couplés relié aux autres en WebRTC direct. Le protocole, en 4 temps :
 *
 *  1. "bonjour"  — annonce de présence (diffusion) ; réponse "ici".
 *  2. L'offre    — le nœud dont l'identifiant est lexicalement inférieur
 *                  crée l'offre (règle déterministe : jamais double).
 *  3. "reponse"  — l'invité répond, ICE s'échange ("ice")…
 *  4. Canal "ondes" ouvert — les micro-paquets [phase, fréquence,
 *     amplitude] circulent EN DIRECT entre navigateurs. Le serveur
 *     n'est plus sollicité.
 *
 * Les paquets sont dédupliqués (`pid`), bornés par TTL (chaque nœud
 * retransmet avec ttl−1 à SES autres pairs — propagation en cascade
 * sans boucle) et atténués à l'injection (perte d'énergie de saut).
 */

import type { PaquetOnde } from "./types";
import { nouvelId, type TransportSignalisation } from "./signalisation";

export interface OptionsNoeud {
  /** Identifiant du nœud (généré si absent). */
  id?: string;
  /** Transport de signalisation (double : locale + HTTP). */
  transport: TransportSignalisation;
  /** Reçoit un paquet d'ondes à injecter dans le champ local. */
  surPaquet?: (paquet: PaquetOnde) => void;
  /** Nombre de pairs ouverts a changé. */
  surPairs?: (nombre: number) => void;
  /** Message de statut pour la journalisation UI. */
  surStatut?: (message: string) => void;
  /** TTL initial des paquets émis (1 = pas de retransmission). */
  ttlInitial?: number;
}

type EtatPair = "negociation" | "ouvert" | "ferme";

interface LienPair {
  id: string;
  etat: EtatPair;
  connexion: RTCPeerConnection | null;
  canal: RTCDataChannel | null;
}

const CONFIG_RTC: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const TTL_DEFAUT = 2;

export class NoeudEssaim {
  readonly id: string;
  private readonly transport: TransportSignalisation;
  private readonly surPaquet: ((paquet: PaquetOnde) => void) | undefined;
  private readonly surPairs: ((nombre: number) => void) | undefined;
  private readonly surStatut: ((message: string) => void) | undefined;
  private readonly ttlInitial: number;

  private liens = new Map<string, LienPair>();
  private vus = new Set<string>();
  private actif = false;
  private stats = { paquetsEnvoyes: 0, paquetsRecus: 0, octetsEnvoyes: 0, octetsRecus: 0 };

  constructor(options: OptionsNoeud) {
    this.id = options.id ?? nouvelId();
    this.transport = options.transport;
    this.surPaquet = options.surPaquet;
    this.surPairs = options.surPairs;
    this.surStatut = options.surStatut;
    this.ttlInitial = options.ttlInitial ?? TTL_DEFAUT;
  }

  /** Nombre de pairs dont le canal de données est ouvert. */
  get nbPairsOuverts(): number {
    let n = 0;
    for (const lien of this.liens.values()) if (lien.etat === "ouvert") n++;
    return n;
  }

  /** Identifiants des pairs connus (négociation incluse). */
  get idsPairs(): string[] {
    return [...this.liens.keys()];
  }

  get statistiques(): { pairs: number; paquetsEnvoyes: number; paquetsRecus: number; octetsEnvoyes: number; octetsRecus: number } {
    return { pairs: this.nbPairsOuverts, ...this.stats };
  }

  /** Démarre le nœud : écoute la signalisation, annonce sa présence. */
  demarrer(): void {
    if (this.actif) return;
    this.actif = true;
    this.transport.onMessage((message) => this.traiterSignal(message));
    this.transport.envoyer({ de: this.id, type: "bonjour" });
    this.surStatut?.("Présence annoncée à l'essaim — en attente de pairs.");
  }

  /**
   * Traite un message de signalisation. WebRTC peut être absent
   * (navigateurs anciens) : la signalisation répond quand même, seul le
   * canal de données est dégradé — le nœud reste visible mais muet.
   */
  private async traiterSignal(message: { de: string; vers?: string; type: string; charge?: unknown }): Promise<void> {
    if (!this.actif || message.de === this.id) return;
    if (message.vers && message.vers !== this.id) return;

    switch (message.type) {
      case "bonjour": {
        // On répond pour se faire connaître, et le "plus petit" prend
        // l'initiative de l'offre (règle déterministe anti-collision).
        this.transport.envoyer({ de: this.id, vers: message.de, type: "ici" });
        if (typeof RTCPeerConnection !== "undefined" && this.id < message.de) {
          await this.etablir(message.de);
        }
        break;
      }
      case "ici": {
        if (typeof RTCPeerConnection !== "undefined" && this.id < message.de) {
          await this.etablir(message.de);
        }
        break;
      }
      case "offre": {
        if (typeof RTCPeerConnection === "undefined") return;
        const charge = message.charge as RTCSessionDescriptionInit | undefined;
        if (!charge) return;
        try {
          const lien = this.lienEntrant(message.de);
          await lien.connexion!.setRemoteDescription(new RTCSessionDescription(charge));
          const reponse = await lien.connexion!.createAnswer();
          await lien.connexion!.setLocalDescription(reponse);
          this.transport.envoyer({
            de: this.id,
            vers: message.de,
            type: "reponse",
            charge: { type: reponse.type, sdp: reponse.sdp },
          });
          this.surStatut?.(`Réponse envoyée à ${message.de.slice(0, 8)}…`);
        } catch {
          this.fermerLien(message.de);
        }
        break;
      }
      case "reponse": {
        const charge = message.charge as RTCSessionDescriptionInit | undefined;
        const lien = this.liens.get(message.de);
        if (!charge || !lien?.connexion) return;
        try {
          await lien.connexion.setRemoteDescription(new RTCSessionDescription(charge));
        } catch {
          this.fermerLien(message.de);
        }
        break;
      }
      case "ice": {
        const candidat = message.charge as RTCIceCandidateInit | undefined;
        const lien = this.liens.get(message.de);
        if (!candidat || !lien?.connexion) return;
        try {
          await lien.connexion.addIceCandidate(new RTCIceCandidate(candidat));
        } catch {
          // Candidat tardif/orphelin : la négociation ICE s'auto-rattrape.
        }
        break;
      }
      case "au-revoir": {
        this.fermerLien(message.de);
        break;
      }
    }
  }

  /**
   * Crée (ou récupère) la connexion ENTRANTE d'un pair qui offre : le
   * canal de données arrivera via l'événement `ondatachannel` — c'est
   * l'émetteur qui le crée.
   */
  private lienEntrant(id: string): LienPair {
    const existant = this.liens.get(id);
    if (existant?.connexion) return existant;
    const connexion = new RTCPeerConnection(CONFIG_RTC);
    const lien: LienPair = { id, etat: "negociation", connexion, canal: null };
    this.liens.set(id, lien);
    connexion.onicecandidate = (evenement) => {
      if (evenement.candidate) {
        this.transport.envoyer({
          de: this.id,
          vers: id,
          type: "ice",
          charge: evenement.candidate.toJSON(),
        });
      }
    };
    connexion.ondatachannel = (evenement) => {
      this.preparerCanal(lien, evenement.channel);
    };
    return lien;
  }

  /** Crée la connexion sortante (offre) vers un pair. */
  private async etablir(cible: string): Promise<void> {
    if (this.liens.has(cible)) return;
    const connexion = new RTCPeerConnection(CONFIG_RTC);
    const lien: LienPair = { id: cible, etat: "negociation", connexion, canal: null };
    this.liens.set(cible, lien);

    connexion.onicecandidate = (evenement) => {
      if (evenement.candidate) {
        this.transport.envoyer({
          de: this.id,
          vers: cible,
          type: "ice",
          charge: evenement.candidate.toJSON(),
        });
      }
    };

    const canal = connexion.createDataChannel("ondes", { ordered: false, maxRetransmits: 0 });
    this.preparerCanal(lien, canal);

    try {
      const offre = await connexion.createOffer();
      await connexion.setLocalDescription(offre);
      this.transport.envoyer({
        de: this.id,
        vers: cible,
        type: "offre",
        charge: { type: offre.type, sdp: offre.sdp },
      });
      this.surStatut?.(`Offre envoyée à ${cible.slice(0, 8)}…`);
    } catch {
      this.fermerLien(cible);
    }
  }

  /** Canal de données entrant (côté invité). */
  private preparerCanal(lien: LienPair, canal: RTCDataChannel): void {
    lien.canal = canal;
    canal.onopen = () => {
      lien.etat = "ouvert";
      this.surPairs?.(this.nbPairsOuverts);
      this.surStatut?.(`Canal d'ondes ouvert avec ${lien.id.slice(0, 8)}… — inférence distribuée active.`);
    };
    canal.onclose = () => {
      lien.etat = "ferme";
      this.surPairs?.(this.nbPairsOuverts);
    };
    canal.onmessage = (evenement) => {
      try {
        const paquet = JSON.parse(String(evenement.data)) as PaquetOnde;
        this.recevoirPaquet(paquet);
      } catch {
        // Paquet corrompu : perdu pour tout le monde en UDP-like, tant pis.
      }
    };
  }

  /** Réception : déduplication → injection locale → retransmission. */
  private recevoirPaquet(paquet: PaquetOnde): void {
    if (!paquet || paquet.v !== 1 || !paquet.pid) return;
    if (this.vus.has(paquet.pid)) return;
    this.vus.add(paquet.pid);
    if (this.vus.size > 512) this.vus = new Set([...this.vus].slice(-256));

    this.stats.paquetsRecus++;
    this.stats.octetsRecus += JSON.stringify(paquet).length;
    this.surPaquet?.(paquet);

    // Cascade : le paquet vit encore → atténuation et retransmission
    // à tous les AUTRES pairs ouverts (jamais vers l'émetteur).
    if (paquet.ttl > 1 && this.nbPairsOuverts > 1) {
      const relai: PaquetOnde = { ...paquet, ttl: paquet.ttl - 1 };
      this.diffuser(relai, { sauf: paquet.id });
    }
  }

  /** Émet un paquet d'ondes vers tous les pairs ouverts. */
  envoyerPaquet(paquet: Omit<PaquetOnde, "v" | "id" | "pid" | "ttl">): void {
    if (!this.actif || this.nbPairsOuverts === 0) return;
    const complet: PaquetOnde = {
      v: 1,
      id: this.id,
      pid: nouvelId(),
      ttl: this.ttlInitial,
      ...paquet,
    };
    this.diffuser(complet);
  }

  private diffuser(paquet: PaquetOnde, options?: { sauf?: string }): void {
    const donnees = JSON.stringify(paquet);
    for (const lien of this.liens.values()) {
      if (options?.sauf && lien.id === options.sauf) continue;
      if (lien.etat === "ouvert" && lien.canal?.readyState === "open") {
        try {
          lien.canal.send(donnees);
          this.stats.paquetsEnvoyes++;
          this.stats.octetsEnvoyes += donnees.length;
        } catch {
          // Canal refermé entre-temps : ignoré, l'ICE rétablira.
        }
      }
    }
  }

  private fermerLien(id: string): void {
    const lien = this.liens.get(id);
    if (!lien) return;
    try {
      lien.canal?.close();
      lien.connexion?.close();
    } catch {
      // Déjà fermé.
    }
    this.liens.delete(id);
    this.surPairs?.(this.nbPairsOuverts);
  }

  /** Quitte l'essaim proprement (annoncé aux pairs). */
  arreter(): void {
    if (!this.actif) return;
    this.transport.envoyer({ de: this.id, type: "au-revoir" });
    for (const id of [...this.liens.keys()]) this.fermerLien(id);
    this.actif = false;
  }
}
