/**
 * MODE LIBRE (migration R2 totale) : la plateforme ne facture plus l'usage —
 * R2 porte l'intégralité des données et des analyses, aucune déduction de
 * crédit ne doit donc s'afficher ni bloquer une exécution. Toutes les
 * primitives de DÉBIT (réservation, règlement, libération) deviennent des
 * no-ops fail-soft : un agent, une mission, un outil, une vidéo ou un média
 * ne peut JAMAIS être arrêté ni débité. Les entrées d'argent réel (recharge
 * Chariow, gains de la plateforme) restent opérationnelles.
 *
 * SÉMANTIQUE (Task 161) : le DÉFAUT est le MODE LIBRE — l'absence de la
 * variable (production sans configuration particulière) signifie accès
 * gratuit, et la facturation ne se réactive QUE par une valeur explicite
 * GEN3IA_BILLING_ENABLED=true dans .env.production. La suite de tests arme
 * la facturation via GEN3IA_BILLING_ENABLED=true dans vitest.config.mts et
 * vitest.e2e.config.mts : les garanties historiques restent toutes validées.
 * Ce choix rend impossible une facturation accidentelle (fail-safe : un
 * environnement mal configuré ne débite jamais personne).
 *
 * Ce constant vit dans SON PROPRE module (et non dans wallet.ts) : les tests
 * mockent ./wallet sans le re-fournir — l'interrupteur doit rester réel.
 */
export const BILLING_ENABLED = process.env.GEN3IA_BILLING_ENABLED === "true";
