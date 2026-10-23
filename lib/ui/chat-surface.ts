/**
 * Surfaces de chat « immersives » de Gen3ia.
 *
 * Sur ces routes, l'interface de discussion doit occuper TOUTE la surface
 * de l'appareil, À TOUT MOMENT : ni barres de navigation applicative, ni fil
 * d'Ariane, ni marges extérieures — hauteur 100dvh synchronisée sur le
 * visualViewport (clavier virtuel inclus, via --g3-vvh), largeur bord à
 * bord, fil qui défile en interne et composer collé en bas, à la manière
 * d'une application de messagerie native.
 *
 * Concerne les chats transverses du projet :
 *  - le chat direct nouvelle génération (/chat — interface Aurora) ;
 *  - le chat v4 (/chat-v4) et le copilote (/copilot).
 *
 * (L'ancienne conversation /workspace/conversations a été supprimée avec la
 * surface workspace ; le dashboard — chat IA — gère sa propre mise en page.)
 */
export function isImmersiveChatRoute(pathname: string): boolean {
  return (
    pathname === "/chat" ||
    pathname === "/chat-v4" ||
    pathname === "/copilot"
  );
}
