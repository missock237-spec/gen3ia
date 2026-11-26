/**
 * ICE CONFIG — serveurs STUN/TURN depuis l'environnement (mission LOT 2
 * : « Configurer STUN », « Configurer TURN pour les réseaux restrictifs »).
 * HONNÊTETÉ : les variables GEN3IA_LIVE_STUN_URL / GEN3IA_LIVE_TURN_URL /
 * GEN3IA_LIVE_TURN_USERNAME / GEN3IA_LIVE_TURN_PASSWORD sont la CONFIG CIBLE
 * (mission Phase 14) ; sans TURN configuré, les NAT symétriques échoueront
 * — limite documentée, jamais masquée. Aucun service TURN par défaut n'est
 * inventé : un TURN sans identifiants réels serait un faux succès.
 */

export interface ConfigIce {
  stunUrls: string[];
  turnUrls: string[];
  turnUsername?: string;
  turnPassword?: string;
  /** true seulement si un TURN complet (urls + identifiants) est configuré. */
  turnPret: boolean;
  avertissement?: string;
}

export function lireConfigIce(env: Record<string, string | undefined> = process.env): ConfigIce {
  const stunUrls = (env.GEN3IA_LIVE_STUN_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUrls = (env.GEN3IA_LIVE_TURN_URL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUsername = env.GEN3IA_LIVE_TURN_USERNAME;
  const turnPassword = env.GEN3IA_LIVE_TURN_PASSWORD;
  const turnPret = turnUrls.length > 0 && Boolean(turnUsername) && Boolean(turnPassword);
  const avertissement = turnPret
    ? undefined
    : "TURN non configuré (GEN3IA_LIVE_TURN_URL + identifiants requis) : les connexions derrière NAT symétrique / pare-feu strict échoueront — limite documentée, mission LOT 2";
  return { stunUrls, turnUrls, turnUsername, turnPassword, turnPret, avertissement };
}

/** Liste RTCIceServer prête pour RTCPeerConnection (webrtc-manager). */
export function listeIceServers(env: Record<string, string | undefined> = process.env): RTCIceServer[] {
  const c = lireConfigIce(env);
  const serveurs: RTCIceServer[] = c.stunUrls.map((urls) => ({ urls }));
  if (c.turnPret) {
    serveurs.push({ urls: c.turnUrls, username: c.turnUsername, credential: c.turnPassword });
  }
  return serveurs;
}
