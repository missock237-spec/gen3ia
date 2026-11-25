/**
 * WORKER DE TRAITEMENT (Lot 3 — Gen3ia Data Pipeline, workers du plan).
 *
 * Module-agent du core, INDÉPENDANT du collecteur : il draine la file
 * persistante (lots QUEUED), applique l'intelligence (Lot 4), la
 * vérification (Lot 5) et l'intégration mémoire — sans JAMAIS bloquer la
 * collecte (isolation par tick du core + plafond par tick).
 *
 * PRIVACY FIREWALL : chaque accès fichier passe par le garde à liste
 * blanche (privacy/firewall.ts) — l'isolation est technique, pas
 * déclarative (Règle 11 de la mission).
 *
 * Traitements par tick : borné (défaut 3 lots) — le reste attend le
 * prochain cycle (les cycles sont indépendants).
 */

import type { ModuleAgent } from "../core/types";
import type { FileLots } from "./queue";
import { traiterLot } from "../intelligence/traiter";
import { verifierEnregistrement } from "../intelligence/verifier";
import type { MemoireConnaissances } from "../knowledge/memoire-connaissances";
import type { RegistreSources } from "../acquisition/source-registry";
import { verifierAccesEntrainement, detecterCheminPrive } from "../privacy/firewall";

/** Options du worker (tout injectable pour les tests). */
export interface OptionsWorker {
  file: FileLots;
  memoire: MemoireConnaissances;
  registre: RegistreSources;
  /** Dossier du core (contrôle firewall — accès fichiers bornés). */
  dossierCore: string;
  /** Lots traités max par tick (défaut 3 — collecte légère au début). */
  lotsParTick?: number;
}

/** Le module-agent "traitement". */
export function agentTraitement(options: OptionsWorker): ModuleAgent {
  const lotsParTick = options.lotsParTick ?? 3;
  return {
    id: "traitement",
    nom: "Agent de traitement du pipeline",
    role: "03-06. PIPELINE + INTELLIGENCE + VÉRIFICATION + MÉMOIRE",
    async tick(ctx) {
      // Garde firewall : l'espace du pipeline doit être cohérent avant tout travail.
      const tache = ctx.taches.creer({ module: "traitement", cycle: ctx.cycle, type: "pipeline" });
      if (tache) ctx.taches.demarrer(tache.id);

      const aTraiter = options.file.aTraiter(lotsParTick);
      if (aTraiter.length === 0) {
        if (tache) ctx.taches.terminer(tache.id, "file vide");
        return { statut: "rien_a_faire", message: "Aucun lot en attente — la file est à jour.", taches: tache ? [tache.id] : [] };
      }

      const resultat: string[] = [];
      let integres = 0;
      let quarantaines = 0;
      let rejetes = 0;
      let echecs = 0;

      for (const lot of aTraiter) {
        // Prise en charge d'abord (machine à états : le refus passe par le
        // chemin légal PROCESSING→VALIDATING→REJECTED — jamais de saut).
        options.file.transitioner(lot.id, "PROCESSING", "prise en charge worker");
        // Firewall (2e couche — anti-détournement) : un lot dont la SOURCE
        // prétend venir d'un espace utilisateur est refusé AVANT tout
        // traitement — les mémoires privées ne peuvent jamais entrer
        // (Règle 11 : isolation technique, pas déclarative).
        if (detecterCheminPrive(lot.url) || detecterCheminPrive(lot.sourceId)) {
          options.file.transitioner(lot.id, "VALIDATING", "firewall : source privée détectée");
          options.file.transitioner(lot.id, "REJECTED", "firewall : source privée détectée (isolation technique)");
          rejetes += 1;
          resultat.push(`${lot.id} : REFUSÉ firewall (source privée)`);
          continue;
        }
        // Firewall (1re couche) : le lot appartient-il bien à l'espace autorisé ?
        const acces = verifierAccesEntrainement(`pipeline/lots/${lot.id}.json`, options.dossierCore);
        if (!acces.autorise) {
          // Jamais traité hors espace blanc : refus tracé, lot rejeté.
          options.file.transitioner(lot.id, "VALIDATING", `firewall : ${acces.raison}`);
          options.file.transitioner(lot.id, "REJECTED", `firewall : ${acces.raison}`);
          rejetes += 1;
          resultat.push(`${lot.id} : REFUSÉ firewall`);
          continue;
        }

        const traite = traiterLot(lot);
        if (!traite.ok || !traite.enregistrement) {
          options.file.replanifier(lot.id, traite.message);
          echecs += 1;
          resultat.push(`${lot.id} : ${traite.message}`);
          continue;
        }
        const enregistrement = traite.enregistrement;

        options.file.transitioner(lot.id, "VALIDATING", traite.message);
        // La structure est conservée dans le lot (promotion possible depuis
        // la quarantaine quand une seconde source confirmera le concept).
        options.file.enregistrerStructure(lot.id, enregistrement);

        // Confirmation indépendante : des lots QUARANTAINED du MÊME concept
        // venus d'AUTRES sources comptent comme confirmations (Phase 5).
        const confirmants = options.file
          .parStatut("QUARANTINED", 50)
          .filter((q) => q.structure?.idConcept === enregistrement.idConcept && q.sourceId !== lot.sourceId);
        const decision = verifierEnregistrement(
          enregistrement,
          options.registre,
          options.memoire,
          confirmants.length,
        );
        const details = decision.raisons.join(" · ");

        if (decision.statut === "APPROVED") {
          const conn = options.memoire.integrer(traite.enregistrement, Math.round(decision.confiance * 2));
          options.file.transitioner(lot.id, "APPROVED", details);
          options.file.transitioner(lot.id, "INTEGRATED", `mémoire : « ${conn.concept.slice(0, 50)} »`);
          integres += 1;
          // PROMOTION des lots confirmants (quarantaine → mémoire) : la
          // seconde source indépendante a résolu l'incertitude.
          for (const q of confirmants) {
            if (q.structure) {
              options.memoire.integrer(q.structure, 2);
              options.file.transitioner(q.id, "VALIDATING", "confirmé par une source indépendante");
              options.file.transitioner(q.id, "APPROVED", details);
              options.file.transitioner(q.id, "INTEGRATED", `promu : confirmé par ${lot.id}`);
              integres += 1;
            }
          }
          resultat.push(`${lot.id} : APPROVED → « ${conn.concept.slice(0, 40)} »${confirmants.length > 0 ? ` (+${confirmants.length} promu(s))` : ""}`);
        } else if (decision.statut === "QUARANTINED") {
          options.file.transitioner(lot.id, "QUARANTINED", details);
          quarantaines += 1;
          resultat.push(`${lot.id} : QUARANTINED (confiance ${decision.confiance})`);
        } else {
          options.file.transitioner(lot.id, "REJECTED", details);
          rejetes += 1;
          resultat.push(`${lot.id} : REJECTED (${details.slice(0, 80)})`);
        }
      }

      const message = `Pipeline : ${integres} intégré(s), ${quarantaines} en quarantaine, ${rejetes} rejeté(s), ${echecs} en replanification (${aTraiter.length} lot(s) pris en charge).`;
      if (tache) ctx.taches.terminer(tache.id, message);
      return {
        statut: integres + quarantaines + rejetes > 0 ? "succes" : "rien_a_faire",
        message,
        taches: tache ? [tache.id] : [],
        details: { integres, quarantaines, rejetes, echecs, journal: resultat },
      };
    },
  };
}
