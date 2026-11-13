import "server-only";

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { access as accessCb, chmod } from "node:fs/promises";

const execFile = promisify(execFileCallback);
const access = accessCb;

/**
 * genAPI — LE TERMINAL INTÉGRÉ (cryptographie OpenSSL).
 *
 * genAPI est le système d'exploitation autonome de gen3 : la gestion des
 * clés des clients SaaS passe par un terminal intégré qui pilote OpenSSL
 * via `execFile` (node:child_process). RÈGLE D'OR ANTI-INJECTION :
 * JAMAIS `exec` ni de chaîne shell — chaque invocation est un couple
 * (binaire, tableau d'arguments) sans interprétation par un shell.
 *
 * Zéro log du contenu des clés : les erreurs OpenSSL remontent avec le
 * stderr tronqué (200 caractères max) et SANS bloc PEM éventuel.
 *
 * CA racine gen3 : la clé privée de la CA et son certificat vivent sur le
 * VPS souverain (AlmaLinux), hors du dépôt, aux chemins configurables :
 *   - GENAPI_CA_KEY_PATH  (défaut /etc/gen3ia/genapi/ca.key)
 *   - GENAPI_CA_CERT_PATH (défaut /etc/gen3ia/genapi/ca.crt)
 */

/** Timeout imparti à chaque commande OpenSSL (le terminal intégré ne pend jamais). */
const TIMEOUT_OPENSSL_MS = 20_000;

/** Chemin de la clé privée de la CA racine gen3. */
export function cheminCleCA(): string {
  return process.env.GENAPI_CA_KEY_PATH?.trim() || "/etc/gen3ia/genapi/ca.key";
}

/** Chemin du certificat de la CA racine gen3. */
export function cheminCertificatCA(): string {
  return process.env.GENAPI_CA_CERT_PATH?.trim() || "/etc/gen3ia/genapi/ca.crt";
}

/**
 * Construit la commande OpenSSL sous forme SÛRE (binaire + tableau
 * d'arguments). Fonction PURE exportée pour les tests : aucun passage par
 * un shell, aucune interpolation de chaîne — le couple est passé tel quel
 * à `execFile`.
 */
export function construireCommande(args: string[]): { binaire: string; args: string[] } {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("construireCommande: arguments invalides (tableau de chaînes requis).");
  }
  return { binaire: "openssl", args: [...args] };
}

/**
 * Masque tout bloc PEM éventuel dans un texte d'erreur (défense en
 * profondeur : OpenSSL ne renvoie jamais de clé sur stderr, mais le
 * principe de précaution s'applique au socle cryptographique).
 */
function masquerPem(texte: string): string {
  return texte.replace(
    /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
    "[bloc pem masqué]",
  );
}

/** Tronque un message d'erreur à 200 caractères, PEM masqué. */
function tronquerErreur(texte: string): string {
  const propre = masquerPem(String(texte ?? "")).trim();
  return propre.length > 200 ? `${propre.slice(0, 200)}…` : propre;
}

/** Exécute une commande OpenSSL via le terminal intégré (execFile, sans shell). */
async function executerOpenSSL(args: string[], label: string): Promise<string> {
  const commande = construireCommande(args);
  try {
    const { stdout } = await execFile(commande.binaire, commande.args, {
      timeout: TIMEOUT_OPENSSL_MS,
      windowsHide: true,
    });
    return stdout;
  } catch (erreur: unknown) {
    const detail =
      erreur && typeof erreur === "object" && "stderr" in erreur
        ? tronquerErreur((erreur as { stderr?: unknown }).stderr as string)
        : tronquerErreur(erreur instanceof Error ? erreur.message : String(erreur));
    throw new Error(`genAPI/openssl — ${label} a échoué : ${detail}`);
  }
}

/**
 * La CA racine gen3 est-elle disponible sur cet hôte ? Les DEUX fichiers
 * (clé + certificat) doivent exister et être lisibles.
 */
export async function caDisponible(): Promise<boolean> {
  try {
    await access(cheminCleCA());
    await access(cheminCertificatCA());
    return true;
  } catch {
    return false;
  }
}

/**
 * Génère la clé privée ECC du client (courbe prime256v1) via le terminal
 * intégré. La clé est écrite au chemin demandé puis verrouillée en
 * permissions 0600. Le fichier est DÉTRUIT par le pipeline de
 * provisionnement juste après la construction du paquet (zéro fuite).
 */
