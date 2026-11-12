/**
 * URL MÉDIA DURABLE — le remède à « l'audio/la vidéo n'est pas réellement
 * envoyé dans la conversation ».
 *
 * CONSTAT PRODUCTION (demande propriétaire 2026-11-12) : les messages de
 * livraison voix/vidéo embarquent des URL présignées R2 — TTL 3 600 s pour
 * l'audio (lib/media/persist.ts SIGNED_URL_TTL_S) et 900 s pour le master
 * vidéo (lib/video/production-delivery.ts). Passé ce délai (ou après un
 * rechargement de page qui relit le message PERSISTÉ), le lien meurt
 * (AccessDenied) : pour l'utilisateur, le média « n'a jamais été créé ni
 * envoyé » alors que l'objet R2 est bien là, permanent.
 *
 * REMÈDE : une URL CANONIQUE de l'app qui résout la clé permanente en URL
 * signée FRAÎCHE à chaque résolution — le message persisté reste donc
 * jouable pour toujours. Le chemin `/api/media/durable?path=…` est :
 *  - authentifié (protectRoute — cookie de session) ;
 *  - borné au stockage PERMANENT du propriétaire (préfixe
 *    `users/<uid>/permanent/` vérifié ICI puis re-validé par
 *    createPermanentDownloadUrl → isOwnedPermanentKey) ;
 *  - une redirection 302 vers l'URL signée — jouable par <audio src>,
 *    <video src> et téléchargeable au clic.
 *
 * La clé est la SEULE entrée : jamais une URL d'appelant (anti SSRF /
 * anti falsification — même règle que l'origine canonique des ticks).
 */

import { resolveJobOrigin } from "@/lib/queue/origin";

/** Préfixe des clés de stockage permanentes propriétaires. */
const PREFIXE_PERMANENT = "/permanent/";

/** Préfixe des clés vidéo propriétaires (masters/exports du pipeline). */
const PREFIXE_VIDEO = "/video/";

/**
 * Clé MÉDIA résolvable par la route durable — permanente OU vidéo — du
 * propriétaire ? Pur, testable :
 *  - `users/<uid>/permanent/…` (voix, images, audios WebGPU…) ;
 *  - `users/<uid>/video/…` (masters et exports vidéo du pipeline).
 * Aucune autre forme n'est résoluble : la route ne signe QUE ces familles.
 */
export function estCleMediaProprietaire(cle: unknown, userId: string): cle is string {
  if (typeof cle !== "string" || cle.length === 0 || cle.length > 600) return false;
  return (
    cle.startsWith(`users/${userId}${PREFIXE_PERMANENT}`) ||
    cle.startsWith(`users/${userId}${PREFIXE_VIDEO}`)
  );
}

/** Alias historique du premier verrou (permanentes seules). */
export function estClePermanenteProprietaire(cle: unknown, userId: string): cle is string {
  return typeof cle === "string" && cle.startsWith(`users/${userId}${PREFIXE_PERMANENT}`);
}

/**
 * URL durable RELATIVE (client même origine — lecteurs <audio>/<video> et
 * cartes : le cookie de session part automatiquement). `null` si la clé
 * n'est pas une clé média résolvable — l'appelant garde alors son URL
 * présignée d'origine (jamais de perte).
 */
export function urlDurableRelative(cle: unknown): string | null {
  if (typeof cle !== "string" || !cle.startsWith("users/")) return null;
  if (!cle.includes(PREFIXE_PERMANENT) && !cle.includes(PREFIXE_VIDEO)) return null;
  if (cle.includes("..")) return null;
  return `/api/media/durable?path=${encodeURIComponent(cle)}`;
}

/**
 * URL durable ABSOLUE (contenu des messages PERSISTÉS : le lien du texte
 * doit rester cliquable hors de l'app). Origine canonique serveur
 * (GEN3IA_APP_ORIGIN via resolveJobOrigin — JAMAIS l'origine requête).
 * `null` si origine non résolue : l'appelant garde son URL présignée.
 */
export function urlDurableAbsolue(cle: unknown): string | null {
  const relative = urlDurableRelative(cle);
  if (!relative) return null;
  const origine = resolveJobOrigin();
  return origine.ok && typeof origine.origin === "string" ? origine.origin + relative : null;
}
