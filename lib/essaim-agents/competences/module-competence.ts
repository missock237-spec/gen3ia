/**
 * Les Modules de Compétence — Swarm Skill Injection, volet format.
 *
 * Un micro-agent développé par un utilisateur (calcul financier,
 * parsing de code, formatage spécifique…) est converti en module de
 * code LÉGER : un objet JSON déclaratif + une fonction `executer` en
 * source. Le module voyage sous forme de paquet d'ondes exécutable
 * (fragments base64 reassemblés à l'arrivée), est vérifié par son
 * empreinte SHA-256, puis installé dans le registre du nœud et
 * exécutable IMMÉDIATEMENT dans le bac à sable — sans aucune mise à
 * jour serveur.
 *
 * Règles d'honnêteté du format :
 *  · ≤ 32 Ko de code (plafond BORNES_AGENTS.tailleCompetence) ;
 *  · une fonction d'entrée unique `executer(entree, memoire, journal)`;
 *  · empreinte SHA-256 du code complet — l'intégrité juge avant
 *    toute installation, un fragment perdu invalide tout le module ;
 *  · le bac à sable (bac-a-sable.ts) est la SEULE porte d'exécution.
 */

import type { MetaCompetence } from "../types";
import { BORNES_AGENTS } from "../types";

/** Un module de compétence complet (avant fragmentation). */
export interface ModuleCompetence {
  id: string;
  nom: string;
  description: string;
  version: number;
  /** Code source de la fonction executer (corps de fonction). */
  code: string;
  /** Empreinte SHA-256 hex du code complet. */
  empreinte: string;
  emetteur: string;
  ts: number;
}

export class ErreurModule extends Error {}

/** Empreinte SHA-256 (hex) via WebCrypto — Node 20 et navigateurs. */
export async function empreinteSha256(texte: string): Promise<string> {
  const donnees = new TextEncoder().encode(texte);
  const digeste = await crypto.subtle.digest("SHA-256", donnees as unknown as BufferSource);
  return [...new Uint8Array(digeste)].map((o) => o.toString(16).padStart(2, "0")).join("");
}

/** Motifs interdits dans un module (premier filtre, cf. bac-a-sable). */
const MOTIFS_INTERDITS: Array<[string, RegExp]> = [
  ["import dynamique", /\bimport\s*\(|\bimport\s+"/],
  ["require", /\brequire\s*\(/],
  ["eval", /\beval\s*\(/],
  ["Function", /\bnew\s+Function\b/],
  ["réseau", /\b(fetch|XMLHttpRequest|WebSocket|importScripts)\b/],
  ["DOM/navigateur", /\b(document|window|globalThis|localStorage|sessionStorage|indexedDB)\b/],
  ["processus", /\b(process|Worker|SharedWorker)\b/],
  ["prototypes", /\b(__proto__|prototype\s*=|constructor\s*=)\b/],
];

/** Valide et finalise un module : plafonds + empreinte. */
export async function creerModule(
  proposition: { id: string; nom: string; description: string; code: string; emetteur: string },
): Promise<ModuleCompetence> {
  const id = proposition.id.trim().slice(0, 64);
  const nom = proposition.nom.trim().slice(0, 80);
  if (!/^[a-z0-9-]{2,64}$/.test(id)) {
    throw new ErreurModule("Identifiant de compétence invalide (lettres minuscules, chiffres, tirets).");
  }
  if (!nom) throw new ErreurModule("Nom de compétence obligatoire.");
  const code = proposition.code;
  if (!code.trim()) throw new ErreurModule("Code vide : un module sans executer n'est pas une compétence.");
  if (code.length > BORNES_AGENTS.tailleCompetence) {
    throw new ErreurModule(
      `Module trop lourd (${code.length} o > ${BORNES_AGENTS.tailleCompetence} o) — découpez-le en plusieurs compétences.`,
    );
  }
  for (const [motif, regex] of MOTIFS_INTERDITS) {
    if (regex.test(code)) {
      throw new ErreurModule(`Motif interdit détecté (${motif}) — le bac à sable refuse ce module.`);
    }
  }
  // Le code doit définir executer.
  if (!/\bexecuter\b/.test(code)) {
    throw new ErreurModule("Le module doit définir une fonction « executer ».");
  }

  return {
    id,
    nom,
    description: proposition.description.trim().slice(0, 200),
    version: 1,
    code,
    empreinte: await empreinteSha256(code),
    emetteur: proposition.emetteur,
    ts: Date.now(),
  };
}

/** Métadonnées transportées avec les fragments (fragment 0). */
export function metaDeModule(module: ModuleCompetence, total: number): MetaCompetence {
  return {
    id: module.id,
    nom: module.nom,
    description: module.description,
    total,
    empreinte: module.empreinte,
    taille: module.code.length,
    emetteur: module.emetteur,
    ts: module.ts,
  };
}

/** Fragmente le code en tranches base64 transportables par onde. */
export function fragmenterModule(
  code: string,
  tailleFragment = BORNES_AGENTS.tailleFragmentCompetence,
): { morceaux: string[]; total: number } {
  const octets = new TextEncoder().encode(code);
  let binaire = "";
  for (let i = 0; i < octets.length; i++) binaire += String.fromCharCode(octets[i]);
  const base64 = btoa(binaire);
  const morceaux: string[] = [];
  for (let i = 0; i < base64.length; i += tailleFragment) {
    morceaux.push(base64.slice(i, i + tailleFragment));
  }
  return { morceaux: morceaux.length ? morceaux : [""], total: morceaux.length || 1 };
}

/** Reassemble des fragments base64 (index → tranche) en code source. */
export function reassemblerModule(morceaux: Map<number, string>, total: number): string {
  if (morceaux.size < total) {
    throw new ErreurModule(`Module incomplet : ${morceaux.size}/${total} fragment(s) reçu(s).`);
  }
  let base64 = "";
  for (let i = 0; i < total; i++) {
    const morceau = morceaux.get(i);
    if (morceau === undefined) throw new ErreurModule(`Fragment ${i} manquant.`);
    base64 += morceau;
  }
  const binaire = atob(base64);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return new TextDecoder().decode(octets);
}

/** Vérifie l'intégrité d'un module reassemblé contre ses méta. */
export async function verifierIntegrite(code: string, meta: MetaCompetence): Promise<void> {
  if (code.length !== meta.taille) {
    throw new ErreurModule(`Taille incohérente (${code.length} o ≠ ${meta.taille} o attendus).`);
  }
  const empreinte = await empreinteSha256(code);
  if (empreinte !== meta.empreinte) {
    throw new ErreurModule("Empreinte SHA-256 invalide — module corrompu ou altéré, installation refusée.");
  }
}
