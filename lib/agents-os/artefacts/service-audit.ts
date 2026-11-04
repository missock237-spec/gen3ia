import "server-only";

import { validerJson } from "./valideurs/json";
import { validerYaml, validerDockerCompose } from "./valideurs/yaml";
import { validerJavascript, validerTypescript } from "./valideurs/javascript";
import { validerNginx } from "./valideurs/nginx";
import type { ResultatValidation, TypeArtefact, Validateur } from "./valideurs/contrat";
import { reparer, maxPasses } from "./reparateur";

/**
 * AGENTS-OS — SERVICE DROP-AND-FIX (Module 3 : audit & correction 1 clic).
 *
 * Orchestration honnête et bornée :
 *   1. VALIDATION native du contenu (parseur du type, localisation exacte) ;
 *   2. si invalide : RÉPARATION déterministe (passes structurelles) ;
 *   3. REVALIDATION du contenu corrigé — le fichier restitué est TOUJOURS
 *      revalidé (max MAX_PASSES boucles) ;
 *   4. si des erreurs subsistent : elles sont retournées telles quelles —
 *      AUCUNE réparation simulée, l'honnêteté prime sur le taux de succès.
 */

const VALIDATEURS: Partial<Record<TypeArtefact, Validateur>> = {
  json: validerJson,
  yaml: validerYaml,
  "docker-compose": validerDockerCompose,
  nginx: validerNginx,
};

const VALIDATEURS_ASYNC: Partial<Record<TypeArtefact, (contenu: string) => Promise<ResultatValidation>>> = {
  javascript: async (c) => validerJavascript(c),
  typescript: async (c) => await validerTypescript(c),
};

export const TYPES_ARTEFACTS: readonly TypeArtefact[] = [
  "json",
  "yaml",
  "docker-compose",
  "nginx",
  "javascript",
  "typescript",
];

export function estTypeArtefact(type: string): type is TypeArtefact {
  return (TYPES_ARTEFACTS as readonly string[]).includes(type);
}

export interface DemandeAudit {
  readonly type: TypeArtefact;
  readonly contenu: string;
}

export interface RapportAudit {
  readonly type: TypeArtefact;
  /** Le contenu INITIAL était-il valide ? */
  readonly valideAuDepart: boolean;
  /** Erreurs initiales localisées. */
  readonly erreursInitiales: readonly { ligne: number; colonne: number; message: string }[];
  /** Réparations appliquées (structurelles, journalisées). */
  readonly reparations: readonly { ligne: number; passe: string; avant: string; apres: string }[];
  /** Contenu corrigé (identique à l'entrée si rien à réparer). */
  readonly fichierCorrige: string;
  /** Le contenu corrigé est-il valide ? */
  readonly valideApres: boolean;
  /** Erreurs restantes APRÈS réparation (si la réparation n'a pas suffi). */
  readonly erreursRestantes: readonly { ligne: number; colonne: number; message: string }[];
  /** Nombre de boucles réparation/revalidation réellement exécutées. */
  readonly passesExecutees: number;
}

/** Limite de taille du contenu audité (octets UTF-8, défaut 1 Mo). */
const TAILLE_MAX = 1_000_000;

export function tailleMaxArtefact(): number {
  return TAILLE_MAX;
}

/** Audit complet : valider → réparer → revalider. Ne lève JAMAIS. */
export async function auditerArtefact(demande: DemandeAudit): Promise<RapportAudit> {
  const { type, contenu } = demande;

  if (Buffer.byteLength(contenu, "utf8") > TAILLE_MAX) {
    throw new Error(`contenu dépasse ${TAILLE_MAX} octets`);
  }

  // 1. Validation initiale (sync ou async selon le type).
  const validationInitiale = await valider(type, contenu);
  const erreursInitiales = validationInitiale.erreurs.map((e) => ({ ligne: e.ligne, colonne: e.colonne, message: e.message }));

  if (validationInitiale.valide) {
    return {
      type,
      valideAuDepart: true,
      erreursInitiales: [],
      reparations: [],
      fichierCorrige: contenu,
      valideApres: true,
      erreursRestantes: [],
      passesExecutees: 0,
    };
  }

  // 2-4. Boucle réparation → revalidation (bornée, honest-stop).
  let courant = contenu;
  const toutesReparations: RapportAudit["reparations"][number][] = [];
  let passes = 0;

  for (let i = 0; i < maxPasses(); i++) {
    const { contenu: corrige, reparations } = reparer(courant, type);
    if (reparations.length === 0 || corrige === courant) break; // stabilisé
    passes++;
    courant = corrige;
    toutesReparations.push(...reparations);

    const revalidation = await valider(type, courant);
    if (revalidation.valide) break;
  }

  const revalidationFinale = await valider(type, courant);

  return {
    type,
    valideAuDepart: false,
    erreursInitiales,
    reparations: toutesReparations,
    fichierCorrige: courant,
    valideApres: revalidationFinale.valide,
    erreursRestantes: revalidationFinale.erreurs.map((e) => ({ ligne: e.ligne, colonne: e.colonne, message: e.message })),
    passesExecutees: passes,
  };
}

async function valider(type: TypeArtefact, contenu: string): Promise<ResultatValidation> {
  const sync = VALIDATEURS[type];
  if (sync) return sync(contenu);
  const async_ = VALIDATEURS_ASYNC[type];
  if (async_) return await async_(contenu);
  return { valide: false, erreurs: [{ ligne: 0, colonne: 0, message: `type « ${type} » sans validateur` }] };
}
