/**
 * Surfaces de chat « immersives » de Gen3ia.
 *
 * Sur ces routes, l'interface de discussion doit occuper TOUTE la surface
 * de l'appareil, À TOUT MOMENT : ni barres de navigation workspace, ni fil
 * d'Ariane, ni marges extérieures — hauteur 100dvh synchronisée sur le
 * visualViewport (clavier virtuel inclus, via --g3-vvh), largeur bord à
 * bord, fil qui défile en interne et composer collé en bas, à la manière
 * d'une application de messagerie native.
 *
 * Concerne les deux chats transverses du projet :
 *  - la conversation (/workspace/conversations[/id]) ;
 *  - le chat d'agent IA (/studio/agents).
 */
export function isImmersiveChatRoute(pathname: string): boolean {
  return (
    pathname === "/workspace/conversations" ||
    /^\/workspace\/conversations\/[^/]+$/.test(pathname) ||
    pathname === "/studio/agents"
  );
}
