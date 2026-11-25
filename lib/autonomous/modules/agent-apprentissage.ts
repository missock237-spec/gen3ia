/**
 * AGENT D'APPRENTISSAGE CONTINU (Lot 05 — module-agent du Gen3ia
 * Autonomous Core, branché au CERVEAU RÉEL).
 *
 * Tous les N cycles (déflexe léger — ressources 2 cœurs) :
 *  1. mécanisme A — enrichissement MÉMOIRE : déjà l'œuvre du pipeline
 *     (Lots 4-5) ; cet agent fournit les sondes dérivées de la mémoire ;
 *  2. mécanisme C — adaptation neuronale BORNÉE via le sous-moteur RÉEL
 *     (sous-moteur-reel.ts : cortex.repondre + appliquerEntrainementAuto +
 *     persistance v2), avec évaluations pré/post et GARDE ANTI-OUBLI
 *     (rollback vérifié si dégradation).
 *
 * Distinction honnête demandée par la mission : l'enrichissement mémoire et
 * la modification des paramètres neuronaux sont DEUX choses — le rapport du
 * tick les nomme séparément, et une adaptation non prise en charge est
 * rapportée comme telle (jamais simulée).
 */

import type { ModuleAgent } from "../core/types";
import { lotApprentissageContinu } from "../continual-learning/moteur-continu";
import { sousMoteurNeuralReel } from "../continual-learning/sous-moteur-reel";
import type { MemoireConnaissances } from "../knowledge/memoire-connaissances";

/** Options de l'agent (tout injectable pour les tests). */
export interface OptionsAgentApprentissage {
  memoire: MemoireConnaissances;
  /** Adaptation neuronale tous les N cycles (défaut 4 — charge légère). */
  tousLesCycles?: number;
  /** Sous-moteur injectable (défaut : le RÉEL). */
  sousMoteur?: ReturnType<typeof sousMoteurNeuralReel>["moteur"];
  /** Max d'échantillons par adaptation (bornes de ressources). */
  maxEchantillons?: number;
}

/** Le module-agent "apprentissage-continu". */
export function agentApprentissageContinu(options: OptionsAgentApprentissage): ModuleAgent {
  const tousLesCycles = Math.max(1, options.tousLesCycles ?? 4);
  const { moteur, etat } = options.sousMoteur
    ? { moteur: options.sousMoteur, etat: { pret: true, raison: "sous-moteur injecté (test)" } }
    : sousMoteurNeuralReel();
  return {
    id: "apprentissage-continu",
    nom: "Agent d'apprentissage continu",
    role: "07. CONTINUAL LEARNING — sondes mémoire + adaptation bornée gardée",
    async tick(ctx) {
      const tache = ctx.taches.creer({ module: "apprentissage-continu", cycle: ctx.cycle, type: "continu" });
      if (tache) ctx.taches.demarrer(tache.id);

      // Déflexe : l'adaptation neuronale n'est pas chaque cycle.
      if (ctx.cycle % tousLesCycles !== 0) {
        if (tache) ctx.taches.terminer(tache.id, "hors fenêtre d'adaptation (déflexe)");
        return {
          statut: "rien_a_faire",
          message: `Adaptation neuronale hors fenêtre (tous les ${tousLesCycles} cycles) — enrichissement mémoire déjà assuré par le pipeline.`,
          taches: tache ? [tache.id] : [],
        };
      }

      // Mécanisme A (sondes mémoire) + C (adaptation gardée) : le moteur
      // dérive lui-même les sondes depuis la mémoire vérifiée.
      // Échantillons Q/R dérivés des connaissances APPROVED (provenance tracée).
      const echantillons = options.memoire.toutesActives(40).map((c) => ({
        question: `Que sais-tu de « ${c.concept.split(/\s+/).slice(0, 4).join(" ")} » ?`,
        reponse: c.resume.slice(0, 1_200),
      }));

      const lot = await lotApprentissageContinu({
        memoire: options.memoire,
        sousMoteur: moteur,
        echantillonsNeuronaux: echantillons.slice(0, options.maxEchantillons ?? 12),
      });

      if (!lot.adaptation) {
        if (tache) ctx.taches.terminer(tache.id, `mémoire seulement (${lot.sondes} sondes)`);
        return {
          statut: "rien_a_faire",
          message: `Enrichissement mémoire actif ; adaptation neuronale non tentée (pas d'échantillon ou pas de sonde — ${etat.raison}).`,
          taches: tache ? [tache.id] : [],
          details: { sondes: lot.sondes, relationsFusionnees: lot.relationsFusionnees },
        };
      }

      const adapt = lot.adaptation;
      const message =
        adapt.statut === "applique"
          ? `Adaptation APPLIQUÉE (Δ ${adapt.delta} mesuré sur ${lot.sondes} sondes réelles, pré ${adapt.scorePre} → post ${adapt.scorePost}) — ${adapt.message}`
          : adapt.statut === "annule"
            ? `Adaptation ANNULÉE : ${adapt.message} — le cerveau reste en l'état validé`
            : `Adaptation en échec : ${adapt.message}`;

      if (tache) ctx.taches.terminer(tache.id, message.slice(0, 200));
      ctx.emettreEvenement({
        de: "apprentissage-continu",
        sujet: "adaptation-neuronale",
        charge: { statut: adapt.statut, delta: adapt.delta, rollback: adapt.rollbackEffectue },
      });
      return {
        statut: adapt.statut === "applique" ? "succes" : adapt.statut === "annule" ? "echec" : "echec",
        message,
        taches: tache ? [tache.id] : [],
        details: {
          sondes: lot.sondes,
          relationsFusionnees: lot.relationsFusionnees,
          scorePre: adapt.scorePre,
          scorePost: adapt.scorePost,
          delta: adapt.delta,
          rollbackEffectue: adapt.rollbackEffectue,
        },
      };
    },
  };
}
