/**
 * L'Onde de Requête Sémantique — RAG décentralisé, volet réseau.
 *
 * Quand un agent (ou l'utilisateur) a besoin d'une information, la
 * question NE SORT JAMAIS de la machine : seule sa SIGNATURE creuse
 * (dimensions hachées + poids du vecteur) est diffusée en onde P2P.
 * Chaque nœud qui la reçoit la compare à son INDEX LOCAL, en silence :
 * il répond uniquement si un fragment local dépasse le seuil — et ne
 * renvoie alors que l'EXTRAIT pertinent, jamais son document, jamais
 * son index. On obtient un moteur de recherche documentaire global,
 * instantané et confidentiel, sans serveur.
 *
 * La réponse est visée (`vers: emetteur`) : le demandeur reçoit les
 * fragments, les déduplique par empreinte et les ordonne par score.
 */

import type { NoeudAgents } from "../noeud-agents";
import type { ChargeFragment, ChargeRequete, MessageAgent } from "../types";
import { empreinteFnv } from "./coffre-local";
import {
  IndexSemantiqueLocal,
  similariteCosinus,
} from "./index-semantique";

/** Un fragment de réponse reçu de l'essaim. */
export interface FragmentRecu {
  extrait: string;
  empreinte: string;
  score: number;
  etiquette?: string;
  /** Nœud répondant (l'onde de retour exige une adresse de retour). */
  de: string;
}

/** Résultat d'une recherche décentralisée. */
export interface ResultatRecherche {
  requeteId: string;
  question: string;
  fragments: FragmentRecu[];
  /** Nœuds qui ont répondu (sans autre information sur eux). */
  respondants: number;
  dureeMs: number;
  /** Diagnostic honnête : aucun fragment au-dessus du seuil ? */
  vide: boolean;
}

export interface OptionsOndeSemantique {
  noeud: NoeudAgents;
  /** L'index LOCAL de ce nœud (ce que ce nœud peut révéler en extraits). */
  index: IndexSemantiqueLocal;
  /** Délai de collecte des fragments (ms, défaut 1800). */
  delaiCollecte?: number;
  /** Nombre maximal de fragments renvoyés par répondant (défaut 2). */
  maxFragmentsParRepondant?: number;
}

interface RequeteEnCours {
  question: string;
  fragments: FragmentRecu[];
  repondants: Set<string>;
  debut: number;
  resoudre: (r: ResultatRecherche) => void;
  minuteur: ReturnType<typeof setTimeout>;
}

export class OndeSemantique {
  private readonly noeud: NoeudAgents;
  private readonly index: IndexSemantiqueLocal;
  private readonly delaiCollecte: number;
  private readonly maxParRepondant: number;
  private enCours = new Map<string, RequeteEnCours>();
  private compteur = 0;

  constructor(options: OptionsOndeSemantique) {
    this.noeud = options.noeud;
    this.index = options.index;
    this.delaiCollecte = options.delaiCollecte ?? 1800;
    this.maxParRepondant = options.maxFragmentsParRepondant ?? 2;
  }

  /**
   * Pose une question à l'essaim : la signature part en onde, les
   * fragments reviennent visés, la promesse se résout à la fin de la
   * fenêtre de collecte (jamais bloquée plus que nécessaire).
   */
  poserQuestion(question: string, seuil = 0.12): Promise<ResultatRecherche> {
    const propre = question.trim();
    if (!propre) {
      return Promise.resolve({
        requeteId: "vide",
        question: "",
        fragments: [],
        respondants: 0,
        dureeMs: 0,
        vide: true,
      });
    }
    const requeteId = `q-${Date.now().toString(36)}-${++this.compteur}`;
    const signature = this.index.signatureRequete(propre);
    if (signature.dims.length === 0) {
      return Promise.resolve({
        requeteId,
        question: propre,
        fragments: [],
        respondants: 0,
        dureeMs: 0,
        vide: true,
      });
    }

    return new Promise<ResultatRecherche>((resoudre) => {
      const debut = Date.now();
      const enCours: RequeteEnCours = {
        question: propre,
        fragments: [],
        repondants: new Set(),
        debut,
        resoudre,
        minuteur: setTimeout(() => this.clore(requeteId), this.delaiCollecte),
      };
      this.enCours.set(requeteId, enCours);

      const charge: ChargeRequete = {
        requeteId,
        dims: signature.dims,
        poids: signature.poids,
        seuil,
        emetteur: this.noeud.id,
      };
      this.noeud.emettre({ type: "requete", charge });
    });
  }

