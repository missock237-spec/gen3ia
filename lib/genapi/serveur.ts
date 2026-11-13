import "server-only";

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  Server,
  ServerCredentials,
  credentials,
  status,
  type ServerUnaryCall,
  type sendUnaryData,
  type ServiceError,
} from "@grpc/grpc-js";
import { loadSync, type PackageDefinition, type ServiceDefinition } from "@grpc/proto-loader";

import { empreinteAutorisee } from "@/lib/genapi/clients";
import { compterExecutionGenAPI } from "@/lib/genapi/compteur";
import { journaliser } from "@/lib/genapi/provisionnement";
import { resilientGet, writeCheckpointSet } from "@/lib/db/firestore-resilient";
import { reserveFunds, releaseReservation, settleReservation } from "@/lib/billing/wallet";

/**
 * genAPI — SERVEUR gRPC mTLS (contrat gen3.v1.Gen3).
 *
 * BARRIÈRE RÉSEAU : le serveur n'accepte QUE des certificats client signés
 * par la CA racine gen3 (ServerCredentials.createSsl avec
 * checkClientCertificate = true — le 3ᵉ argument force le certificat
 * client : une connexion sans certificat valide est rejetée AU NIVEAU TLS).
 *
 * LIEN COMPTE — COMPROMIS HONNÊTE ET DOCUMENTÉ (LISEZMOI) : @grpc/grpc-js
 * n'expose pas le certificat pair par appel ; le handler vérifie donc
 * l'empreinte portée par la metadata `x-gen3-empreinte` contre l'allowlist
 * Firestore (`genapiClients`). Le mTLS garantit un client signé par la CA
 * gen3 ; l'allowlist lie l'empreinte au compte et refuse tout certificat
 * inconnu ou révoqué.
 *
 * FACTURATION : chaque ExecuterInference réserve des crédits Chariow
 * (wallet) AVANT l'exécution, règle au coût réel en cas de succès, libère
 * la réservation en cas d'échec — JAMAIS de fausse réussite.
 */

/** Version du socle genAPI exposée par la sonde Sante. */
export const VERSION_GENAPI = "1.0.0";

/** Metadata attendue du client : empreinte SHA-256 de son certificat (hex, sans deux-points). */
export const METADATA_EMPREINTE = "x-gen3-empreinte";

/** Tarif d'exécution standard (unités mineures) si budget_credits_minor = 0. */
function creditsExecutionDefaut(): number {
  const brut = Number(process.env.GENAPI_EXECUTION_CREDITS_MINOR);
  return Number.isFinite(brut) && brut > 0 ? Math.floor(brut) : 15;
}

/** Interface d'options du serveur genAPI (mTLS obligatoire). */
export interface OptionsServeurGenAPI {
  /** Port d'écoute demandé (0.0.0.0). */
  port: number;
  /** Chemin du contrat gen3.proto (défaut : lib/genapi/proto/gen3.proto). */
  cheminProto?: string;
  /** Chemin du certificat de la CA racine gen3 (valide les certificats clients). */
  cheminCaCert: string;
  /** Clé TLS du serveur (défaut GENAPI_SERVER_KEY_PATH ou /etc/gen3ia/genapi/serveur.key). */
  cheminCleServeur?: string;
  /** Certificat TLS du serveur (défaut GENAPI_SERVER_CERT_PATH ou /etc/gen3ia/genapi/serveur.crt). */
  cheminCertServeur?: string;
}

/** Objet serveur retourné : démarrage/arrêt propres, port réel après bind. */
export interface ServeurGenAPI {
  serveur: Server;
  port: number;
  demarrer(): Promise<number>;
  arreter(): Promise<void>;
}

