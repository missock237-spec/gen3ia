/**
 * CAPABILITY BRAIN BRIDGE (UCE Phase 8) — le PONT entre l'UCE et le cerveau
 * central Gen3ia (mission §6).
 *
 * RÔLE ET LIMITES (règle anti-concurrent) :
 *  - ce module est un MODULE-AGENT du cœur autonome (lib/autonomous/core) :
 *    il reçoit un tick, collecte des DONNÉES réelles sur les capacités et
 *    les remet au cerveau via l'événement « uce-rapport » ;
 *  - il NE DÉCIDE RIEN : le cerveau central reste l'unique autorité
 *    décisionnelle — le bridge fournit l'état, ouvre des incidents, propose
 *    des recommandations (du texte), jamais des actions intégrées ;
 *  - les workers ne peuvent ni élever leurs permissions ni intégrer un outil
 *    en production (les gates du permission-manager et du capability-manager
 *    l'interdisent mécaniquement).
 */

import "server-only";

import type { ContexteTick, ModuleAgent, RapportModule } from "@/lib/autonomous/core/types";
import { obtenirGestionnaireCapacites, type GestionnaireOptions } from "./capability-manager";
import { produireDecisions } from "./capability-decision";
import { santeGlobale } from "../monitoring/capability-health";
import { analyserEchecs, ouvrirIncident } from "../monitoring/failure-analyzer";
import { performanceGlobale } from "../monitoring/performance-monitor";
import { refuserSiSecret } from "../security/secrets-protection";

/** Rapport honnête remis au cerveau (mission §6 — champ par champ). */
export interface RapportPourCerveau {
  dateIso: string;
  outils: {
    totalAnnonces: number;
    totalEnregistres: number;
    capacitesUce: number;
    parStatut: Record<string, number>;
  };
  defaillantes: Array<{ capabilityId: string; etat: string; echecsConsecutifs: number; tauxSucces: number }>;
  performances: Array<{ capabilityId: string; executions: number; tauxSucces: number; dureeP95Ms: number }>;
  echecs: {
    executionsAnalysees: number;
    categories: Array<{ categorie: string; nombre: number }>;
    incidentsOuverts: number;
  };
  recommandations: string[];
  /** Le cerveau décide — le bridge ne propose QUE du texte borné. */
  limites: string[];
}

/** Construit le rapport de capacités pour le cerveau central (données réelles). */
export async function rapportPourCerveau(options: GestionnaireOptions = {}): Promise<RapportPourCerveau> {
  const gestionnaire = obtenirGestionnaireCapacites(options);
  const [stats, sante, echecs, performances] = await Promise.all([
    gestionnaire.statistiques(),
    santeGlobale(options),
    analyserEchecs(options),
    performanceGlobale(options),
  ]);

  const defaillantes = sante.capacites
    .filter((c) => c.etat === "en_echec" || c.etat === "degradee")
    .slice(0, 10)
    .map((c) => ({
      capabilityId: c.capabilityId,
      etat: c.etat,
      echecsConsecutifs: c.echecsConsecutifs,
      tauxSucces: c.tauxSucces,
    }));

  // Incidents automatiques pour les capacités en échec (traçabilité, pas décision).
  for (const d of defaillantes.slice(0, 5)) {
    await ouvrirIncident(
      { capabilityId: d.capabilityId, kind: "echec-execution", message: `capacité ${d.etat} : ${d.echecsConsecutifs} échec(s) consécutif(s), taux ${Math.round(d.tauxSucces * 100)}%` },
      options,
    );
  }

  const limites = [
    "le bridge collecte des données : toute décision reste au cerveau central",
    "aucune intégration n'est possible sans autorisation explicite (gates)",
    "les recommandations sont du texte borné — jamais des instructions injectées",
  ];

  return {
    dateIso: new Date().toISOString(),
    outils: {
      totalAnnonces: stats.nativesAnnoncees,
      totalEnregistres: stats.nativesEnregistrees,
      capacitesUce: stats.total - stats.nativesAnnoncees,
      parStatut: stats.parStatut,
    },
    defaillantes,
    performances: performances.slice(0, 10).map((p) => ({
      capabilityId: p.capabilityId,
      executions: p.executions,
      tauxSucces: p.tauxSucces,
      dureeP95Ms: p.dureeP95Ms,
    })),
    echecs: {
      executionsAnalysees: echecs.executionsAnalysees,
      categories: echecs.categories.map((c) => ({ categorie: c.categorie, nombre: c.nombre })),
      incidentsOuverts: echecs.incidentsOuverts,
    },
    recommandations: echecs.recommandations.map((r) => refuserSiSecret(r).autorise ? r.slice(0, 200) : "[recommandation masquée : contenu sensible détecté]"),
    limites,
  };
}