export async function genererClePriveeClient(cheminCle: string): Promise<void> {
  await executerOpenSSL(
    ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", cheminCle],
    "génération de la clé privée client",
  );
  try {
    await chmod(cheminCle, 0o600);
  } catch {
    // Verrouillage 0600 best-effort : sur certains montages (SMB…) le chmod
    // peut échouer sans compromettre la destruction immédiate du fichier.
  }
}

/** Paramètres de signature d'un certificat client par la CA racine gen3. */
export interface ParametresSignatureCertificat {
  /** Clé privée du client (créée par genererClePriveeClient). */
  cheminCle: string;
  /** Chemin de la CSR intermédiaire (détruite après usage). */
  cheminCsr: string;
  /** Chemin du certificat client signé produit. */
  cheminCrt: string;
  /** Sujet OpenSSL canonique : /CN=…/O=…/OU=… */
  sujet: string;
  /** Validité en jours (365 par convention du socle). */
  jours: number;
}

/**
 * Signe un certificat client : (1) génération de la CSR depuis la clé du
 * client, (2) signature par la CA racine gen3 (SHA-256). Deux invocations
 * distinctes du terminal intégré, toujours sans shell.
 */
export async function signerCertificatClient(params: ParametresSignatureCertificat): Promise<void> {
  await executerOpenSSL(
    ["req", "-new", "-key", params.cheminCle, "-out", params.cheminCsr, "-subj", params.sujet],
    "génération de la CSR client",
  );
  await executerOpenSSL(
    [
      "x509",
      "-req",
      "-in",
      params.cheminCsr,
      "-CA",
      cheminCertificatCA(),
      "-CAkey",
      cheminCleCA(),
      "-CAcreateserial",
      "-days",
      String(Math.max(1, Math.floor(params.jours))),
      "-sha256",
      "-out",
      params.cheminCrt,
    ],
    "signature du certificat client",
  );
}

/**
 * Construit le sujet OpenSSL canonique d'un client genAPI.
 * DÉFENSE : l'uid est déjà validé par l'appelant, mais cette fonction PURE
 * jette si l'uid contient `/`, `\`, un retour à la ligne ou dépasse 80
 * caractères — un sujet invalide ne doit JAMAIS atteindre le terminal.
 */
export function construireSujetClient(uid: string): string {
  if (typeof uid !== "string" || uid.length === 0) {
    throw new Error("construireSujetClient: uid vide.");
  }
  if (uid.length > 80) {
    throw new Error("construireSujetClient: uid trop long (> 80 caractères).");
  }
  if (/[/\\\r\n]/.test(uid)) {
    throw new Error("construireSujetClient: uid contient un caractère interdit (/ \\ retour à la ligne).");
  }
  return `/CN=gen3-client-${uid}/O=Gen3ia SaaS/OU=genAPI`;
}

/**
 * Normalise une empreinte brute (« sha256 Fingerprint=AB:CD:… ») en hex
 * minuscule SANS deux-points. Fonction PURE exportée et testée séparément :
 * le résultat est l'identifiant cryptographique stocké dans Firestore
 * (`genapiClients.empreinte`) et vérifié par l'allowlist.
 */
export function normaliserEmpreinte(brute: string): string {
  if (typeof brute !== "string") {
    throw new Error("normaliserEmpreinte: entrée invalide.");
  }
  // Retire le préfixe « sha256 Fingerprint= » (ou variante) puis les
  // deux-points et les espaces.
  const sansPrefixe = brute.includes("=") ? brute.slice(brute.lastIndexOf("=") + 1) : brute;
  const hex = sansPrefixe.replace(/[:\s]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("normaliserEmpreinte: empreinte SHA-256 invalide (64 hex attendus).");
  }
  return hex;
}

/**
 * Extrait l'empreinte SHA-256 d'un certificat client via le terminal
 * intégré (`openssl x509 -noout -fingerprint -sha256`) puis la normalise.
 */
export async function extraireEmpreinte(cheminCrt: string): Promise<string> {
  const sortie = await executerOpenSSL(
    ["x509", "-in", cheminCrt, "-noout", "-fingerprint", "-sha256"],
    "extraction de l'empreinte du certificat",
  );
  const ligne = sortie
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /fingerprint=/i.test(l));
  if (!ligne) {
    throw new Error("genAPI/openssl — empreinte SHA-256 absente de la sortie OpenSSL.");
  }
  return normaliserEmpreinte(ligne);
}
