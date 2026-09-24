/**
 * Concaténation de classes conditionnelle (équivalent léger de clsx,
 * zéro dépendance) : filtre les valeurs fausses, joint par espaces.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
