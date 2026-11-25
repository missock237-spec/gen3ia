/**
 * CODE VALIDATOR (UCE) — vérification INDÉPENDANTE que du code fonctionne :
 * exécution réelle en sandbox isolée (réseau NONE, heap/timeout bornés).
 * Un code qui « devrait marcher » n'est pas un code validé.
 */

import "server-only";

import { executerEnSandboxUce } from "../security/sandbox-manager";

export interface VerdictCode {
  verifie: boolean;
  ok: boolean;
  dureeMs: number;
  journaux: string[];
  cause?: string;
}

/**
 * Exécute le script en sandbox Node. Le script doit produire son résultat
 * via `emettre(...)` ou `return` dans une IIFE ; `verificationAttendue`
 * précise la valeur booléenne attendue (ex. résultat de tests embarqués).
 */
export async function verifierCodeFonctionne(
  executionId: string,
  script: string,
  attendu: { valeurVerite?: unknown } = {},
): Promise<VerdictCode> {
  const resultat = await executerEnSandboxUce(executionId, "systeme-uce", script);
  if (!resultat.ok) {
    return { verifie: true, ok: false, dureeMs: resultat.dureeMs, journaux: resultat.journaux, cause: resultat.erreur ?? "sandbox a signalé un échec" };
  }
  if (attendu.valeurVerite !== undefined && resultat.resultat !== attendu.valeurVerite) {
    return {
      verifie: true, ok: false, dureeMs: resultat.dureeMs, journaux: resultat.journaux,
      cause: `résultat sandbox « ${JSON.stringify(resultat.resultat)?.slice(0, 120)} » ≠ attendu « ${JSON.stringify(attendu.valeurVerite)} »`,
    };
  }
  return { verifie: true, ok: true, dureeMs: resultat.dureeMs, journaux: resultat.journaux };
}
