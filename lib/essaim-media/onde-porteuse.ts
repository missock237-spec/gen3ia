import "server-only";

/**
 * ONDE PORTEUSE — le canal central de diffusion de l'essaim média.
 *
 * L'analogie utilisateur est la propagation d'ondes entre les agents et
 * l'IA centrale ; l'implémentation réelle est un bus d'événements
 * process-local dont le flux SSE `/api/essaim/canal` est le support radio :
 *  - `affectation`  → « nœud X, voici TA part de la tâche » ;
 *  - `relance`      → « l'agent qui tenait cette part a rompu, elle t'est
 *                     confiée » (le système de relance demandé) ;
 *  - `travail_termine` → les signaux ont été associés, l'œuvre est prête.
 *
 * Un BATTEUR CENTRAL tourne toutes les 10 s (démarré paresseusement) :
 * sentinelle de ruptures + ré-attribution + purge. Sans lui, une
 * déconnexion brusque ne serait détectée qu'au prochain passage.
 */

import { EventEmitter } from "node:events";
import type { FragmentTravail } from "./types";

export interface ÉvénementAffectation {
  type: "affectation";
  noeudId: string;
  fragments: FragmentTravail[];
}

export interface ÉvénementRelance {
  type: "relance";
  noeudId: string;
  fragment: FragmentTravail;
  noeudPerdu: string;
}

export interface ÉvénementTravailTerminé {
  type: "travail_termine";
  userId: string;
  jobId: string;
  conversationId: string;
  kind: string;
  url: string;
}

export type ÉvénementEssaim =
  | ÉvénementAffectation
  | ÉvénementRelance
  | ÉvénementTravailTerminé;

class OndePorteuse extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(250);
  }

  publier(événement: ÉvénementEssaim): void {
    this.emit("onde", événement);
    // Diffusion ciblée par nœud (les agents écoutent leur propre fréquence).
    if (événement.type === "affectation" || événement.type === "relance") {
      this.emit(`noeud:${événement.noeudId}`, événement);
    }
    if (événement.type === "travail_termine") {
      this.emit("livraison", événement);
    }
  }

  /** S'abonne aux ondes d'UN nœud (agent exécutant). */
  écouterNoeud(noeudId: string, auditeur: (e: ÉvénementEssaim) => void): () => void {
    const canal = `noeud:${noeudId}`;
    this.on(canal, auditeur);
    return () => this.off(canal, auditeur);
  }

  /** S'abonne aux livraisons (pages demandeurs). */
  écouterLivraisons(auditeur: (e: ÉvénementTravailTerminé) => void): () => void {
    const h = (e: ÉvénementEssaim): void => {
      if (e.type === "travail_termine") auditeur(e);
    };
    this.on("livraison", h);
    return () => this.off("livraison", h);
  }
}

/** Bus central unique (process PM2 gen3ia). */
export const ondePorteuse = new OndePorteuse();

/* ------------------------------------------------------------- batteur --- */

type Batteur = { interval: NodeJS.Timeout | null; démarrer: () => void };
let batteur: Batteur | null = null;

/**
 * Démarre (une seule fois) le batteur central : sentinelle de relance
 * toutes les 10 s — ruptures détectées, fragments re-relancés puis
 * RE-ATTRIBUÉS aux 5 meilleurs appareils, diffusion en onde vers chaque
 * nouveau détenteur (type « relance » si génération > 0 : l'agent sait
 * qu'il reprend la part d'un agent rompu). Paresseux — appelé à la
 * première onde (route touchée), jamais au build. `unref()` : ne retient
 * pas le process en dev.
 */
export function assurerBatteur(dépendances: {
  surveiller: () => { relancés: unknown[]; échoués: unknown[] };
  attribuer: () => unknown[];
}): void {
  if (batteur) return;
  batteur = {
    interval: null,
    démarrer: () => {
      const courant = batteur;
      if (!courant || courant.interval) return;
      courant.interval = setInterval(() => {
        try {
          dépendances.surveiller();
          const confiés = dépendances.attribuer() as Array<
            Pick<FragmentTravail, "noeudId" | "génération"> & { fragmentId: string }
          >;
          // Diffusion ciblée : chaque nouveau détenteur reçoit SA part.
          const parNœud = new Map<string, FragmentTravail[]>();
          for (const f of confiés) {
            if (!f.noeudId) continue;
            const liste = parNœud.get(f.noeudId) ?? [];
            liste.push(f as FragmentTravail);
            parNœud.set(f.noeudId, liste);
          }
          for (const [noeudId, fragments] of parNœud) {
            for (const fragment of fragments) {
              ondePorteuse.publier(
                fragment.génération > 0
                  ? { type: "relance", noeudId, fragment, noeudPerdu: "sentinelle" }
                  : { type: "affectation", noeudId, fragments: [fragment] },
              );
            }
          }
        } catch {
          /* le batteur ne meurt jamais sur une exception ponctuelle */
        }
      }, 10_000);
      const interval = courant.interval;
      if (typeof interval.unref === "function") interval.unref();
    },
  };
  batteur.démarrer();
}
