/**
 * CONTRAT PARTAGÉ genAPI — consommé par les routes admin et les pages
 * (sous-agent 2-b) ainsi que par le socle (sous-agent 2-a). À RESPECTER
 * À LA LETTRE : toute évolution passe par une coordination des deux côtés.
 */

/** Client SaaS genAPI tel que stocké dans la collection `genapiClients`. */
export interface ClientGenAPI {
  uid: string;
  email: string;
  /** Empreinte SHA-256 du certificat client (hex, sans deux-points) — SEULE donnée cryptographique stockée. */
  empreinte: string;
  statut: "actif" | "revoque";
  creeA: string; // ISO
  revoqueA?: string; // ISO
}

/** Résultat d'un provisionnement (ré-émission possible : remplace l'empreinte). */
export interface ResultatProvisionnement {
  ok: boolean;
  empreinte?: string;
  /** Jeton d'usage unique (base64url) — l'URL de téléchargement est /api/admin/genapi/paquets/{jeton}. */
  jetonTelechargement?: string;
  expireA?: string; // ISO
  erreur?: string;
}

/** État de santé genAPI exposé à la console admin. */
export interface StatutGenAPI {
  caDisponible: boolean;
  clientsActifs: number;
  clientsTotal: number;
  executions: number;      // compteur du jour
  echecs: number;          // compteur du jour
  creditsDebitesMinor: number; // compteur du jour
  date: string; // ISO du jour compté
}

/** Entrée du journal d'audit genAPI (collection `genapiJournal`). */
export interface EntreeJournalGenAPI {
  evenement: string; // ex. "provisionnement_ok", "cle_privee_detruite", "paquet_telecharge", "execution_rpc"
  detail: string;
  a: string; // ISO
}
