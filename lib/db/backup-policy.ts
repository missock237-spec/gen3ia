/**
 * POLITIQUE DE SAUVEGARDE FIRESTORE — Gen3ia (itération 23, Job 478451).
 *
 * Pourquoi ce module : jusqu'ici le projet ne sauvegardait que les RÈGLES
 * Firestore (scripts/backup_firebase_rules.mjs) — aucune stratégie pour les
 * DONNÉES (users, tasks, agents, memories, conversations…). Une perte de
 * données (suppression accidentelle de collection, bogue de migration,
 * compromission) aurait été IRRÉVERSIBLE. Le standard des grandes
 * entreprises n'est pas « on fait des backups » mais une politique
 * EXPLICITE, codifiée, avec RPO/RTO mesurés et restauration VÉRIFIÉE :
 * « une sauvegarde non testée n'est pas une sauvegarde ».
 *
 * Ce module est la source unique de vérité partagée par :
 *  - scripts/backup_firestore_data.mjs (opérateur CLI)
 *  - scripts/verify_backup_restore.mjs (vérification fraîcheur PASS/FAIL)
 *  - tests/unit/backup-policy.test.ts (garde-fou)
 *  - docs/runbooks/sauvegarde-restauration.md (procédures)
 *
 * Aucune dépendance GCP ici — calculs purs, testables unitairement.
 */

/** Objectifs de reprise (source de vérité — cf. runbook sauvegarde-restauration). */
export const BACKUP_POLICY = {
  /** Perte de données maximale acceptable (heures) — couvert par PITR 7 j + export quotidien. */
  rpoHeures: 24,
  /** Durée maximale de restauration (heures) — export GCS → import → vérif. */
  rtoHeures: 2,
  /** Rétention des exports GCS (jours). */
  retentionJours: 30,
  /** Fenêtre d'exécution quotidienne (heure Europe/Paris) — trafic minimal mesuré (docs/sre/sli-slo.md). */
  heureExecution: 3,
  /** PITR : fenêtre de récupération point-in-time (jours, plafond Firestore). */
  pitrJours: 7,
  /** Âge maximal d'un export pour être considéré « frais » (heures) = RPO + marge d'exécution. */
  fraicheurMaxHeures: 25,
} as const;

/** Collections critiques — une sauvegarde qui les ignore est incomplete. */
export const COLLECTIONS_CRITIQUES = [
  "users",
  "tasks",
  "agents",
  "memories",
  "conversations",
  "messages",
  "teams",
  "extensions",
  "installations",
  "executions",
] as const;

/** Contexte d'un export tel que renvoyé par l'API Firestore (documents:export). */
export interface ExportRecord {
  /** Nom complet de l'opération, ex. projects/p/databases/db/operations/xyz */
  name?: string;
  done?: boolean;
  response?: {
    outputUriPrefix?: string;
  };
  metadata?: {
    startTime?: string;
    endTime?: string;
    operationType?: string;
  };
  error?: unknown;
}

/**
 * Âge d'un export en heures à partir de son horodatage de début.
 * Horodatage absent ou non parsable → Infinity (jamais considéré frais :
 * fail-closed, même philosophie que le guérisseur v6).
 */
export function ageExportHeures(exportRecord: ExportRecord, maintenant: Date = new Date()): number {
  const debut = exportRecord?.metadata?.startTime;
  if (!debut) return Number.POSITIVE_INFINITY;
  const t = Date.parse(debut);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (maintenant.getTime() - t) / 3_600_000);
}

/**
 * Un export est « frais » s'il couvre le RPO : âge ≤ fraicheurMaxHeures.
 * Un export encore en cours (done !== true) n'est PAS frais tant qu'il
 * n'est pas terminé — un backup en cours ne protège de rien.
 */
export function exportEstFrais(exportRecord: ExportRecord, maintenant: Date = new Date()): boolean {
  if (exportRecord?.done !== true) return false;
  return ageExportHeures(exportRecord, maintenant) <= BACKUP_POLICY.fraicheurMaxHeures;
}

/** État de conformité consolidé d'un parc d'exports (le plus récent fait foi). */
export function conformiteBackup(
  exports: ExportRecord[],
  maintenant: Date = new Date(),
): {
  conforme: boolean;
  exportLePlusRecent: ExportRecord | null;
  ageHeures: number | null;
  raison: string;
} {
  if (!Array.isArray(exports) || exports.length === 0) {
    return {
      conforme: false,
      exportLePlusRecent: null,
      ageHeures: null,
      raison: "aucun export trouvé — la politique n'est pas mise en œuvre",
    };
  }
  const completes = exports.filter((e) => e?.done === true);
  if (completes.length === 0) {
    return {
      conforme: false,
      exportLePlusRecent: exports[0] ?? null,
      ageHeures: null,
      raison: "aucun export terminé (opérations en cours ou échouées uniquement)",
    };
  }
  let plusRecent = completes[0];
  let ageMin = Number.POSITIVE_INFINITY;
  for (const e of completes) {
    const age = ageExportHeures(e, maintenant);
    if (age < ageMin) {
      ageMin = age;
      plusRecent = e;
    }
  }
  if (ageMin <= BACKUP_POLICY.fraicheurMaxHeures) {
    return {
      conforme: true,
      exportLePlusRecent: plusRecent,
      ageHeures: ageMin,
      raison: `export le plus récent vieux de ${ageMin.toFixed(1)} h (≤ ${BACKUP_POLICY.fraicheurMaxHeures} h)`,
    };
  }
  return {
    conforme: false,
    exportLePlusRecent: plusRecent,
    ageHeures: ageMin,
    raison: `export le plus récent vieux de ${ageMin.toFixed(1)} h — dépasse la fraîcheur maximale de ${BACKUP_POLICY.fraicheurMaxHeures} h (RPO ${BACKUP_POLICY.rpoHeures} h menacé)`,
  };
}

/** Périmètre documenté de restauration — garde-fou anti-oubli pour le runbook. */
export function perimetreRestauration(): string[] {
  return [...COLLECTIONS_CRITIQUES];
}