/**
 * MODULE-AGENT « capacites-uce » : un tick = collecte bornée du rapport +
 * SYNTHÈSE DES DÉCISIONS DU CERVEAU (V1.1 Phase 4 : le pont n'est plus un
 * simple transmetteur — le moteur de décision du cerveau central transforme
 * les données mesurées en CapabilityDecision persistées et événements) +
 * événements pour les autres modules. Contrat ModuleAgent : ne lève JAMAIS,
 * retourne vite (aucun appel de découverte réseau ici — lecture locale
 * uniquement ; la synthèse de décisions est déterministe et locale).
 */
export function agentCapacitesUce(options: GestionnaireOptions = {}): ModuleAgent {
  return {
    id: "capacites-uce",
    nom: "Pont UCE ↔ cerveau",
    role: "08. SUPERVISION DES CAPACITÉS (rapport de données + décisions du cerveau central)",
    intervalleMs: 300_000,
    async tick(ctx: ContexteTick): Promise<RapportModule> {
      try {
        const rapport = await rapportPourCerveau(options);
        ctx.emettreEvenement({
          de: "capacites-uce",
          sujet: "uce-rapport",
          charge: {
            totalAnnonces: rapport.outils.totalAnnonces,
            totalEnregistres: rapport.outils.totalEnregistres,
            defaillantes: rapport.defaillantes.length,
            incidentsOuverts: rapport.echecs.incidentsOuverts,
            recommandations: rapport.recommandations.slice(0, 5),
          },
        });

        // V1.1 Phase 4 — le cerveau central DÉCIDE (synthèse déterministe sur
        // données mesurées, évaluée contre la politique d'autonomie). Les
        // besoins non satisfaits remontés par les autres modules sont inclus.
        const besoinsRecus = ctx.evenementsRecus
          .filter((e) => e.sujet === "besoin-capacite" && typeof e.charge?.besoin === "string")
          .map((e) => String(e.charge?.besoin).slice(0, 160));
        const decisions = await produireDecisions({ rapport, besoinsNonSatisfaits: besoinsRecus }, options);
        const autorisees = decisions.filter((d) => d.verdictPolitique.autorise);
        if (autorisees.length > 0) {
          ctx.emettreEvenement({
            de: "capacites-uce",
            sujet: "uce-decisions",
            charge: {
              decisions: autorisees.slice(0, 10).map((d) => ({ decisionId: d.decisionId, action: d.action, cible: d.targetCapability ?? null, priorite: d.priorite, approbationRequise: d.constraints.requiresApproval })),
            },
          });
        }

        return {
          statut: "succes",
          message: `rapport UCE au cerveau : ${rapport.outils.totalEnregistres}/${rapport.outils.totalAnnonces} outils enregistrés, ${rapport.defaillantes.length} défaillante(s), ${rapport.echecs.incidentsOuverts} incident(s) ouvert(s) — ${decisions.length} décision(s) du cerveau (${autorisees.length} autorisée(s))`,
          details: {
            parStatut: rapport.outils.parStatut,
            executionsAnalysees: rapport.echecs.executionsAnalysees,
            decisionsProduites: decisions.map((d) => ({ id: d.decisionId, action: d.action, statut: d.statut })),
          },
        };
      } catch (erreur) {
        return {
          statut: "echec",
          message: `tick capacites-uce échoué (non fatal) : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
        };
      }
    },
  };
}
