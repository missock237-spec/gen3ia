/**
 * Neutralisation de l'injection de formules CSV/Excel (OWASP CSV Injection).
 *
 * Une cellule alimentée par du contenu dynamique (LLM, agent, utilisateur)
 * ne doit JAMAIS être interprétée comme formule à l'ouverture du fichier
 * par le client final (=HYPERLINK, =cmd|'/c calc'!A0, DDE…). Les deux
 * générateurs (CSV texte et XLSX ExcelJS) passent par ce module.
 */

/** Préfixes qu'Excel/LibreOffice interprètent comme formule ou commande. */
const DANGEROUS_CELL_PREFIX = /^[=+\-@\t\r]/;

export function isDangerousCell(value: string): boolean {
  return DANGEROUS_CELL_PREFIX.test(value);
}

/**
 * CSV : préfixe apostrophe (convention Excel « texte forcé ») pour toute
 * cellule dangereuse, avant le quoting existant.
 */
export function neutralizeCsvCell(value: string): string {
  return isDangerousCell(value) ? `'${value}` : value;
}

/**
 * XLSX : ExcelJS interprète les chaînes commençant par « = » comme des
 * formules natives. On force le type texte via un objet richText —
 * rendu identique, interprétation impossible.
 */
export function toXlsxCellValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > 0 && isDangerousCell(value)) {
    return { richText: [{ text: value }] };
  }
  return value;
}
