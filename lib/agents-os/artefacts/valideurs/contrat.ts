/**
 * AGENTS-OS — CONTRAT COMMUN DES VALIDATEURS D'ARTEFACTS (Module 3).
 *
 * Chaque validateur natif retourne la même structure : liste d'erreurs
 * LOCALISÉES (ligne/colonne/cause) — jamais d'exception brutale. Le
 * service-audit orchestre : valider → réparer → REVALIDER (boucle bornée).
 */

export type TypeArtefact = "json" | "yaml" | "docker-compose" | "nginx" | "javascript" | "typescript";

export interface ErreurSyntaxe {
  /** Ligne 1-indexée (0 si indéterminable). */
  readonly ligne: number;
  /** Colonne 1-indexée (0 si indéterminable). */
  readonly colonne: number;
  /** Cause humaine honnête. */
  readonly message: string;
}

export interface ResultatValidation {
  readonly valide: boolean;
  readonly erreurs: readonly ErreurSyntaxe[];
}

/** Contrat d'un validateur natif : contenu texte → diagnostic localisé. */
export type Validateur = (contenu: string) => ResultatValidation;

/** Convertit un offset caractère → (ligne, colonne) 1-indexées. */
export function offsetVersLigneColonne(contenu: string, offset: number): { ligne: number; colonne: number } {
  const avant = contenu.slice(0, Math.max(0, Math.min(offset, contenu.length)));
  const lignes = avant.split("\n");
  return { ligne: lignes.length, colonne: (lignes[lignes.length - 1]?.length ?? 0) + 1 };
}

/** Diagnostic à partir d'un message d'exception quelconque (ligne 0). */
export function erreurBrute(message: string): ErreurSyntaxe {
  return { ligne: 0, colonne: 0, message };
}
