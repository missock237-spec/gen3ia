"use client";

/**
 * Nœud d'agents — le canal P2P des agents décentralisés.
 *
 * Distinct du nœud d'ondes W-DNN (lib/ondes/essaim.ts) parVolonté de
 * séparation des préoccupations : le champ d'ondes transporte des
 * micro-paquets [phase, fréquence, amplitude] en UDP-like (perte
 * acceptable), tandis que le canal « agents » transporte des messages
 * riches (tâches, résultats, fragments, compétences) en mode FIABLE et
 * ORDONNÉ — une tâche perdue est une tâche orpheline.
 *
 * La signalisation est partagée avec l'essaim W-DNN (même API
 * TransportSignalisation, salles distinctes `agents-*`) : le serveur ne
 * voit que des enveloppes courtes de négociation, jamais le contenu.
 */

import type { MessageAgent, TypeMessageAgent } from "./types";
import { nouvelId } from "@/lib/ondes/signalisation";

export interface OptionsNoeudAgents {
  id?: string;
  /** Salle de signalisation (préfixée `agents-` automatiquement). */
  salle: string;
  transport: TransportAgents;
  surMessage: (message: MessageAgent) => void;
  surPairs?: (nombre: number) => void;
  surStatut?: (message: string) => void;
  ttlInitial?: number;
}

/**
 * Réutilise le contrat de transport de la signalisation W-DNN (locale
 * BroadcastChannel + HTTP polling) — même forme, aucune dépendance
 * circulaire : le transport est construit par l'appelant
 * (SignalisationDouble de lib/ondes) et injecté ici.
 */
export interface TransportAgents {
  readonly nom: string;
  envoyer(message: { de: string; vers?: string; type: string; charge?: unknown }): void;
  onMessage(retour: (message: { de: string; vers?: string; type: string; charge?: unknown }) => void): void;
  fermer(): void;
}

type EtatLien = "negociation" | "ouvert" | "ferme";

interface LienAgents {
  id: string;
  etat: EtatLien;
  connexion: RTCPeerConnection | null;
  canal: RTCDataChannel | null;
}

const CONFIG_RTC: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

/** Plafond de déduplication (fenêtre glissante comme le nœud W-DNN). */
const PLAFOND_VUS = 1024;

export class NoeudAgents {
  readonly id: string;
  private readonly transport: TransportAgents;
  private readonly surMessage: (message: MessageAgent) => void;
  private readonly surPairs: ((nombre: number) => void) | undefined;
  private readonly surStatut: ((message: string) => void) | undefined;
  private readonly ttlInitial: number;

  private liens = new Map<string, LienAgents>();
  private vus = new Set<string>();
  private actif = false;
  private stats = { messages: 0, octets: 0 };

  constructor(options: OptionsNoeudAgents) {
    this.id = options.id ?? `a-${nouvelId().slice(0, 8)}`;
    this.transport = options.transport;
    this.surMessage = options.surMessage;
    this.surPairs = options.surPairs;
    this.surStatut = options.surStatut;
    this.ttlInitial = options.ttlInitial ?? 2;
  }

  get nbPairsOuverts(): number {
    let n = 0;
    for (const lien of this.liens.values()) if (lien.etat === "ouvert") n++;
    return n;
  }

  get statistiques(): { pairs: number; messages: number; octets: number } {
    return { pairs: this.nbPairsOuverts, ...this.stats };
  }

  /** Identifiants des pairs connus. */
  get idsPairs(): string[] {
    return [...this.liens.keys()];
  }

  demarrer(): void {
    if (this.actif) return;
    this.actif = true;
    this.transport.onMessage((message) => void this.traiterSignal(message));
    this.transport.envoyer({ de: this.id, type: "bonjour" });
    this.surStatut?.("Nœud d'agents annoncé — spécialités locales en ligne.");
  }

  /** Publie une annonce de présence enrichie (spécialités + capacité). */
  annoncer(charge: { nom: string; specialites: string[]; capacite: number }): void {
    this.emettre({ type: "annonce", charge });
  }

