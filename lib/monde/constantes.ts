/**
 * Constantes de la nature — le socle du Monde.
 *
 * Toutes les valeurs sont en unités SI, issues des recommandations
 * CODATA. Le Monde de Gen3ia résout la physique avec ces constantes :
 * chaque domaine (mécanique, quantique, thermique…) les consomme telles
 * quelles — aucune valeur « magique » dispersée dans le code.
 */

/** Vitesse de la lumière dans le vide (m/s). */
export const C_LUMIERE = 299_792_458;

/** Constante de gravitation universelle de Newton (m³·kg⁻¹·s⁻²). */
export const G_NEWTON = 6.6743e-11;

/** Accélération de la pesanteur terrestre standard (m/s²). */
export const G_TERRE = 9.80665;

/** Constante de Planck (J·s). */
export const H_PLANCK = 6.62607015e-34;

/** Constante de Planck réduite ħ = h / 2π (J·s). */
export const H_BARRE = H_PLANCK / (2 * Math.PI);

/** Constante de Boltzmann (J/K). */
export const K_BOLTZMANN = 1.380649e-23;

/** Constante des gaz parfaits (J·mol⁻¹·K⁻¹). */
export const R_GAZ = 8.31446261815324;

/** Nombre d'Avogadro (mol⁻¹). */
export const N_AVOGADRO = 6.02214076e23;

/** Charge élémentaire (C). */
export const E_CHARGE = 1.602176634e-19;

/** Masse de l'électron (kg). */
export const M_ELECTRON = 9.1093837015e-31;

/** Masse du proton (kg). */
export const M_PROTON = 1.67262192369e-27;

/** Permittivité du vide (F/m). */
export const EPSILON0 = 8.8541878128e-12;

/** Perméabilité du vide (H/m). */
export const MU0 = 1.25663706212e-6;

/** Constante de Stefan-Boltzmann (W·m⁻²·K⁻⁴). */
export const SIGMA_STEFAN = 5.670374419e-8;

/** Masse de la Terre (kg). */
export const M_TERRE = 5.9722e24;

/** Rayon moyen de la Terre (m). */
export const R_TERRE = 6.371e6;

/** Masse du Soleil (kg). */
export const M_SOLEIL = 1.98847e30;

/** Unité astronomique (m). */
export const UA = 1.495978707e11;

/** Registre lisible des constantes (affiché dans les résultats). */
export const REGISTRE_CONSTANTES: ReadonlyArray<{ symbole: string; nom: string; valeur: number; unite: string }> = [
  { symbole: "c", nom: "Vitesse de la lumière", valeur: C_LUMIERE, unite: "m/s" },
  { symbole: "G", nom: "Gravitation de Newton", valeur: G_NEWTON, unite: "m³·kg⁻¹·s⁻²" },
  { symbole: "g", nom: "Pesanteur terrestre", valeur: G_TERRE, unite: "m/s²" },
  { symbole: "h", nom: "Constante de Planck", valeur: H_PLANCK, unite: "J·s" },
  { symbole: "ħ", nom: "Constante de Planck réduite", valeur: H_BARRE, unite: "J·s" },
  { symbole: "k_B", nom: "Constante de Boltzmann", valeur: K_BOLTZMANN, unite: "J/K" },
  { symbole: "R", nom: "Constante des gaz parfaits", valeur: R_GAZ, unite: "J·mol⁻¹·K⁻¹" },
  { symbole: "N_A", nom: "Nombre d'Avogadro", valeur: N_AVOGADRO, unite: "mol⁻¹" },
  { symbole: "e", nom: "Charge élémentaire", valeur: E_CHARGE, unite: "C" },
  { symbole: "ε₀", nom: "Permittivité du vide", valeur: EPSILON0, unite: "F/m" },
  { symbole: "μ₀", nom: "Perméabilité du vide", valeur: MU0, unite: "H/m" },
  { symbole: "σ", nom: "Stefan-Boltzmann", valeur: SIGMA_STEFAN, unite: "W·m⁻²·K⁻⁴" },
];
