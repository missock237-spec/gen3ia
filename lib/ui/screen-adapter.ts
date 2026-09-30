/**
 * Adaptateur d'écran (étape 10 du plan 20) — expérience cohérente sur tous
 * les appareils.
 *
 * Source UNIQUE des classes de présentation pour le comportement « même
 * contenu, deux habillages » :
 *  - ≥ 1024 px (lg) : les panneaux (liste des conversations, tiroir de
 *    contexte) restent des colonnes INLINE, comme toujours ;
 *  - < 1024 px : le même contenu est présenté en FEUILLE SUPERPOSÉE
 *    (overlay), ouvrable depuis l'en-tête — au lieu d'être simplement
 *    caché (défaut historique : sur mobile, la liste des conversations
 *    et le tiroir étaient `max-lg:hidden` SANS alternative, et le bouton
 *    « Contexte » ne faisait rien).
 *
 * Pur : aucune dépendance DOM/React — testable exhaustivement, consommé
 * par les composants clients pour zéro dérive de classes.
 */

export type SheetSide = "left" | "right";

/** Classes inline du panneau sur grand écran (comportement historique). */
export function inlinePanelClass(side: SheetSide): string {
  return side === "left"
    ? "hidden lg:block lg:shrink-0"
    : "hidden lg:block lg:shrink-0";
}

/** Classes de la feuille superposée mobile (ouverte ou fermée). */
export function overlaySheetClass(open: boolean, side: SheetSide): string {
  const base = "fixed inset-y-0 z-50 flex w-72 max-w-[85vw] flex-col overflow-y-auto bg-[var(--g3-bg)] p-3 shadow-2xl lg:hidden";
  if (!open) return `${base} hidden`;
  return side === "left"
    ? `${base} left-0 block border-r border-[var(--g3-border)]`
    : `${base} right-0 block border-l border-[var(--g3-border)]`;
}

/** Fond d'obstruction cliquable sous la feuille ouverte. */
export function backdropClass(open: boolean): string {
  return open
    ? "fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] lg:hidden"
    : "hidden";
}

/** Visibilité des boutons d'en-tête mobiles (uniquement sous lg). */
export const MOBILE_HEADER_BUTTON_CLASS = "inline-flex items-center gap-1 lg:hidden";
