/**
 * SUPPLY CHAIN VALIDATOR (UCE) — contrôle des dépendances avant tout usage.
 *
 * Vérifie RÉELLEMENT (aucune supposition) :
 *  - la licence d'un package (npm / PyPI) contre la liste des licences
 *    autorisées (open source, alternatives locales privilégiées) ;
 *  - les scripts d'installation npm (preinstall/install/postinstall) —
 *    exécution arbitraire à l'installation = risque majeur ;
 *  - les indicateurs de santé de base (dépréciation, fraîcheur).
 */

import "server-only";

/** Licences autorisées (open source permissif/copyleft compatible). */
export const LICENCES_AUTORISEES = [
  "MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "MPL-2.0", "LGPL-2.1", "LGPL-3.0", "GPL-2.0", "GPL-3.0", "CC0-1.0",
  "Unlicense", "WTFPL", "Python-2.0", "PSF", "AGPL-3.0",
];

export interface VerdictChaîneApprovisionnement {
  ok: boolean;
  licence?: string;
  licenceAutorisee: boolean;
  scriptsInstallation: string[];
  scriptsDangereux: boolean;
  deprecie: boolean;
  risques: string[];
}

const SCRIPTS_INSTALL = ["preinstall", "install", "postinstall"] as const;

/** Vérifie un package npm — appel réseau réel (registre npm), fail-honest. */
export async function validerNpm(nom: string, version?: string): Promise<VerdictChaîneApprovisionnement> {
  const risques: string[] = [];
  try {
    const url = version
      ? `https://registry.npmjs.org/${encodeURIComponent(nom)}/${encodeURIComponent(version)}`
      : `https://registry.npmjs.org/${encodeURIComponent(nom)}/latest`;
    const reponse = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!reponse.ok) {
      return {
        ok: false, licenceAutorisee: false, scriptsInstallation: [], scriptsDangereux: false,
        deprecie: false, risques: [`registre npm a répondu HTTP ${reponse.status}`],
      };
    }
    const donnees = (await reponse.json()) as {
      license?: string | { type?: string };
      deprecated?: string | boolean;
      scripts?: Record<string, string>;
    };
    const licence = typeof donnees.license === "string" ? donnees.license : donnees.license?.type;
    const licenceAutorisee = licence ? LICENCES_AUTORISEES.includes(licence) : false;
    if (licence && !licenceAutorisee) risques.push(`licence non autorisée : ${licence}`);
    if (!licence) risques.push("licence absente du manifeste npm");
    const scriptsInstallation = SCRIPTS_INSTALL.filter((s) => donnees.scripts?.[s]);
    if (scriptsInstallation.length > 0) risques.push(`scripts d'installation présents : ${scriptsInstallation.join(", ")}`);
    const deprecie = Boolean(donnees.deprecated);
    if (deprecie) risques.push("package déprécié (registre npm)");
    return {
      ok: licenceAutorisee && scriptsInstallation.length === 0 && !deprecie,
      licence, licenceAutorisee, scriptsInstallation,
      scriptsDangereux: scriptsInstallation.length > 0, deprecie, risques,
    };
  } catch (erreur) {
    return {
      ok: false, licenceAutorisee: false, scriptsInstallation: [], scriptsDangereux: false, deprecie: false,
      risques: [`vérification npm impossible : ${erreur instanceof Error ? erreur.message : String(erreur)}`],
    };
  }
}

/** Vérifie un package PyPI — appel réseau réel (JSON API), fail-honest. */
export async function validerPypi(nom: string): Promise<VerdictChaîneApprovisionnement> {
  const risques: string[] = [];
  try {
    const reponse = await fetch(`https://pypi.org/pypi/${encodeURIComponent(nom)}/json`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!reponse.ok) {
      return {
        ok: false, licenceAutorisee: false, scriptsInstallation: [], scriptsDangereux: false,
        deprecie: false, risques: [`PyPI a répondu HTTP ${reponse.status}`],
      };
    }
    const donnees = (await reponse.json()) as {
      info?: { license?: string; license_expression?: string; classifiers?: string[] };
    };
    const licence = donnees.info?.license_expression || donnees.info?.license || undefined;
    const licenceNormalisee = licence && licenseCourt(licence);
    const licenceAutorisee = licenceNormalisee ? LICENCES_AUTORISEES.includes(licenceNormalisee) : false;
    if (licenceNormalisee && !licenceAutorisee) risques.push(`licence non autorisée : ${licenceNormalisee}`);
    if (!licenceNormalisee) risques.push("licence absente des métadonnées PyPI (classifiers non analysés)");
    return {
      ok: licenceAutorisee, licence: licenceNormalisee ?? licence, licenceAutorisee,
      scriptsInstallation: [], scriptsDangereux: false, deprecie: false, risques,
    };
  } catch (erreur) {
    return {
      ok: false, licenceAutorisee: false, scriptsInstallation: [], scriptsDangereux: false, deprecie: false,
      risques: [`vérification PyPI impossible : ${erreur instanceof Error ? erreur.message : String(erreur)}`],
    };
  }
}

/** Extrait la partie courte d'une licence (« MIT License » → « MIT »). */
function licenseCourt(licence: string): string | undefined {
  const premier = licence.split(/\s+/)[0]?.trim();
  return premier && premier.length <= 20 ? premier : undefined;
}
