import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { modeleFourniDepuisContenu, type ModeleFourni } from "@/lib/training/adaptateurs-ia";
import type { NiveauEntrainement } from "@/lib/training/cles-entrainement";

/**
 * REGISTRE DES MODÈLES ENTRAÎNÉS — la mémoire du studio d'entraînement.
 *
 * Un modèle formé par les adaptateurs gen3 (cortex, tenseur, onde) n'a de
 * valeur que s'il SURVIT à la session : ce registre sauvegarde son EXPORT
 * COMPLET (poids + architecture + labels, état du cortex, nœuds d'onde)
 * avec son rapport de banc de test, son propriétaire et le niveau de clé
 * qui l'a formé. La restauration passe par `modeleFourniDepuisContenu` — un
 * modèle chargé revient EXACTEMENT à l'état où l'entraînement l'a laissé
 * (vérifié par des tests aller-retour) et peut être re-testé, re-présenté
 * au monde virtuel ou ré-entraîné.
 *
 * Stockage FICHIERS réel (var/training/modeles/<id>.json, écriture
 * atomique), racine injectable pour les tests. Propriété stricte : charger
 * ou supprimer le modèle d'un AUTRE compte refuse.
 */

/** Plafond de taille d'un export sauvegardé (4 Mo — garde honnête). */
export const MAX_OCTETS_MODELE = 4_000_000;

export interface BancReference {
  score: number;
  seuil: number;
  verdict: "conforme" | "insuffisant";
  evaluationEchantillon?: "train" | "test";
}

export interface ModeleEnregistre {
  id: string;
  nom: string;
  famille: string;
  userId: string;
  /** Niveau de la clé d'entraînement qui a formé ce modèle (traçabilité). */
  niveauCle: NiveauEntrainement;
  enregistreLe: string;
  format: string;
  /** Export complet de l'adaptateur — restaurable à l'identique. */
  contenu: string;
  octets: number;
  /** Rapport du banc de test interne au moment de la sauvegarde (null = politique du monde). */
  banc: BancReference | null;
  description?: string;
}

export interface EntrepotModeles {
  lire(id: string): Promise<ModeleEnregistre | null>;
  ecrire(doc: ModeleEnregistre): Promise<void>;
  supprimer(id: string): Promise<boolean>;
  lister(userId: string): Promise<ModeleEnregistre[]>;
}

/** Entrepôt FICHIERS réel (var/training/modeles/, écriture atomique). */
export function creerEntrepotModelesFichiers(racine: string): EntrepotModeles {
  const fichier = (id: string) => join(racine, `${id}.json`);
  return {
    async lire(id) {
      try {
        return JSON.parse(readFileSync(fichier(id), "utf-8")) as ModeleEnregistre;
      } catch {
        return null;
      }
    },
    async ecrire(doc) {
      mkdirSync(racine, { recursive: true });
      const tmp = `${fichier(doc.id)}.tmp`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf-8");
      renameSync(tmp, fichier(doc.id));
    },
    async supprimer(id) {
      try {
        unlinkSync(fichier(id));
        return true;
      } catch {
        return false;
      }
    },
    async lister(userId) {
      let noms: string[] = [];
      try {
        noms = readdirSync(racine);
      } catch {
        return [];
      }
      const docs: ModeleEnregistre[] = [];
      for (const nom of noms.filter((n) => n.endsWith(".json"))) {
        try {
          const doc = JSON.parse(readFileSync(join(racine, nom), "utf-8")) as ModeleEnregistre;
          if (doc.userId === userId) docs.push(doc);
        } catch {
          /* fichier corrompu : ignoré honnêtement */
        }
      }
      return docs.sort((a, b) => a.enregistreLe.localeCompare(b.enregistreLe));
    },
  };
}

const RACINE_DEFAUT = join(process.cwd(), "var", "training", "modeles");
let entrepotActif: EntrepotModeles = creerEntrepotModelesFichiers(RACINE_DEFAUT);

/** Point d'injection (tests, déploiements alternatifs) — le défaut reste fichiers. */
export function definirEntrepotModeles(entrepot: EntrepotModeles): void {
  entrepotActif = entrepot;
}

export interface ResultatSauvegarde {
  id: string;
  nom: string;
  famille: string;
  octets: number;
  banc: BancReference | null;
}

/** Sauvegarde un modèle entraîné (export complet + traçabilité). */
export async function sauverModeleEntraîne(params: {
  userId: string;
  nom: string;
  famille: string;
  contenu: string;
  format: string;
  banc: BancReference | null;
  niveauCle: NiveauEntrainement;
  description?: string;
}): Promise<ResultatSauvegarde> {
  if (!params.userId?.trim()) throw new Error("Sauvegarde : userId requis.");
  const nom = params.nom.trim();
  if (!nom || nom.length > 80) throw new Error("Sauvegarde : nom requis (1-80 caractères).");
  const octets = Buffer.byteLength(params.contenu, "utf-8");
  if (octets === 0) throw new Error("Sauvegarde : contenu vide — entraîner le modèle avant de l'enregistrer.");
  if (octets > MAX_OCTETS_MODELE) {
    throw new Error(`Sauvegarde refusée : export de ${octets} octets > plafond ${MAX_OCTETS_MODELE} (réduire le modèle).`);
  }
  const id = `mdl-${createHash("sha256").update(`${params.userId}|${nom}|${Date.now()}|${randomBytes(8).toString("hex")}`).digest("hex").slice(0, 16)}`;
  const doc: ModeleEnregistre = {
    id,
    nom,
    famille: params.famille,
    userId: params.userId,
    niveauCle: params.niveauCle,
    enregistreLe: new Date().toISOString(),
    format: params.format,
    contenu: params.contenu,
    octets,
    banc: params.banc,
    description: params.description?.trim() || undefined,
  };
  await entrepotActif.ecrire(doc);
  return { id, nom, famille: doc.famille, octets, banc: doc.banc };
}

/** Charge un modèle du PROPRIÉTAIRE uniquement (sinon null). */
export async function chargerModeleEntraîne(userId: string, id: string): Promise<ModeleEnregistre | null> {
  if (!id?.startsWith("mdl-")) return null;
  const doc = await entrepotActif.lire(id);
  if (!doc || doc.userId !== userId) return null;
  return doc;
}

/** Liste SANS le contenu (aperçus légers pour l'UI/le chat). */
export async function listerModelesEntraînés(userId: string): Promise<
  Array<Omit<ModeleEnregistre, "contenu"> & { apercu: string }>
> {
  const docs = await entrepotActif.lister(userId);
  return docs.map(({ contenu, ...reste }) => ({
    ...reste,
    apercu: contenu.slice(0, 160),
  }));
}

export async function supprimerModeleEntraîne(userId: string, id: string): Promise<boolean> {
  const doc = await entrepotActif.lire(id);
  if (!doc || doc.userId !== userId) return false;
  return entrepotActif.supprimer(id);
}

/** Reconstruit le descripteur prêt à passer à adapterPour / aux outils. */
export function adapterDepuisModeleEntraîne(doc: ModeleEnregistre, graine?: number): ModeleFourni {
  return modeleFourniDepuisContenu(doc.contenu, graine);
}
