/**
 * MODE LIBRE (migration R2 totale) : avec GEN3IA_BILLING_ENABLED=false, la
 * plateforme ne facture plus l'usage — R2 porte l'intégralité des données et
 * des analyses, aucune déduction de crédit ne doit donc s'afficher ni
 * bloquer une exécution. Toutes les primitives de DÉBIT (réservation,
 * règlement, libération) deviennent des no-ops fail-soft : un agent, une
 * mission, un outil, une vidéo ou un média ne peut JAMAIS être arrêté ni
 * débité. Les entrées d'argent réel (recharge Chariow, gains marketplace)
 * restent opérationnelles. Réactivable à chaud en retirant la variable
 * (défaut : facturation active, comportement inchangé pour les tests).
 *
 * Ce constant vit dans SON PROPRE module (et non dans wallet.ts) : les tests
 * mockent ./wallet sans le re-fournir — l'interrupteur doit rester réel.
 */
export const BILLING_ENABLED = process.env.GEN3IA_BILLING_ENABLED !== "false";