  /**
   * Traite un message reçu du nœud P2P — les types "requete" (on
   * répond depuis NOTRE index, anonymement) et "fragment" (on collecte
   * pour nos propres requêtes).
   */
  traiterMessage(message: MessageAgent): void {
    if (message.de === this.noeud.id) return;
    if (message.type === "requete") this.repondre(message);
    else if (message.type === "fragment") this.collecter(message);
  }

  /** Répond depuis l'index local — ou se tait. Anonymat : on ne révèle rien d'autre. */
  private repondre(message: MessageAgent): void {
    const charge = message.charge as ChargeRequete | undefined;
    if (!charge?.requeteId || !Array.isArray(charge.dims)) return;

    // Reconstitue le vecteur de requête à partir de la signature reçue.
    const vecteur: Record<number, number> = {};
    charge.dims.forEach((d, i) => {
      vecteur[d] = charge.poids[i] ?? 1 / (i + 1);
    });

    let envoyes = 0;
    for (const fragment of this.index.tous()) {
      const score = similariteCosinus(vecteur, fragment.vecteur);
      if (score < (charge.seuil ?? 0.12)) continue;
      const extraitCharge: ChargeFragment = {
        requeteId: charge.requeteId,
        extrait: fragment.texte.slice(0, 400),
        empreinte: fragment.empreinte || empreinteFnv(fragment.texte),
        score: Math.round(score * 1000) / 1000,
        etiquette: fragment.etiquette,
      };
      this.noeud.emettre({
        type: "fragment",
        vers: charge.emetteur,
        charge: extraitCharge,
      });
      if (++envoyes >= this.maxParRepondant) break;
    }
    // Rien au-dessus du seuil : SILENCE — l'existence même d'un document
    // proche n'est jamais révélée. C'est la promesse zéro-connaissance.
  }

  /** Collecte un fragment de réponse pour une de nos requêtes. */
  private collecter(message: MessageAgent): void {
    if (message.vers && message.vers !== this.noeud.id) return;
    const charge = message.charge as ChargeFragment | undefined;
    if (!charge?.requeteId) return;
    const enCours = this.enCours.get(charge.requeteId);
    if (!enCours) return;
    enCours.fragments.push({
      extrait: String(charge.extrait ?? "").slice(0, 400),
      empreinte: String(charge.empreinte ?? ""),
      score: Number(charge.score ?? 0),
      etiquette: charge.etiquette,
      de: message.de,
    });
    enCours.repondants.add(message.de);
  }

  /** Clôture une requête : déduplication par empreinte, tri par score. */
  private clore(requeteId: string): void {
    const enCours = this.enCours.get(requeteId);
    if (!enCours) return;
    this.enCours.delete(requeteId);

    const uniques = new Map<string, FragmentRecu>();
    for (const fragment of enCours.fragments) {
      const existant = uniques.get(fragment.empreinte);
      if (!existant || fragment.score > existant.score) {
        uniques.set(fragment.empreinte, fragment);
      }
    }
    const fragments = [...uniques.values()].sort((a, b) => b.score - a.score).slice(0, 8);
    enCours.resoudre({
      requeteId,
      question: enCours.question,
      fragments,
      respondants: enCours.repondants.size,
      dureeMs: Date.now() - enCours.debut,
      vide: fragments.length === 0,
    });
  }

  /** Requêtes encore ouvertes (diagnostic). */
  get nbEnCours(): number {
    return this.enCours.size;
  }
}
