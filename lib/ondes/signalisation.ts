"use client";

/**
 * Transports de signalisation du client — le canal TEMPORAIRE par lequel
 * les navigateurs se trouvent et négocient leur connexion directe. Deux
 * transports coexistent et se complètent :
 *
 *  · SignalisationLocale (BroadcastChannel) : instantanée entre les
 *    onglets d'un même navigateur — démontre l'essaim sans serveur ;
 *  · SignalisationHttp (polling /api/ondes/signaling) : traverse les
 *    navigateurs et les réseaux (le VPS ne fait QUE relayer ces
 *    enveloppes courtes, jamais des données d'inférence).
 *
 * `SignalisationDouble` publie sur les deux et déduplique par `mid` :
 * un pair vu par les deux canaux ne reçoit qu'une copie de chaque offre.
 */

import type { MessageSignal } from "./registre-signalisation";

export interface TransportSignalisation {
  readonly nom: string;
  envoyer(message: Omit<MessageSignal, "ts" | "mid"> & { mid?: string }): void;
  onMessage(retour: (message: MessageSignal) => void): void;
  fermer(): void;
}

/** Identifiant de message unique (crypto si disponible). */
export function nouvelId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Environnement sans crypto.randomUUID — repli ci-dessous.
  }
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Identifiant de nœud d'essaim unique et lisible. */
export function nouvelIdNoeud(): string {
  return `n-${nouvelId().slice(0, 8)}`;
}

/** Signalisation locale entre onglets (BroadcastChannel, zéro serveur). */
export class SignalisationLocale implements TransportSignalisation {
  readonly nom = "locale";
  private canal: BroadcastChannel | null = null;
  private retour: ((message: MessageSignal) => void) | null = null;

  constructor(private readonly salle: string) {
    try {
      this.canal = new BroadcastChannel(`gen3ia-ondes:${salle}`);
      this.canal.onmessage = (evenement: MessageEvent) => {
        const donnees = evenement.data as MessageSignal | undefined;
        if (donnees && typeof donnees.de === "string" && this.retour) {
          this.retour(donnees);
        }
      };
    } catch {
      this.canal = null;
    }
  }

  get actif(): boolean {
    return this.canal !== null;
  }

  envoyer(message: Omit<MessageSignal, "ts" | "mid"> & { mid?: string }): void {
    this.canal?.postMessage({ ...message, ts: Date.now(), mid: message.mid ?? nouvelId() } satisfies MessageSignal);
  }

  onMessage(retour: (message: MessageSignal) => void): void {
    this.retour = retour;
  }

  fermer(): void {
    this.canal?.close();
    this.canal = null;
  }
}

/** Signalisation HTTP (polling léger de l'API de signalisation). */
export class SignalisationHttp implements TransportSignalisation {
  readonly nom = "http";
  private retour: ((message: MessageSignal) => void) | null = null;
  private controleur: AbortController | null = null;
  private arrete = false;
  private vus = new Set<string>();
  private periodiciteMs: number;

  constructor(
    private readonly salle: string,
    private readonly pair: string,
    periodiciteMs = 900,
    /** Ticket d'admission signé (salles privées mesh uniquement). */
    private readonly ticket?: string,
  ) {
    this.periodiciteMs = periodiciteMs;
  }

  envoyer(message: Omit<MessageSignal, "ts" | "mid"> & { mid?: string }): void {
    const enveloppe: MessageSignal = { ...message, ts: Date.now(), mid: message.mid ?? nouvelId() };
    fetch("/api/ondes/signaling", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ salle: this.salle, ticket: this.ticket, ...enveloppe }),
      cache: "no-store",
    }).catch(() => {
      // La signalisation est best-effort : une perte se rattrape à la
      // prochaine négociation ICE, jamais une donnée d'inférence.
    });
  }

  onMessage(retour: (message: MessageSignal) => void): void {
    this.retour = retour;
    if (!this.arrete) this.boucler();
  }

  private boucleEnCours = false;

  private async boucler(): Promise<void> {
    if (this.boucleEnCours || this.arrete) return;
    this.boucleEnCours = true;
    while (!this.arrete) {
      try {
        this.controleur = new AbortController();
        const reponse = await fetch(
          `/api/ondes/signaling?salle=${encodeURIComponent(this.salle)}&pair=${encodeURIComponent(this.pair)}${this.ticket ? `&ticket=${encodeURIComponent(this.ticket)}` : ""}`,
          { signal: this.controleur.signal, cache: "no-store" },
        );
        if (reponse.ok) {
          const corps = (await reponse.json()) as { messages?: MessageSignal[] };
          for (const message of corps.messages ?? []) {
            if (this.vus.has(message.mid)) continue;
            this.vus.add(message.mid);
            if (this.vus.size > 512) {
              // Plafond mémoire : on repart d'une fenêtre fraîche.
              this.vus = new Set([...this.vus].slice(-256));
            }
            this.retour?.(message);
          }
        }
      } catch {
        // Réseau indisponible : la boucle continue au prochain tour.
      }
      await new Promise((resoudre) => setTimeout(resoudre, this.periodiciteMs));
    }
    this.boucleEnCours = false;
  }

  fermer(): void {
    this.arrete = true;
    this.controleur?.abort();
    this.envoyer({ de: this.pair, type: "au-revoir" });
  }
}

/**
 * Signalisation double : locale (onglets) + HTTP (réseau), dédupliquée
 * par identifiant de message. Les transports sont créés paresseusement :
 * le BroadcastChannel peut être absent (SSR, navigateur ancien).
 */
export class SignalisationDouble implements TransportSignalisation {
  readonly nom = "double";
  private locale: SignalisationLocale | null = null;
  private http: SignalisationHttp;
  private retour: ((message: MessageSignal) => void) | null = null;
  private vus = new Set<string>();

  constructor(salle: string, pair: string, ticket?: string) {
    try {
      this.locale = new SignalisationLocale(salle);
    } catch {
      this.locale = null;
    }
    this.http = new SignalisationHttp(salle, pair, 900, ticket);
  }

  envoyer(message: Omit<MessageSignal, "ts" | "mid"> & { mid?: string }): void {
    const mid = message.mid ?? nouvelId();
    this.locale?.envoyer({ ...message, mid });
    this.http.envoyer({ ...message, mid });
  }

  onMessage(retour: (message: MessageSignal) => void): void {
    this.retour = retour;
    const canal = (message: MessageSignal) => {
      if (this.vus.has(message.mid)) return;
      this.vus.add(message.mid);
      if (this.vus.size > 512) this.vus = new Set([...this.vus].slice(-256));
      retour(message);
    };
    this.locale?.onMessage(canal);
    this.http.onMessage(canal);
  }

  fermer(): void {
    this.locale?.fermer();
    this.http.fermer();
  }
}