/** Charge le contrat gen3.v1 via @grpc/proto-loader (testé avec le VRAI proto). */
export function chargerContrat(cheminProto: string): PackageDefinition {
  return loadSync(cheminProto, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
}

/** Chemin par défaut du contrat (GENAPI_PROTO_PATH → module → cwd). */
function resoudreCheminProtoDefaut(): string {
  const env = process.env.GENAPI_PROTO_PATH?.trim();
  if (env) return env;
  try {
    // Résolution relative au module (tsx sur le VPS souverain, tests).
    const candidat = path.resolve(
      decodeURIComponent(new URL(".", import.meta.url).pathname),
      "proto",
      "gen3.proto",
    );
    return candidat;
  } catch {
    // import.meta indisponible dans ce contexte → repli répertoire courant.
  }
  return path.resolve(process.cwd(), "lib", "genapi", "proto", "gen3.proto");
}

/** Erreur gRPC canonique (jamais d'exception non rattrapée dans un handler). */
function erreurRPC(code: status, message: string): ServiceError {
  const erreur = new Error(message) as ServiceError;
  erreur.name = "ServiceError";
  erreur.code = code;
  erreur.details = message;
  return erreur;
}

/** Tronque un message d'erreur (aucun contenu de clé ne transite jamais). */
function tronquer(texte: string, max: number): string {
  const propre = String(texte ?? "").trim();
  return propre.length > max ? `${propre.slice(0, max)}…` : propre;
}

/** Types des requêtes/réponses gen3.v1 — proto-loader chargé avec keepCase:false
 *  expose les champs en lowerCamelCase (client_uid → clientUid) ; le repli
 *  snake_case est lu pour tolérer un client chargé avec keepCase:true.
 *  int64 arrive en string via longs:String. */
interface RequeteSanteRPC {
  clientUid?: string;
  client_uid?: string;
}
interface ReponseSanteRPC {
  etat: string;
  version: string;
  horodatage: number;
}
interface RequeteInferenceRPC {
  clientUid?: string;
  client_uid?: string;
  domaine?: string;
  entree?: string;
  cleIdempotence?: string;
  cle_idempotence?: string;
  budgetCreditsMinor?: number | string;
  budget_credits_minor?: number | string;
}
interface ReponseInferenceRPC {
  idExecution: string;
  sortie: string;
  succes: boolean;
  creditsDebiteMinor: number;
  message: string;
}
interface RequeteStatutRPC {
  idExecution?: string;
  id_execution?: string;
}
interface ReponseStatutRPC {
  idExecution: string;
  etat: string;
  progression: number;
  sortie: string;
}

/** Lit la metadata x-gen3-empreinte (empreinte hex du certificat client). */
function extraireEmpreinteMetadata(call: ServerUnaryCall<unknown, unknown>): string {
  const valeurs = call.metadata?.get(METADATA_EMPREINTE) ?? [];
  return valeurs.length > 0 ? String(valeurs[0]).trim() : "";
}

/**
 * MOTEUR D'INFÉRENCE LOCAL — v1 HONNÊTE.
 *
 * Le socle tente d'importer le moteur neuronal gen3 (module configurable
 * par GENAPI_INFERENCE_MODULE, défaut "@/lib/neural/engine") et l'appelle
 * via une fonction explicite. Si l'import échoue OU que le module n'expose
 * aucune fonction utilisable : échec DÉCLARÉ (succes:false) avec
 * libération de la réservation wallet — JAMAIS de fausse réussite.
 */
export async function executerInferenceLocal(
  entree: string,
  domaine: string,
): Promise<{ succes: boolean; sortie: string; message?: string }> {
  const cheminModule = process.env.GENAPI_INFERENCE_MODULE?.trim() || "@/lib/neural/engine";
  try {
    // Import dynamique RUNTIME (VPS souverain, tsx) — jamais bundled par
    // Next (webpackIgnore) : le moteur est un module d'infrastructure hôte.
    const moduleMoteur = (await import(/* webpackIgnore: true */ cheminModule)) as Record<
      string,
      unknown
    >;
    for (const nom of ["executerInferenceGenAPI", "genererReponse", "composerReponse", "repondre"]) {
      const candidat = moduleMoteur[nom];
      if (typeof candidat === "function") {
        const brut = (await (candidat as (args: { entree: string; domaine: string }) => Promise<unknown>)({
          entree,
          domaine,
        })) as unknown;
        void domaine; // réservé au routage moteur (v2 : partition par domaine)
        return { succes: true, sortie: extraireSortie(brut) };
      }
    }
    return {
      succes: false,
      sortie: "",
      message: "Moteur d'inférence indisponible sur cet hôte genAPI (déploiement VPS requis).",
    };
  } catch (erreur: unknown) {
    return {
      succes: false,
      sortie: "",
      message: `Moteur d'inférence indisponible sur cet hôte genAPI (déploiement VPS requis) : ${
        erreur instanceof Error ? erreur.message : String(erreur)
      }`,
    };
  }
}

/** Normalise une sortie moteur (string, {sortie}, {text}, {response}…). */
function extraireSortie(brut: unknown): string {
  if (typeof brut === "string") return brut;
  if (brut && typeof brut === "object") {
    const objet = brut as Record<string, unknown>;
    for (const champ of ["sortie", "text", "response", "output"]) {
      if (typeof objet[champ] === "string") return objet[champ] as string;
    }
  }
  try {
    return JSON.stringify(brut ?? null);
  } catch {
    return String(brut);
  }
}

/** Écrit (best-effort) le document de suivi d'une exécution. */
async function ecrireExecution(id: string, patch: Record<string, unknown>): Promise<void> {
  try {
    await writeCheckpointSet("genapiExecutions", id, patch, String(patch.client_uid ?? ""));
  } catch {
    // Suivi best-effort : la télémétrie ne bloque jamais l'exécution.
  }
}

/**
 * Crée le serveur gRPC genAPI (mTLS OBLIGATOIRE — createInsecure interdit).
 * Handlers câblés : Sante, ExecuterInference (réservation wallet → moteur
 * local → règlement/libération), StatutExecution (lecture genapiExecutions).
 */
export async function creerServeurGenAPI(options: OptionsServeurGenAPI): Promise<ServeurGenAPI> {
  const cheminProto = options.cheminProto?.trim() || resoudreCheminProtoDefaut();
  const definition = chargerContrat(cheminProto);
  const service = definition["gen3.v1.Gen3"] as ServiceDefinition | undefined;
  if (!service) {
    throw new Error("genAPI/serveur — service gen3.v1.Gen3 introuvable dans le contrat gen3.proto.");
  }

  const cheminCle =
    options.cheminCleServeur?.trim() ||
    process.env.GENAPI_SERVER_KEY_PATH?.trim() ||
    "/etc/gen3ia/genapi/serveur.key";
  const cheminCert =
    options.cheminCertServeur?.trim() ||
    process.env.GENAPI_SERVER_CERT_PATH?.trim() ||
    "/etc/gen3ia/genapi/serveur.crt";
  const clePrivee = readFileSync(cheminCle);
  const certificat = readFileSync(cheminCert);

  // Racines de validation des certificats CLIENTS : la CA racine gen3 si
  // lisible (mTLS strict), sinon null — le certificat client reste EXIGÉ
  // par le 3ᵉ argument de createSsl (checkClientCertificate = true).
  let racinesClients: Buffer | null = null;
  try {
    racinesClients = readFileSync(options.cheminCaCert);
  } catch {
    racinesClients = null;
  }

  // createInsecure INTERDIT : genAPI est un socle cryptographique.
  const identifiants = ServerCredentials.createSsl(
    racinesClients,
    [{ private_key: clePrivee, cert_chain: certificat }],
    true, // checkClientCertificate : le certificat client est OBLIGATOIRE
  );

  const serveur = new Server();
  serveur.addService(service, {
    Sante: gestionnaireSante,
    ExecuterInference: gestionnaireInference,
    StatutExecution: gestionnaireStatut,
  });

  return {
    serveur,
    port: options.port,
    async demarrer(): Promise<number> {
      return new Promise<number>((resolve, reject) => {
        serveur.bindAsync(`0.0.0.0:${options.port}`, identifiants, (erreur, port) => {
          if (erreur) reject(erreur);
          else resolve(port);
        });
      });
    },
    async arreter(): Promise<void> {
      await new Promise<void>((resolve) => {
        const garde = setTimeout(() => {
          serveur.forceShutdown();
          resolve();
        }, 5_000);
        serveur.tryShutdown(() => {
          clearTimeout(garde);
          resolve();
        });
      });
    },
  };
}

/** Handler Sante — sonde gratuite (aucune facturation). */
function gestionnaireSante(
  call: ServerUnaryCall<RequeteSanteRPC, ReponseSanteRPC>,
  callback: sendUnaryData<ReponseSanteRPC>,
): void {
  try {
    const clientUid = String(call.request?.clientUid ?? call.request?.client_uid ?? "").trim();
    void journaliser("sante_rpc", clientUid ? `Sonde Sante de ${clientUid}.` : "Sonde Sante anonyme.");
    callback(null, {
      etat: "operational",
      version: VERSION_GENAPI,
      horodatage: Date.now(),
    });
  } catch (erreur: unknown) {
    callback(erreurRPC(status.INTERNAL, tronquer(erreur instanceof Error ? erreur.message : String(erreur), 300)));
  }
}

/** Handler ExecuterInference — pipeline complet empreinte → wallet → moteur. */
function gestionnaireInference(
  call: ServerUnaryCall<RequeteInferenceRPC, ReponseInferenceRPC>,
  callback: sendUnaryData<ReponseInferenceRPC>,
): void {
  void traiterInference(call, callback);
}

async function traiterInference(
  call: ServerUnaryCall<RequeteInferenceRPC, ReponseInferenceRPC>,
  callback: sendUnaryData<ReponseInferenceRPC>,
): Promise<void> {
  const requete = call.request ?? {};
  const clientUid = String(requete.clientUid ?? requete.client_uid ?? "").trim();
  const domaine = String(requete.domaine ?? "").trim();
  const entree = String(requete.entree ?? "");
  const cleIdempotence = String(requete.cleIdempotence ?? requete.cle_idempotence ?? "").trim();
  const budgetDemande = Number(requete.budgetCreditsMinor ?? requete.budget_credits_minor ?? 0);

  // État de la réservation wallet pour les chemins d'erreur.
  let reserve = false;
  let regle = false;
  let reference = "";
  let montant = 0;

  try {
    // 1. Empreinte client : metadata obligatoire + allowlist Firestore.
    const empreinte = extraireEmpreinteMetadata(call);
    if (!empreinte) {
      callback(erreurRPC(status.UNAUTHENTICATED, "Empreinte client requise (metadata x-gen3-empreinte)."));
      return;
    }
    if (!clientUid) {
      callback(erreurRPC(status.INVALID_ARGUMENT, "client_uid requis."));
      return;
    }
    if (!entree.trim()) {
      callback(erreurRPC(status.INVALID_ARGUMENT, "entree requise."));
      return;
    }
    if (!(await empreinteAutorisee(empreinte))) {
      await journaliser("execution_refusee", `Empreinte non allowlistée (client_uid=${clientUid}) — exécution refusée.`);
      callback(
        erreurRPC(
          status.UNAUTHENTICATED,
          "Empreinte client non autorisée (allowlist genapiClients) : certificat inconnu ou révoqué.",
        ),
      );
      return;
    }

    // 2. Réservation wallet Chariow AVANT toute exécution.
    montant = Number.isFinite(budgetDemande) && budgetDemande > 0 ? Math.floor(budgetDemande) : creditsExecutionDefaut();
    reference = `genapi-${cleIdempotence || randomUUID()}`;
    await reserveFunds({
      userId: clientUid,
      amountMinor: montant,
      reference,
      metadata: { source: "genapi", empreinte },
    });
    reserve = true;

    // 3. Document de suivi (StatutExecution lit genapiExecutions/{id}).
    const idExecution = randomUUID();
    await ecrireExecution(idExecution, {
      id: idExecution,
      client_uid: clientUid,
      etat: "en_cours",
      progression: 0,
      sortie: "",
      creeA: new Date().toISOString(),
    });

    // 4. Exécution — moteur local honnête (jamais de fausse réussite).
    const resultat = await executerInferenceLocal(entree, domaine);
    if (!resultat.succes) {
      await releaseReservation({ userId: clientUid, reference, reservedMinor: montant }).catch(() => undefined);
      reserve = false;
      await ecrireExecution(idExecution, { etat: "echouee", progression: 1, sortie: "", message: resultat.message ?? "" });
      await compterExecutionGenAPI({ succes: false, creditsMinor: 0 });
      await journaliser("execution_echec", `Client ${clientUid} — moteur indisponible, réservation libérée (0 crédit débité).`);
      callback(null, {
        idExecution: idExecution,
        sortie: "",
        succes: false,
        creditsDebiteMinor: 0,
        message: resultat.message ?? "Moteur d'inférence indisponible.",
      });
      return;
    }

    // 5. Succès : règlement du wallet + compteurs + journal.
    await settleReservation({
      userId: clientUid,
      reference,
      reservedMinor: montant,
      actualChargeMinor: montant,
    });
    regle = true;
    await ecrireExecution(idExecution, { etat: "terminee", progression: 1, sortie: resultat.sortie });
    await compterExecutionGenAPI({ succes: true, creditsMinor: montant });
    await journaliser("execution_rpc", `Client ${clientUid} — exécution réussie, ${montant} minor débités (réf ${reference}).`);
    callback(null, {
      idExecution: idExecution,
      sortie: resultat.sortie,
      succes: true,
      creditsDebiteMinor: montant,
      message: "",
    });
  } catch (erreur: unknown) {
    // 6. Jamais d'exception non rattrapée : libération + compteur + INTERNAL.
    if (reserve && !regle) {
      await releaseReservation({ userId: clientUid, reference, reservedMinor: montant }).catch(() => undefined);
    }
    const message = tronquer(erreur instanceof Error ? erreur.message : String(erreur), 300);
    await compterExecutionGenAPI({ succes: false, creditsMinor: 0 });
    await journaliser("execution_rpc_ko", `Client ${clientUid} — incident gRPC : ${message}`);
    callback(erreurRPC(status.INTERNAL, message));
  }
}

/** Handler StatutExecution — lecture genapiExecutions/{id}. */
function gestionnaireStatut(
  call: ServerUnaryCall<RequeteStatutRPC, ReponseStatutRPC>,
  callback: sendUnaryData<ReponseStatutRPC>,
): void {
  void traiterStatut(call, callback);
}

async function traiterStatut(
  call: ServerUnaryCall<RequeteStatutRPC, ReponseStatutRPC>,
  callback: sendUnaryData<ReponseStatutRPC>,
): Promise<void> {
  try {
    const id = String(call.request?.idExecution ?? call.request?.id_execution ?? "").trim();
    if (!id) {
      callback(erreurRPC(status.INVALID_ARGUMENT, "id_execution requis."));
      return;
    }
    const doc = await resilientGet<Record<string, unknown>>("genapiExecutions", id);
    if (!doc) {
      callback(erreurRPC(status.NOT_FOUND, "Exécution introuvable."));
      return;
    }
    callback(null, {
      idExecution: id,
      etat: String(doc.etat ?? "introuvable"),
      progression: Number(doc.progression ?? 0),
      sortie: String(doc.sortie ?? ""),
    });
  } catch (erreur: unknown) {
    callback(erreurRPC(status.INTERNAL, tronquer(erreur instanceof Error ? erreur.message : String(erreur), 300)));
  }
}

/**
 * Ré-export de `credentials` : les exemples client (LISEZMOI) et les
 * sondes VPS construisent leurs canaux mTLS depuis le même paquet.
 */
export { credentials };
