/**
 * Surfaces de chat « immersives » de Gen3ia.
 *
 * Sur ces routes, l'interface de discussion doit occuper TOUTE la hauteur
 * de l'appareil (100dvh) : ni barres de navigation workspace, ni fil
 * d'Ariane, ni marges — le fil défile en interne et le composer reste
 * collé en bas, à la manière d'une application de messagerie native.
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
