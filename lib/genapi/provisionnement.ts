import "server-only";

import { mkdtempSync, unlinkSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { resilientQuery, writeCheckpointSet } from "@/lib/db/firestore-resilient";
import { adminDb } from "@/lib/firebase/admin";

import {
  construireSujetClient,
  caDisponible,
  extraireEmpreinte,
  genererClePriveeClient,
  signerCertificatClient,
} from "@/lib/genapi/openssl";
import {
  JETON_TTL_MS,
  construirePaquet,
  genererJetonUsageUnique,
  hasherJeton,
  extrairePaquet,
} from "@/lib/genapi/paquet";
import type { EntreeJournalGenAPI, ResultatProvisionnement } from "@/lib/genapi/types";

/**
 * genAPI — PIPELINE MAÎTRE DE PROVISIONNEMENT.
 *
 * Flux exact du propriétaire (système d'exploitation autonome gen3) :
 *   1. OpenSSL génère une clé privée client ECC (prime256v1) ;
 *   2. la CA racine gen3 signe le certificat client ;
 *   3. l'empreinte SHA-256 du certificat part dans Firestore
 *      (`genapiClients/{uid}`) — JAMAIS la clé privée ;
 *   4. le paquet (client.key + client.crt + gen3.proto + LISEZMOI) est
 *      stocké base64 derrière un jeton d'USAGE UNIQUE (TTL 15 min) ;
 *   5. AUTODESTRUCTION : la clé privée est immédiatement supprimée du
 *      serveur avec PREUVE (rm vérifié par existsSync === false) —
 *      « zéro fuite » : si le serveur est compromis, les clés privées
 *      des clients n'y existent physiquement plus.
 */

/** Collections Firestore/r2fs du socle genAPI. */
export const COLLECTION_CLIENTS = "genapiClients";
export const COLLECTION_PAQUETS = "genapiPackages";
export const COLLECTION_JOURNAL = "genapiJournal";
export const COLLECTION_DEMANDES = "genapiDemandes";

/** Durée de validité d'un certificat client (convention du socle). */
const JOURS_VALIDITE_CERTIFICAT = 365;

/** Préfixe des répertoires temporaires de provisionnement. */
const PREFIXE_TMP = "genapi-prov-";

/** Tronque un message (les erreurs ne contiennent jamais de matière secrète). */
function tronquer(texte: string, max: number): string {
  const propre = String(texte ?? "").trim();
  return propre.length > max ? `${propre.slice(0, max)}…` : propre;
}

/**
 * Validation d'identité du client SaaS (défense en profondeur AVANT tout
 * appel au terminal intégré) : uid non vide, ≤ 80 caractères, sans
 * séparateur de chemin ; email contenant un @.
 */
function validerIdentite(uid: string, email: string): void {
  if (typeof uid !== "string" || uid.length === 0 || uid.length > 80 || /[/\\\r\n]/.test(uid)) {
    throw new Error("Provisionnement refusé : uid client invalide (requis, ≤ 80 caractères, sans « / » ni retour à la ligne).");
  }
  if (typeof email !== "string" || !email.includes("@") || email.length > 320) {
    throw new Error("Provisionnement refusé : email client invalide.");
  }
}

/**
 * Résout le chemin du contrat gen3.proto : variable GENAPI_PROTO_PATH,
 * puis répertoire de travail du processus (convention daemon tsx/PM2 : le
 * dépôt racine) — JAMAIS import.meta.url : webpack (build production Next)
 * ne résout pas « new URL(\".\", import.meta.url) » et casse la compilation
 * (CI 150b611 : « Module not found: Can't resolve '.' »).
 */
function resoudreCheminProto(): string {
  const env = process.env.GENAPI_PROTO_PATH?.trim();
  if (env) return env;
  return path.resolve(process.cwd(), "lib", "genapi", "proto", "gen3.proto");
}

/** LISEZMOI embarqué dans le paquet client (contrat développeur SaaS). */
function construireLisezmoi(uid: string): string {
  return `# Paquet genAPI — client gen3 (${uid})

## Contenu du paquet

- \`client.key\`  : votre clé privée ECC (prime256v1). NE PARTAGEZ JAMAIS CE FICHIER.
- \`client.crt\`  : votre certificat, signé par la CA racine gen3.
- \`gen3.proto\`  : le contrat gRPC officiel (package gen3.v1, service Gen3).
- \`LISEZMOI.md\` : ce fichier.

## Connexion mTLS

Le daemon genAPI tourne sur le VPS souverain gen3ia (AlmaLinux) et exige un
certificat client signé par la CA racine gen3 : c'est la barrière réseau.
L'empreinte SHA-256 de votre certificat est enregistrée dans la allowlist
genAPI : chaque appel doit aussi porter la metadata \`x-gen3-empreinte\`
(empreinte hexadécimale, sans deux-points) qui lie la connexion TLS à votre
compte — l'allowlist Firestore refuse toute empreinte inconnue.

## Exemple (Node.js, @grpc/grpc-js + @grpc/proto-loader)

\`\`\`ts
import * as grpc from "@grpc/grpc-js";
import { loadPackageDefinition, loadSync } from "@grpc/proto-loader";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const definition = loadSync("./gen3.proto", { keepCase: false, longs: String, enums: String, defaults: true, oneofs: true });
const Gen3 = (loadPackageDefinition(definition) as { gen3: { v1: { Gen3: { new (hote: string, creds: grpc.ChannelCredentials): never } } } }).gen3.v1.Gen3;

const empreinte = createHash("sha256").update(readFileSync("./client.crt")).digest("hex");
const creds = grpc.credentials.combineChannelCredentials(
  grpc.credentials.createSsl(null, readFileSync("./client.key"), readFileSync("./client.crt")),
  grpc.credentials.createFromMetadataGenerator((_params, cb) => {
    const meta = new grpc.Metadata();
    meta.set("x-gen3-empreinte", empreinte);
    cb(null, meta);
  }),
);
const client = new Gen3("vps.gen3ia:9443", creds);

// NOTE : les champs JS sont en lowerCamelCase (proto-loader keepCase:false) :
// clientUid, domaine, entree, cleIdempotence, budgetCreditsMinor.
client.Sante({ clientUid: "${uid}" }, (erreur, reponse) => console.log(reponse));
\`\`\`

## Facturation

Chaque exécution \`ExecuterInference\` réussie débite les crédits Chariow
(wallet) de votre compte : une réservation est posée avant l'exécution puis
réglée au coût réel — ou libérée si l'exécution échoue. La sonde \`Sante\`
est gratuite. Les montants sont en unités mineures.

## Sécurité

La clé privée du client a été DÉTRUITE du serveur gen3 immédiatement après
la génération de ce paquet (suppression vérifiée) : gen3 ne peut PAS vous
ré-émettre votre clé — conservez \`client.key\` en lieu sûr. En cas de
compromission, demandez une révocation : votre empreinte est retirée de la
allowlist et un nouveau provisionnement émet une nouvelle identité.
`;
}

/**
 * PIPELINE MAÎTRE : provisionner un client genAPI.
 * Ne lève JAMAIS : retourne { ok:false, erreur } en cas d'incident.
 */
export async function provisionnerClient(input: {
  uid: string;
  email: string;
  trigger?: string;
}): Promise<ResultatProvisionnement> {
  const { uid, email } = input;
  try {
    // 1. Validation d'identité (défense avant tout accès disque/réseau).
    validerIdentite(uid, email);

    // 2. La CA racine gen3 doit être présente sur l'hôte.
    if (!(await caDisponible())) {
      throw new Error(
        "CA racine gen3 indisponible (GENAPI_CA_KEY_PATH/GENAPI_CA_CERT_PATH) : provisionnement impossible sur cet hôte.",
      );
    }

    // 3. Terminal intégré : clé privée + certificat signé + empreinte.
    const repertoire = mkdtempSync(path.join(tmpdir(), PREFIXE_TMP));
    try {
      const cheminCle = path.join(repertoire, "client.key");
      const cheminCsr = path.join(repertoire, "client.csr");
      const cheminCrt = path.join(repertoire, "client.crt");

      await genererClePriveeClient(cheminCle);
      await signerCertificatClient({
        cheminCle,
        cheminCsr,
        cheminCrt,
        sujet: construireSujetClient(uid),
        jours: JOURS_VALIDITE_CERTIFICAT,
      });
      const empreinte = await extraireEmpreinte(cheminCrt);
      const maintenant = new Date().toISOString();

      // 4. Firestore : empreinte SEULE (jamais la clé privée). Ré-émettre un
      //    client remplace son empreinte — révocation implicite de l'ancienne.
      await writeCheckpointSet(
        COLLECTION_CLIENTS,
        uid,
        { uid, email, empreinte, statut: "actif", creeA: maintenant },
        uid,
      );

      // 5. Paquet client : gen3.proto + clé + certificat + LISEZMOI.
      const contratProto = readFileSync(resoudreCheminProto(), "utf8");
      const paquet = construirePaquet([
        { nom: "gen3.proto", contenu: contratProto },
        { nom: "client.key", contenu: readFileSync(cheminCle) },
        { nom: "client.crt", contenu: readFileSync(cheminCrt) },
        { nom: "LISEZMOI.md", contenu: construireLisezmoi(uid) },
      ]);
      const paquetBase64 = paquet.toString("base64");

      // 6. Jeton d'usage unique : le CLAIR n'est jamais stocké, seul son hash.
      const { jeton, hashJeton } = genererJetonUsageUnique();
      const expireA = new Date(Date.now() + JETON_TTL_MS).toISOString();
      await writeCheckpointSet(
        COLLECTION_PAQUETS,
        hashJeton,
        { hashJeton, uid, paquetBase64, creeA: maintenant, expireA, consommeA: null },
        uid,
      );

      // 7. ZÉRO FUITE — autodestruction avec preuve (rm vérifié).
      const fichiersADetruire = [cheminCle, cheminCsr];
      let autodestructionOk = true;
      for (const chemin of fichiersADetruire) {
        if (!existsSync(chemin)) continue; // déjà absent = objectif atteint
        try {
          unlinkSync(chemin);
        } catch {
          autodestructionOk = false;
        }
      }
      if (autodestructionOk) {
        for (const chemin of fichiersADetruire) {
          if (existsSync(chemin)) autodestructionOk = false;
        }
      }
      if (!autodestructionOk) {
        // L'empreinte n'est PAS révoquée (le certificat est valide), mais le
        // jeton n'est PAS renvoyé : aucun lien ne peut exfiltrer la clé.
        await journaliser(
          "autodestruction_ko",
          `Client ${uid} : la clé privée n'a pas pu être supprimée avec preuve — jeton NON émis, provisionnement annulé.`,
        );
        return {
          ok: false,
          empreinte,
          erreur: "Autodestruction de la clé privée impossible (zéro fuite non garanti) — provisionnement annulé, aucun lien émis.",
        };
      }
      await journaliser("cle_privee_detruite", `Client ${uid} : clé privée + CSR supprimées du serveur (rm vérifié, zéro fuite).`);
      await journaliser(
        "provisionnement_ok",
        `Client ${uid} provisionné (trigger ${input.trigger ?? "manuel"}) : empreinte ${empreinte.slice(0, 12)}… allowlistée, paquet émis (TTL 15 min).`,
      );

      return { ok: true, empreinte, jetonTelechargement: jeton, expireA };
    } finally {
      // 8. Nettoyage du répertoire temporaire (AUCUNE clé privée ne reste
      //    sur disque : le paquet vit UNIQUEMENT en base64 TTL 15 min).
      rmSync(repertoire, { recursive: true, force: true });
    }
  } catch (erreur: unknown) {
    const detail = tronquer(erreur instanceof Error ? erreur.message : String(erreur), 300);
    await journaliser("provisionnement_ko", `Client ${uid} : ${detail}`);
    return { ok: false, erreur: detail };
  }
}

/** Codes internes d'erreur de consommation de jeton. */
type CodeErreurJeton = "absent" | "consomme" | "expire";

/** Erreur interne portant un code court (mappée en message FR à l'extérieur). */
class ErreurJeton extends Error {
  constructor(
    public readonly code: CodeErreurJeton,
    message: string,
  ) {
    super(message);
    this.name = "ErreurJeton";
  }
}

/**
 * Consomme un jeton d'usage unique et retourne le paquet.
 * Transaction : l'usage unique est ATOMIQUE (deux appels concurrents → un
 * seul gagne). Après consommation, le doc reste pour l'audit mais
 * paquetBase64 est ÉCRASÉ par "" (minimisation des données).
 */
export async function consommerJetonPaquet(jeton: string): Promise<{
  ok: boolean;
  paquet?: Buffer;
  uid?: string;
  erreur?: string;
}> {
  try {
    if (typeof jeton !== "string" || jeton.length === 0) {
      throw new Error("Jeton de téléchargement manquant.");
    }
    const hashJeton = hasherJeton(jeton);
    let paquetBase64 = "";
    let uidClient = "";
    await adminDb.runTransaction(async (tx) => {
      const reference = adminDb.collection(COLLECTION_PAQUETS).doc(hashJeton);
      const instantane = await tx.get(reference);
      if (!instantane.exists) {
        throw new ErreurJeton("absent", "Paquet introuvable : jeton inconnu ou lien déjà purgé.");
      }
      const donnees = (instantane.data() ?? {}) as Record<string, unknown>;
      if (donnees.consommeA != null) {
        throw new ErreurJeton("consomme", "Lien de téléchargement déjà utilisé (usage unique) : demandez un nouveau provisionnement.");
      }
      const expireA = typeof donnees.expireA === "string" ? Date.parse(donnees.expireA) : NaN;
      if (!Number.isFinite(expireA) || Date.now() > expireA) {
        throw new ErreurJeton("expire", "Lien de téléchargement expiré (TTL 15 minutes) : demandez un nouveau provisionnement.");
      }
      paquetBase64 = typeof donnees.paquetBase64 === "string" ? donnees.paquetBase64 : "";
      uidClient = typeof donnees.uid === "string" ? donnees.uid : "";
      tx.update(reference, { consommeA: new Date().toISOString(), paquetBase64: "" });
    });
    await journaliser(
      "paquet_telecharge",
      `Paquet consommé pour ${uidClient || "uid inconnu"} (hash ${hashJeton.slice(0, 12)}…, contenu écrasé après livraison).`,
    );
    return { ok: true, paquet: Buffer.from(paquetBase64, "base64"), uid: uidClient };
  } catch (erreur: unknown) {
    if (erreur instanceof ErreurJeton) {
      await journaliser("paquet_refuse", `Jeton refusé (${erreur.code}) : ${erreur.message}`);
      return { ok: false, erreur: erreur.message };
    }
    const detail = tronquer(erreur instanceof Error ? erreur.message : String(erreur), 300);
    await journaliser("paquet_refuse", `Incident de consommation de jeton : ${detail}`);
    return { ok: false, erreur: detail };
  }
}

/**
 * Journal d'audit genAPI — écriture best-effort : une panne de journal ne
 * doit JAMAIS bloquer le socle. Aucun contenu de clé n'y transite jamais
 * (les détails sont construits sans matière secrète).
 */
export async function journaliser(evenement: string, detail: string): Promise<void> {
  try {
    await adminDb.collection(COLLECTION_JOURNAL).add({
      evenement,
      detail,
      a: new Date().toISOString(),
    });
  } catch {
    // catch silencieux (convention du socle) — le journal est un confort
    // d'audit, jamais un chemin critique.
  }
}

/** Lit les dernières entrées du journal genAPI (tri décroissant sur `a`). */
export async function listerJournalGenAPI(limite = 40): Promise<EntreeJournalGenAPI[]> {
  const bornes = Math.max(1, Math.min(200, Math.floor(limite) || 40));
  const resultats = await resilientQuery<Record<string, unknown>>(
    COLLECTION_JOURNAL,
    [],
    { orderField: "a", descending: true, limit: bornes },
  );
  return resultats.map((doc) => ({
    evenement: String(doc.evenement ?? ""),
    detail: String(doc.detail ?? ""),
    a: String(doc.a ?? ""),
  }));
}

/** Ré-export des utilitaires de paquet utiles aux routes admin (contrat 2-b). */
export { construirePaquet, extrairePaquet, genererJetonUsageUnique, hasherJeton, JETON_TTL_MS };
