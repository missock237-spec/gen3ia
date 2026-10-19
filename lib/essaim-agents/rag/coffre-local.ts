/**
 * Le Coffre Local — RAG décentralisé ZÉRO-CONNAISSANCE (volet stockage).
 *
 * Dans les architectures classiques, chercher dans vos documents impose
 * de les envoyer sur un serveur distant. Ici :
 *
 *  1. chaque utilisateur stocke et indexe ses documents LOCALEMENT ;
 *  2. les contenus sont chiffrés dans son navigateur (AES-GCM 256,
 *     clé dérivée du mot de passe par PBKDF2-SHA256, 150 000 tours) ;
 *  3. rien — ni document, ni index, ni clef — ne quitte jamais la
 *     machine, sauf des EXTRAITS choisis par le détenteur en réponse
 *     à une onde de requête (voir onde-semantique.ts) ;
 *  4. le serveur ne voit RIEN : l'entrepôt est IndexedDB, le chiffrement
 *     est WebCrypto, l'index vit dans la mémoire du navigateur.
 *
 * L'entrepôt clé-valeur est injectable : IndexedDB en navigateur,
 * mémoire (ou mapping) pour les tests et les environnements sans DAP.
 */

/** Entrepôt clé-valeur minimal (IndexedDB, mémoire, localStorage…). */
export interface EntrepotKv {
  lire(cle: string): Promise<string | null>;
  ecrire(cle: string, valeur: string): Promise<void>;
  supprimer(cle: string): Promise<void>;
  cles(): Promise<string[]>;
}

/** Entrepôt en mémoire (tests, repli privé). */
export class EntrepotMemoire implements EntrepotKv {
  private carte = new Map<string, string>();

  async lire(cle: string): Promise<string | null> {
    return this.carte.get(cle) ?? null;
  }
  async ecrire(cle: string, valeur: string): Promise<void> {
    this.carte.set(cle, valeur);
  }
  async supprimer(cle: string): Promise<void> {
    this.carte.delete(cle);
  }
  async cles(): Promise<string[]> {
    return [...this.carte.keys()];
  }
}

const NOM_BASE = "gen3ia-coffre";
const NOM_MAGASIN = "documents";

/** Entrepôt IndexedDB (navigateur) — un seul magasin, borné et simple. */
export class EntrepotIndexedDb implements EntrepotKv {
  private promesseBase: Promise<IDBDatabase> | null = null;

  private ouvrir(): Promise<IDBDatabase> {
    if (this.promesseBase) return this.promesseBase;
    this.promesseBase = new Promise((resoudre, rejeter) => {
      if (typeof indexedDB === "undefined") {
        rejeter(new Error("IndexedDB indisponible dans cet environnement."));
        return;
      }
      const demande = indexedDB.open(NOM_BASE, 1);
      demande.onupgradeneeded = () => {
        const base = demande.result;
        if (!base.objectStoreNames.contains(NOM_MAGASIN)) {
          base.createObjectStore(NOM_MAGASIN);
        }
      };
      demande.onsuccess = () => resoudre(demande.result);
      demande.onerror = () => rejeter(demande.error ?? new Error("IndexedDB refusé."));
    });
    return this.promesseBase;
  }

