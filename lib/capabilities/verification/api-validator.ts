/**
 * API VALIDATOR (UCE) — vérification INDÉPENDANTE qu'une API a réellement
 * répondu correctement (jamais fiduciaire : on refait l'appel de contrôle).
 *
 * Toute URL passe par le garde SSRF du dépôt (assertPublicHttpUrl) : DNS
 * résolu, IP privées/loopback/metadata bloquées — le vérificateur ne peut
 * pas servir de sonde interne.
 */

import "server-only";

import { assertPublicHttpUrl } from "@/lib/security/url-safety";

export interface VerdictApi {
  verifie: boolean;
  httpStatut?: number;
  latenceMs: number;
  contenuLongueur?: number;
  cause?: string;
}

/**
 * Appel de contrôle GET réel (timeout court) : l'API a-t-elle répondu
 * HTTP < 400 avec un corps non vide ? Aucun secret n'est envoyé.
 */
export async function verifierApiRepond(url: string, attendu: { contient?: string; statutMax?: number } = {}): Promise<VerdictApi> {
  const debut = Date.now();
  let urlPublique: URL;
  try {
    urlPublique = await assertPublicHttpUrl(url);
  } catch (erreur) {
    return { verifie: false, latenceMs: Date.now() - debut, cause: `URL refusée par le garde SSRF : ${erreur instanceof Error ? erreur.message : String(erreur)}` };
  }
  try {
    const reponse = await fetch(urlPublique, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
    const statutMax = attendu.statutMax ?? 399;
    const texte = await reponse.text();
    const verifie = reponse.status <= statutMax && texte.length > 0 && (!attendu.contient || texte.includes(attendu.contient));
    return {
      verifie,
      httpStatut: reponse.status,
      latenceMs: Date.now() - debut,
      contenuLongueur: texte.length,
      cause: verifie ? undefined : `réponse non conforme (statut ${reponse.status}, corps ${texte.length} octets${attendu.contient ? ", marqueur absent" : ""})`,
    };
  } catch (erreur) {
    return { verifie: false, latenceMs: Date.now() - debut, cause: `appel réel échoué : ${erreur instanceof Error ? erreur.message : String(erreur)}` };
  }
}
