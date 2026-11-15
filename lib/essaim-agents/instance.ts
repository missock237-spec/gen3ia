"use client";

/**
 * Bootstrap de l'essaim d'agents — assemble en un objet cohérent tout
 * ce dont un nœud a besoin, et route chaque onde reçue vers le bon
 * sous-système (orchestrateur, RAG sémantique, compétences).
 *
 * Un seul appel (`demarrerEssaim`) et le navigateur devient un nœud
 * complet de l'essaim : cinq agents spécialisés connectés au cortex
 * Gen3 local, sentinelle de résilience, coffre chiffré, index sémantique,
 * diffuseur de compétences — le tout sans serveur.
 */

import { SignalisationDouble } from "@/lib/ondes/signalisation";

import { creerAgentsParType } from "./agents-specialises";
import { DiffuseurCompetences, RegistreCompetences } from "./competences/diffuseur";
import { CoffreChiffre, EntrepotIndexedDb, EntrepotMemoire, type EntrepotKv } from "./rag/coffre-local";
import { IndexSemantiqueLocal } from "./rag/index-semantique";
import { OndeSemantique } from "./rag/onde-semantique";
import { SentinelleResilience } from "./resilience/sentinelle";
import { NoeudAgents, type TransportAgents } from "./noeud-agents";
import { CortexGen3Local, OrchestrateurAgents } from "./orchestrateur";
import type { MessageAgent } from "./types";

export interface OptionsDemarrage {
  /** Salle d'essaim (les salles d'agents sont préfixées `agents-`). */
  salle?: string;
  /** Identifiant de nœud (généré si absent). */
  id?: string;
  surEvenement?: (evenement: { type: string; detail: string }) => void;
}

export interface EssaimDemarre {
  idNoeud: string;
  noeud: NoeudAgents;
  cortex: CortexGen3Local;
  orchestrateur: OrchestrateurAgents;
  sentinelle: SentinelleResilience;
  coffre: CoffreChiffre;
  entrepot: EntrepotKv;
  index: IndexSemantiqueLocal;
  ondeSemantique: OndeSemantique;
  registre: RegistreCompetences;
  diffuseur: DiffuseurCompetences;
  arreter: () => void;
}

/**
 * Démarre un nœud d'essaim complet. L'entrepôt IndexedDB peut être
 * indisponible (SSR, environnement de test) : repli en mémoire, la
 * confidentialité reste totale (le coffre en mémoire disparaît à la
 * fermeture — jamais persisté ailleurs).
 */
export function demarrerEssaim(options?: OptionsDemarrage): EssaimDemarre {
  const salle = `agents-${(options?.salle ?? "principal").replace(/[^a-zA-Z0-9_-]/g, "")}`;

  // ——— entropie locale pour l'identifiant de nœud
  let idNoeud = options?.id ?? "";
  if (!idNoeud) {
    try {
      idNoeud = `a-${crypto.randomUUID().slice(0, 8)}`;
    } catch {
      idNoeud = `a-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }
  }

  // ——— sous-systèmes
  const cortex = new CortexGen3Local();
  const entrepot: EntrepotKv =
    typeof indexedDB !== "undefined" ? new EntrepotIndexedDb() : new EntrepotMemoire();
  const coffre = new CoffreChiffre();
  const index = new IndexSemantiqueLocal();
  const registre = new RegistreCompetences();

  const surEvenement = options?.surEvenement;
  const transport = new SignalisationDouble(salle, idNoeud);
  const noeud = new NoeudAgents({
    id: idNoeud,
    salle,
    transport: transport as unknown as TransportAgents,
    surMessage: (message: MessageAgent) => {
      orchestrateur.traiterMessage(message);
      ondeSemantique.traiterMessage(message);
      diffuseur.traiterMessage(message);
    },
    surStatut: (detail) => surEvenement?.({ type: "essaim", detail }),
    surPairs: (nombre) =>
      surEvenement?.({
        type: "pairs",
        detail: `${nombre} canal(aux) d'agents ouvert(s) — l'essaim grandit.`,
      }),
  });

  const orchestrateur = new OrchestrateurAgents({
    idNoeud,
    noeud,
    ia: cortex,
    surEvenement,
  });
  cortex.rattacher((tache) => {
    try {
      orchestrateur.ouvrirTache(tache.type, tache.charge, tache.priorite);
    } catch {
      // Le cortex n'ordonne jamais au-delà des plafonds — silence propre.
    }
  });

  const ondeSemantique = new OndeSemantique({ noeud, index });
  const diffuseur = new DiffuseurCompetences({ noeud, registre, surEvenement });
  const sentinelle = new SentinelleResilience({ orchestrateur });

  // ——— agents locaux : ce nœud offre les CINQ spécialités
  for (const agent of Object.values(creerAgentsParType())) {
    orchestrateur.enregistrerAgent(agent);
  }

  // ——— mise en route
  noeud.demarrer();
  orchestrateur.demarrer();
  sentinelle.demarrer();

  return {
    idNoeud,
    noeud,
    cortex,
    orchestrateur,
    sentinelle,
    coffre,
    entrepot,
    index,
    ondeSemantique,
    registre,
    diffuseur,
    arreter: () => {
      sentinelle.arreter();
      orchestrateur.arreter();
      noeud.arreter();
    },
  };
}
