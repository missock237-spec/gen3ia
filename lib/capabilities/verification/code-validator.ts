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
  // Valeur comparée : si la sandbox a émis un objet avec un champ ok
  // (convention emettre({ok, resultat})), on compare son champ `resultat` ;
  // sinon la valeur émise elle-même.
  const emise = resultat.resultat;
  const valeurComparee = emise !== null && typeof emise === "object" && "ok" in (emise as Record<string, unknown>)
    ? (emise as { resultat?: unknown }).resultat
    : emise;
  if (attendu.valeurVerite !== undefined && valeurComparee !== attendu.valeurVerite) {
    return {
      verifie: true, ok: false, dureeMs: resultat.dureeMs, journaux: resultat.journaux,
      cause: `résultat sandbox « ${JSON.stringify(valeurComparee)?.slice(0, 120)} » ≠ attendu « ${JSON.stringify(attendu.valeurVerite)} »`,
    };
  }
  // Un objet émis avec ok:false est un échec métier même si le process a tourné.
  const echecMetier = emise !== null && typeof emise === "object" && (emise as { ok?: unknown }).ok === false;
  if (echecMetier) {
    return { verifie: true, ok: false, dureeMs: resultat.dureeMs, journaux: resultat.journaux, cause: "la sandbox a émis ok:false (échec métier)" };
  }
  return { verifie: true, ok: true, dureeMs: resultat.dureeMs, journaux: resultat.journaux };
}