  private async transaction<T>(
    mode: IDBTransactionMode,
    operation: (magasin: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const base = await this.ouvrir();
    return new Promise<T>((resoudre, rejeter) => {
      const transaction = base.transaction(NOM_MAGASIN, mode);
      const magasin = transaction.objectStore(NOM_MAGASIN);
      const demande = operation(magasin);
      demande.onsuccess = () => resoudre(demande.result);
      demande.onerror = () => rejeter(demande.error ?? new Error("Opération IndexedDB en échec."));
    });
  }

  async lire(cle: string): Promise<string | null> {
    try {
      const valeur = await this.transaction<string | undefined>("readonly", (m) => m.get(cle));
      return valeur ?? null;
    } catch {
      return null;
    }
  }

  async ecrire(cle: string, valeur: string): Promise<void> {
    await this.transaction("readwrite", (m) => m.put(valeur, cle));
  }

  async supprimer(cle: string): Promise<void> {
    await this.transaction("readwrite", (m) => m.delete(cle));
  }

  async cles(): Promise<string[]> {
    try {
      const cles = await this.transaction<IDBValidKey[]>("readonly", (m) => m.getAllKeys());
      return cles.map(String);
    } catch {
      return [];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Chiffrement WebCrypto — AES-GCM 256, PBKDF2-SHA256                  */
/* ------------------------------------------------------------------ */

const ITERATIONS_PBKDF2 = 150_000;
const TAILLE_IV = 12;

function versBase64(octets: Uint8Array): string {
  let binaire = "";
  for (let i = 0; i < octets.length; i++) binaire += String.fromCharCode(octets[i]);
  return btoa(binaire);
}

/** Octets garantis sur ArrayBuffer (exigence des types WebCrypto TS 5.7+). */
type Octets = Uint8Array<ArrayBuffer>;

function depuisBase64(texte: string): Octets {
  const binaire = atob(texte);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return octets as Octets;
}

function subtile(): SubtleCrypto | null {
  try {
    return typeof crypto !== "undefined" && crypto.subtle ? crypto.subtle : null;
  } catch {
    return null;
  }
}

/** Enregistrement chiffré tel que stocké (le contenu est illisible). */
export interface EnregistrementChiffre {
  v: 1;
  /** Sel PBKDF2 (base64). */
  sel: string;
  /** Vecteur d'initialisation AES-GCM (base64). */
  iv: string;
  /** Contenu chiffré (base64). */
  donnees: string;
  /** Étiquette EN CLAIR (l'utilisateur la voit dans la liste — jamais le contenu). */
  etiquette: string;
  /** Taille du texte original en caractères. */
  taille: number;
  /** Empreinte FNV du texte original (déduplication, sans révéler le texte). */
  empreinte: string;
  ts: number;
}

/** FNV-1a 32 bits — empreinte légère déterministe (même famille que W-DNN). */
export function empreinteFnv(texte: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < texte.length; i++) {
    h ^= texte.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Texte encodable/décodable (UTF-16 → octets) sans perte. */
function encoderTexte(texte: string): Octets {
  return new TextEncoder().encode(texte) as Octets;
}

function decoderTexte(octets: BufferSource): string {
  return new TextDecoder().decode(octets);
}

export class CoffreChiffre {
  private cle: CryptoKey | null = null;
  private sel: Octets | null = null;

  /**
   * Déverrouille le coffre : le sel aléatoire est créé une fois et
   * persisté dans l'entrepôt (clé méta) — la même phrase secrète
   * re-dérive la même clef d'une session à l'autre ; une phrase
   * différente dérive une autre clef (échec propre de déchiffrement).
   */
  async deverrouiller(entrepot: EntrepotKv, motDePasse: string): Promise<void> {
    const subtileCrypto = subtile();
    if (!subtileCrypto) {
      throw new Error("WebCrypto indisponible — le coffre chiffré exige un navigateur moderne.");
    }
    if (!motDePasse) throw new Error("Le coffre exige une phrase secrète.");

    this.sel = await this.selPersistee(entrepot);
    const materiau = await subtileCrypto.importKey(
      "raw",
      encoderTexte(motDePasse),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    this.cle = await subtileCrypto.deriveKey(
      { name: "PBKDF2", salt: this.sel, iterations: ITERATIONS_PBKDF2, hash: "SHA-256" },
      materiau,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }

  /** Sel méta : aléatoire, créé au premier déverrouillage, puis stable. */
  private async selPersistee(entrepot: EntrepotKv): Promise<Octets> {
    const CLE_SEL = "__sel-coffre__";
    const brut = await entrepot.lire(CLE_SEL);
    if (brut) {
      try {
        return depuisBase64(brut);
      } catch {
        // Sel illisible : on en regénère un (les anciens enregistrements
        // resteront indéchiffrables — perte assumée, jamais de silencieux).
      }
    }
    const sel = crypto.getRandomValues(new Uint8Array(16)) as Octets;
    await entrepot.ecrire(CLE_SEL, versBase64(sel));
    return sel;
  }

  get estDeverrouille(): boolean {
    return this.cle !== null;
  }

  /** Chiffre et stocke un document. Renvoie l'identifiant de l'entrée. */
  async ecrire(
    entrepot: EntrepotKv,
    texte: string,
    etiquette: string,
    id?: string,
  ): Promise<string> {
    if (!this.cle) throw new Error("Coffre verrouillé — déverrouillez-le d'abord.");
    if (!texte.trim()) throw new Error("Document vide refusé.");
    const subtileCrypto = subtile()!;
    const iv = crypto.getRandomValues(new Uint8Array(TAILLE_IV));
    const chiffre = await subtileCrypto.encrypt(
      { name: "AES-GCM", iv },
      this.cle,
      encoderTexte(texte) as unknown as BufferSource,
    );
    const identifiant = id ?? `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const enregistrement: EnregistrementChiffre = {
      v: 1,
      sel: versBase64(this.sel!),
      iv: versBase64(iv),
      donnees: versBase64(new Uint8Array(chiffre)),
      etiquette: etiquette.slice(0, 120),
      taille: texte.length,
      empreinte: empreinteFnv(texte),
      ts: Date.now(),
    };
    await entrepot.ecrire(identifiant, JSON.stringify(enregistrement));
    return identifiant;
  }

  /** Déchiffre un document localement (jamais transmis). */
  async lire(entrepot: EntrepotKv, id: string): Promise<string> {
    if (!this.cle) throw new Error("Coffre verrouillé — déverrouillez-le d'abord.");
    const brut = await entrepot.lire(id);
    if (!brut) throw new Error(`Document « ${id} » introuvable.`);
    const enregistrement = JSON.parse(brut) as EnregistrementChiffre;
    const subtileCrypto = subtile()!;
    const clair = await subtileCrypto.decrypt(
      { name: "AES-GCM", iv: depuisBase64(enregistrement.iv) },
      this.cle,
      depuisBase64(enregistrement.donnees) as unknown as BufferSource,
    );
    return decoderTexte(clair);
  }

  /** Liste les ENTRÉES (métadonnées seulement — jamais le contenu). */
  async lister(entrepot: EntrepotKv): Promise<Array<{ id: string; etiquette: string; taille: number; empreinte: string; ts: number }>> {
    const cles = await entrepot.cles();
    const entrees: Array<{ id: string; etiquette: string; taille: number; empreinte: string; ts: number }> = [];
    for (const id of cles) {
      const brut = await entrepot.lire(id);
      if (!brut) continue;
      try {
        const e = JSON.parse(brut) as EnregistrementChiffre;
        entrees.push({ id, etiquette: e.etiquette, taille: e.taille, empreinte: e.empreinte, ts: e.ts });
      } catch {
        // Entrée corrompue : listée comme opaque, jamais déchiffrée à l'insu.
      }
    }
    return entrees.sort((a, b) => b.ts - a.ts);
  }

  async supprimer(entrepot: EntrepotKv, id: string): Promise<void> {
    await entrepot.supprimer(id);
  }
}
