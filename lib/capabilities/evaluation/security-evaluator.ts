/**
 * SECURITY EVALUATOR (UCE) — évaluation de sécurité d'une candidate :
 * licence réelle (registres), scripts d'installation, exigences réseau
 * douteuses, risques déclarés. Délègue npm/PyPI au supply-chain-validator
 * (aucun doublon) et ajoute le contrôle des motifs génériques.
 */

import "server-only";

import type { CapabilityDiscovery } from "../core/capability-contract";
import { LICENCES_AUTORISEES, validerNpm, validerPypi, type VerdictChaîneApprovisionnement } from "../security/supply-chain-validator";

export interface ScoresSecurite {
  /** 0-100 — licence autorisée + absence de motifs dangereux. */
  total: number;
  licenceAutorisee: boolean;
  licence?: string;
  scriptsInstallation: string[];
  motifsDangereux: string[];
  verdict: "sain" | "risque" | "dangereux";
  constats: string[];
}

const MOTIFS_NOM_DANGEREUX = [/crypto[-_]?miner/i, /keylog/i, /credential/i];

/**
 * Évaluation de sécurité locale (faits de la fiche) — synchronisée et
 * sans appel réseau (utile pour pré-filtrer avant la vérification registre).
 */
export function evaluerSecuriteLocale(fiche: CapabilityDiscovery): ScoresSecurite {
  const motifsDangereux: string[] = [];
  for (const motif of MOTIFS_NOM_DANGEREUX) {
    if (motif.test(fiche.nom)) motifsDangereux.push(`nom suspect : correspond à ${motif}`);
  }
  for (const risque of fiche.risques) {
    if (/script[s]? d'installation/i.test(risque)) motifsDangereux.push(risque);
    if (/crypto|miner|backdoor|malware/i.test(risque)) motifsDangereux.push(risque);
  }
  const licenceAutorisee = fiche.licence ? LICENCES_AUTORISEES.includes(fiche.licence) : false;
  let total = 100;
  total -= motifsDangereux.length * 40;
  if (!licenceAutorisee) total -= 30;
  total = Math.max(0, Math.min(100, total));

  return {
    total,
    licenceAutorisee,
    licence: fiche.licence,
    scriptsInstallation: motifsDangereux.some((m) => /script[s]? d'installation/i.test(m)) ? ["detectes"] : [],
    motifsDangereux,
    verdict: total >= 80 ? "sain" : total >= 40 ? "risque" : "dangereux",
    constats: [
      licenceAutorisee ? `licence autorisée : ${fiche.licence}` : fiche.licence ? `licence NON autorisée : ${fiche.licence}` : "licence absente",
      ...motifsDangereux.map((m) => `risque : ${m}`),
    ],
  };
}

/**
 * Évaluation de sécurité COMPLÈTE avec vérification réelle au registre
 * (npm/PyPI) : licences et scripts d'installation vus à l'instant.
 */
export async function evaluerSecuriteRegistre(fiche: CapabilityDiscovery): Promise<ScoresSecurite & { registre?: VerdictChaîneApprovisionnement }> {
  const locale = evaluerSecuriteLocale(fiche);
  let registre: VerdictChaîneApprovisionnement | undefined;
  if (fiche.source === "npm") registre = await validerNpm(fiche.nom, fiche.version);
  else if (fiche.source === "pypi") registre = await validerPypi(fiche.nom);

  if (registre) {
    if (!registre.licenceAutorisee) locale.total = Math.max(0, locale.total - 30);
    if (registre.deprecie) locale.total = Math.max(0, locale.total - 10);
    for (const risque of registre.risques) locale.constats.push(`registre : ${risque}`);
    locale.total = Math.min(100, locale.total);
    locale.verdict = locale.total >= 80 ? "sain" : locale.total >= 40 ? "risque" : "dangereux";
  }

  return { ...locale, registre };
}