  private async traiterSignal(message: {
    de: string;
    vers?: string;
    type: string;
    charge?: unknown;
  }): Promise<void> {
    if (!this.actif || message.de === this.id) return;
    if (message.vers && message.vers !== this.id) return;

    switch (message.type) {
      case "bonjour": {
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
        const offre = message.charge as RTCSessionDescriptionInit | undefined;
        if (!offre) return;
        try {
          const lien = this.lienEntrant(message.de);
          await lien.connexion!.setRemoteDescription(new RTCSessionDescription(offre));
          const reponse = await lien.connexion!.createAnswer();
          await lien.connexion!.setLocalDescription(reponse);
          this.transport.envoyer({
            de: this.id,
            vers: message.de,
            type: "reponse",
            charge: { type: reponse.type, sdp: reponse.sdp },
          });
          this.surStatut?.(`Canal d'agents négocié avec ${message.de.slice(0, 8)}…`);
        } catch {
          this.fermerLien(message.de);
        }
        break;
      }
      case "reponse": {
        const reponse = message.charge as RTCSessionDescriptionInit | undefined;
        const lien = this.liens.get(message.de);
        if (!reponse || !lien?.connexion) return;
        try {
          await lien.connexion.setRemoteDescription(new RTCSessionDescription(reponse));
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
          // Candidat tardif : ICE se rattrape seul.
        }
        break;
      }
      case "au-revoir": {
        this.fermerLien(message.de);
        break;
      }
    }
  }

  private lienEntrant(id: string): LienAgents {
    const existant = this.liens.get(id);
    if (existant?.connexion) return existant;
    const connexion = new RTCPeerConnection(CONFIG_RTC);
    const lien: LienAgents = { id, etat: "negociation", connexion, canal: null };
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
    connexion.ondatachannel = (evenement) => this.preparerCanal(lien, evenement.channel);
    return lien;
  }

  private async etablir(cible: string): Promise<void> {
    if (this.liens.has(cible)) return;
    const connexion = new RTCPeerConnection(CONFIG_RTC);
    const lien: LienAgents = { id: cible, etat: "negociation", connexion, canal: null };
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
    // Fiable et ordonné : une tâche ou un fragment perdu serait une
    // tâche orpheline — le canal d'agents refuse la perte.
    const canal = connexion.createDataChannel("agents", { ordered: true });
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
    } catch {
      this.fermerLien(cible);
    }
  }

  private preparerCanal(lien: LienAgents, canal: RTCDataChannel): void {
    lien.canal = canal;
    canal.onopen = () => {
      lien.etat = "ouvert";
      this.surPairs?.(this.nbPairsOuverts);
      this.surStatut?.(`Canal d'agents ouvert avec ${lien.id.slice(0, 8)}…`);
    };
    canal.onclose = () => {
      lien.etat = "ferme";
      this.surPairs?.(this.nbPairsOuverts);
    };
    canal.onmessage = (evenement) => {
      try {
        const message = JSON.parse(String(evenement.data)) as MessageAgent;
        this.recevoir(message);
      } catch {
        // Message illisible : ignoré (le canal fiable ne devrait pas en produire).
      }
    };
  }

  private recevoir(message: MessageAgent): void {
    if (!message || message.v !== 1 || !message.mid || message.de === this.id) return;
    if (message.vers && message.vers !== this.id) {
      // Message visé vers un autre nœud : relais cascade seulement.
      this.relais(message);
      return;
    }
    if (this.vus.has(message.mid)) return;
    this.vus.add(message.mid);
    if (this.vus.size > PLAFOND_VUS) this.vus = new Set([...this.vus].slice(-512));

    this.stats.messages++;
    this.stats.octets += JSON.stringify(message).length;
    this.surMessage(message);
    this.relais(message);
  }

  /** Cascade TTL vers les autres pairs ouverts (jamais vers l'émetteur). */
  private relais(message: MessageAgent): void {
    if (message.ttl <= 1) return;
    const derive: MessageAgent = { ...message, ttl: message.ttl - 1 };
    this.diffuser(derive, { sauf: message.de });
  }

  /** Émet un message d'agent vers l'essaim (ou un nœud visé). */
  emettre(message: {
    type: TypeMessageAgent;
    charge: unknown;
    vers?: string;
    ttl?: number;
  }): void {
    if (!this.actif) return;
    const complet: MessageAgent = {
      v: 1,
      mid: nouvelId(),
      de: this.id,
      vers: message.vers,
      type: message.type,
      charge: message.charge,
      ttl: message.ttl ?? this.ttlInitial,
      ts: Date.now(),
    };
    this.diffuser(complet);
  }

  private diffuser(message: MessageAgent, options?: { sauf?: string }): void {
    const donnees = JSON.stringify(message);
    for (const lien of this.liens.values()) {
      if (options?.sauf && lien.id === options.sauf) continue;
      if (lien.etat === "ouvert" && lien.canal?.readyState === "open") {
        try {
          lien.canal.send(donnees);
          this.stats.messages++;
          this.stats.octets += donnees.length;
        } catch {
          // Canal refermé entre-temps : la résilience s'en charge.
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

  arreter(): void {
    if (!this.actif) return;
    this.transport.envoyer({ de: this.id, type: "au-revoir" });
    for (const id of [...this.liens.keys()]) this.fermerLien(id);
    this.actif = false;
  }
}
