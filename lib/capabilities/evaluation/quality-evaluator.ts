/**
 * QUALITY EVALUATOR (UCE) — qualité MESURABLE d'une candidate :
 * documentation, maintenance, fraîcheur, engagement communauté. Chaque
 * critère est calculé depuis des faits observables (longueurs, dates,
 * compteurs) — jamais d'impression subjective sans donnée.
 */

import "server-only";

import type { CapabilityDiscovery } from "../core/capability-contract";

export interface ScoresQualite {
  /** 0-100 — richesse de la description + fonctionnalités listées. */
  documentation: number;
  /** 0-100 — fraîcheur de la dernière vérification/publication. */
  fraicheur: number;
  /** 0-100 — maintenance déduite (version, risques déclarés). */
  maintenabilite: number;
  /** Total pondéré 0-100. */
  total: number;
  constats: string[];
}

/**
 * Évalue la qualité d'une fiche de découverte (faits observables).
 * Les candidates sans documentation mesurable sont pénalisées — jamais
 * créditées « par défaut ».
 */
export function evaluerQualite(fiche: CapabilityDiscovery, maintenant = Date.now()): ScoresQualite {
  const constats: string[] = [];

  // Documentation : description substantielle + fonctionnalités + licence.
  let documentation = 0;
  const longueurDesc = fiche.description.length;
  documentation += Math.min(50, Math.round(longueurDesc / 4)); // 200+ chars → 50
  documentation += Math.min(30, fiche.fonctionnalites.length * 6);
  if (fiche.licence) documentation += 10;
  if (fiche.url) documentation += 10;
  if (longueurDesc < 40) constats.push("description très courte (< 40 caractères) : documentation faible");
  if (!fiche.licence) constats.push("licence absente : usage juridique incertain");

  // Fraîcheur : âge réel depuis la dernière vérification.
  const ageJours = Math.max(0, Math.floor((maintenant - Date.parse(fiche.verifieLe)) / 86_400_000));
  const fraicheur = ageJours <= 1 ? 100 : ageJours <= 7 ? 80 : ageJours <= 30 ? 60 : ageJours <= 90 ? 40 : 20;
  if (ageJours > 30) constats.push(`fiche vérifiée il y a ${ageJours} jours : re-vérification recommandée`);

  // Maintenabilité : risques déclarés + dépendances raisonnable.
  let maintenabilite = 100;
  maintenabilite -= fiche.risques.length * 20;
  if (fiche.dependances.length > 50) {
    maintenabilite -= 20;
    constats.push(`${fiche.dependances.length} dépendances déclarées : surface d'attaque et coût de maintenance élevés`);
  }
  maintenabilite = Math.max(0, maintenabilite);

  const total = Math.round(documentation * 0.4 + fraicheur * 0.35 + maintenabilite * 0.25);
  return { documentation, fraicheur, maintenabilite, total, constats };
}
