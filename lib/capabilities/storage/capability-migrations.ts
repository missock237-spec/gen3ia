/**
 * MIGRATIONS UCE — évolution versionnée des enregistrements persistés.
 *
 * Chaque enregistrement porte `schemaVersion`. Une migration est une
 * fonction PURE (enregistrement avant → enregistrement après) appliquée en
 * chaîne jusqu'à la version courante — réversible par conception (les
 * migrations ne détruisent jamais de champ, elles en ajoutent/renomment).
 */

import { CAPABILITY_SCHEMA_VERSION } from "../core/capability-contract";

export interface EnregistrementBrut {
  schemaVersion?: number;
  [cle: string]: unknown;
}

type Migration = (rec: EnregistrementBrut) => EnregistrementBrut;

/**
 * Chaîne de migrations par pas de version : migration_v1_v2, v2_v3…
 * À la création V1 : la liste est vide — les futures versions s'ajoutent ici
 * (jamais en réécrivant le passé).
 */
const MIGRATIONS: Array<{ depuis: number; vers: number; nom: string; appliquer: Migration }> = [
  // Exemple de format pour V2 (à compléter, ne JAMAIS retirer) :
  // { depuis: 1, vers: 2, nom: "ajout-exigences-par-defaut",
  //   appliquer: (rec) => ({ ...rec, exigences: rec.exigences ?? {} }) },
];

export interface ResultatMigration {
  enregistrement: EnregistrementBrut;
  migrationsAppliquees: string[];
  versionCourante: number;
}

/** Applique toutes les migrations nécessaires (idempotent, pur). */
export function migrerEnregistrement(brut: EnregistrementBrut): ResultatMigration {
  let enregistrement = { ...brut };
  const appliquees: string[] = [];
  let version = typeof brut.schemaVersion === "number" ? brut.schemaVersion : 1;

  if (version < 1) version = 1;

  for (const migration of MIGRATIONS) {
    if (version === migration.depuis) {
      enregistrement = migration.appliquer(enregistrement);
      enregistrement.schemaVersion = migration.vers;
      version = migration.vers;
      appliquees.push(migration.nom);
    }
  }

  if (version > CAPABILITY_SCHEMA_VERSION) {
    // Enregistrement d'un futur écrit par une version plus récente du code :
    // on le laisse tel quel (lecture tolérante), jamais de downgrade destructif.
    return { enregistrement, migrationsAppliquees: appliquees, versionCourante: version };
  }

  return { enregistrement, migrationsAppliquees: appliquees, versionCourante: version };
}

/** Version de schéma cible actuelle (réexport court). */
export const VERSION_SCHEMA_CIBLE = CAPABILITY_SCHEMA_VERSION;
