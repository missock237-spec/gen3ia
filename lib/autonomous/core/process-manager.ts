/**
 * PROCESS-MANAGER DU GEN3IA AUTONOMOUS CORE (Phase 1).
 *
 * ISOLATION D'UN TICK DE MODULE-AGENT — la garantie clé du plan :
 * « une panne d'un module ne bloque pas les autres ». Chaque tick est
 * exécuté dans une promesse séparée, avec timeout de sécurité et capture
 * d'erreur exhaustive ; l'état du module est mis à jour avec des mesures
 * RÉELLES (compteurs, anneau d'erreurs, suspension par le recovery-manager).
 *
 * Contrat honnête : un tick coincé est marqué ÉCHEC côté supervision après
 * le timeout (la promesse sous-jacente ne peut pas être tuée en Node — le
 * module fautif est documenté, jamais masqué).
 */

import type { ContexteTick, EtatModule, ModuleAgent, RapportModule } from "./types";
import { enregistrerErreur } from "../monitoring/error-monitor";
import {
  estSuspendu,
  suspendreSiNecessaire,
  rearmementSiExpiré,
} from "../monitoring/recovery-manager";

/** Résultat supervisé d'un tick (mesures réelles). */
export interface ResultatTickSupervise {
  module: string;
  /** succes | echec | rien_a_faire | occupe | suspendu | timeout. */
  statut: RapportModule["statut"] | "occupe" | "suspendu" | "timeout";
  message: string;
  ms: number;
}

/** Résultat brut d'un tick (ou son erreur). */
type TickBrute =
  | { ok: true; rapport: RapportModule }
  | { ok: false; erreur: unknown };

/**
 * Exécute UN tick d'un module avec isolation complète :
 *  - jamais de lever vers l'appelant (tout est capturé et documenté) ;
 *  - timeout de sécurité (la promesse fautive reste documentée comme ÉCHEC) ;
 *  - un tick déjà en cours pour ce module est refusé (occupe — pas d'empilement) ;
 *  - échecs consécutifs → suspension par le recovery-manager.
 */
export async function executerTickModule(
  module: ModuleAgent,
  ctx: ContexteTick,
  etat: EtatModule,
  options: {
    timeoutMs: number;
    echecsAvantSuspension: number;
    suspensionMs: number;
    /** Ticks en cours (Map partagée du core — gérée par l'orchestrator). */
    ticksEnCours: Map<string, boolean>;
  },
): Promise<ResultatTickSupervise> {
  const debut = Date.now();
  rearmementSiExpiré(etat, options.suspensionMs, debut);

  if (estSuspendu(etat, debut)) {
    return {
      module: module.id,
      statut: "suspendu",
      message: `Module suspendu jusqu'à ${etat.suspenduJusquA ?? "?"} (échecs consécutifs : ${etat.echecsConsecutifs})`,
      ms: 0,
    };
  }
  if (options.ticksEnCours.get(module.id)) {
    return {
      module: module.id,
      statut: "occupe",
      message: "Tick précédent toujours en cours — pas d'empilement (cycle indépendant).",
      ms: 0,
    };
  }
  options.ticksEnCours.set(module.id, true);
  try {
    const tick = module.tick(ctx).then(
      (rapport): TickBrute => ({ ok: true, rapport }),
      (erreur: unknown): TickBrute => ({ ok: false, erreur }),
    );
    const garde = new Promise<TickBrute>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, erreur: new Error(`timeout ${options.timeoutMs} ms dépassé`) }),
        options.timeoutMs,
      ),
    );
    const resultat = await Promise.race([tick, garde]);
    const ms = Date.now() - debut;
    options.ticksEnCours.delete(module.id);
    etat.dernierTickLe = new Date().toISOString();
    etat.ticks += 1;

    if (!resultat.ok) {
      const message =
        resultat.erreur instanceof Error ? resultat.erreur.message : String(resultat.erreur);
      etat.echecs += 1;
      etat.echecsConsecutifs += 1;
      etat.dernierMessage = message;
      enregistrerErreur(etat, message);
      suspendreSiNecessaire(etat, options.echecsAvantSuspension, options.suspensionMs, Date.now());
      return {
        module: module.id,
        statut: message.startsWith("timeout") ? "timeout" : "echec",
        message,
        ms,
      };
    }

    const rapport = resultat.rapport;
    if (rapport.statut === "echec") {
      // Un rapport d'échec HONNÊTE du module compte comme un échec réel
      // (même traitement qu'une exception : compteur, anneau, suspension).
      etat.echecs += 1;
      etat.echecsConsecutifs += 1;
      etat.dernierMessage = rapport.message;
      enregistrerErreur(etat, rapport.message);
      suspendreSiNecessaire(etat, options.echecsAvantSuspension, options.suspensionMs, Date.now());
      return { module: module.id, statut: "echec", message: rapport.message, ms };
    }
    // succes OU rien_a_faire : le module a tourné sans erreur nouvelle.
    etat.echecsConsecutifs = 0;
    if (rapport.statut === "succes") {
      etat.succes += 1;
      etat.dernierSuccesLe = etat.dernierTickLe;
    }
    etat.dernierMessage = rapport.message;
    return { module: module.id, statut: rapport.statut, message: rapport.message, ms };
  } catch (erreur) {
    // Défense ultime : le process-manager ne lève JAMAIS (isolation totale).
    const message = erreur instanceof Error ? erreur.message : String(erreur);
    options.ticksEnCours.delete(module.id);
    etat.echecs += 1;
    etat.echecsConsecutifs += 1;
    etat.dernierMessage = message;
    enregistrerErreur(etat, message);
    suspendreSiNecessaire(etat, options.echecsAvantSuspension, options.suspensionMs, Date.now());
    return { module: module.id, statut: "echec", message, ms: Date.now() - debut };
  }
}
