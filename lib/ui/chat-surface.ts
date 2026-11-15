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
 *  - le chat direct (/chat — interface canonique Nova) ;
 *  - le copilote (/copilot).
 *
 * (Les anciennes surfaces ont été supprimées : le chat Aurora et /chat-v4
 * (Task C), la conversation /workspace/conversations (Task D) — les anciennes
 * URL sont couvertes par les redirections de next.config. Le dashboard —
 * chat IA — gère sa propre mise en page.)
 */
export function isImmersiveChatRoute(pathname: string): boolean {
  return pathname === "/chat" || pathname === "/copilot";
}
