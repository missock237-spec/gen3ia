/**
 * PP NOISE — HandshakeState (Noise rev34 §5.3) pour les schémas XX et IK.
 *
 * · XX : découverte mutuelle des clés statiques (par défaut PP) — 3 messages.
 * · IK : clé statique du répondant pré-partagée (optimisation au ré-appel) — 2 messages.
 *
 * Convention d'indices : l'initiateur ÉCRIT aux indices pairs et lit aux
 * impairs ; le répondant fait l'inverse. currentTokens() est donc identique
 * pour les deux rôles à un même indice.
 *
 * La conformité est prouvée bit à bit par les vecteurs officiels
 * cacophony (Go) et snow (Rust) — voir vectors/official-vectors.json.
 */

import { NoiseSymmetricState, type NoiseCipherState } from "./state";
import { hashBytes, x25519Dh, x25519FromScalar, x25519Generate, type CipherName, type DhKeyPair, type HashName } from "./suite";

export type NoisePattern = "XX" | "IK";

export interface NoiseKeyPairInput {
  s?: DhKeyPair;
  /** Clé éphémère injectée — utilisée par les vecteurs officiels uniquement. */
  e?: DhKeyPair;
  /** Clé statique distante attendue (initiateur IK) — 32 octets bruts. */
  rs?: Uint8Array;
}

/** Messages de chaque schéma, dans l'ordre (rev34 §7). */
const MESSAGE_PATTERNS: Record<NoisePattern, string[][]> = {
  XX: [["e"], ["e", "ee", "s", "es"], ["s", "se"]],
  IK: [["e", "es", "s", "ss"], ["e", "ee", "se"]],
};

/** Nom de protocole Noise complet, ex. « Noise_XX_25519_ChaChaPoly_SHA256 ». */
export function protocolName(pattern: NoisePattern, algorithm: CipherName, hash: HashName): string {
  return `Noise_${pattern}_25519_${algorithm}_${hash}`;
}

export interface HandshakeResult {
  /** CipherState d'ENVOI (c1 pour l'initiateur, c2 pour le répondant). */
  send: NoiseCipherState;
  /** CipherState de RÉCEPTION. */
  recv: NoiseCipherState;
  handshakeHash: Buffer;
  remoteStatic: Buffer | null;
}

export class NoiseHandshake {
  private readonly symmetric: NoiseSymmetricState;
  private readonly initiator: boolean;
  private readonly pattern: NoisePattern;
  private s: DhKeyPair | null;
  private e: DhKeyPair | null;
  private rs: Buffer | null = null;
  private re: Buffer | null = null;
  private messageIndex = 0;

  constructor(opts: { pattern: NoisePattern; initiator: boolean; prologue: Uint8Array; algorithm: CipherName; hash: HashName; keys?: NoiseKeyPairInput }) {
    const name = protocolName(opts.pattern, opts.algorithm, opts.hash);
    this.pattern = opts.pattern;
    this.initiator = opts.initiator;
    this.s = opts.keys?.s ?? null;
    this.e = opts.keys?.e ?? null;
    this.symmetric = new NoiseSymmetricState(name, opts.algorithm, opts.hash);

    this.symmetric.mixHash(opts.prologue);

    // Pré-message IK (« ← s ») : la clé statique du répondant est connue des
    // deux côtés avant tout échange et mélangée au haché.
    if (this.pattern === "IK") {
      const staticPub = this.initiator ? opts.keys?.rs : this.s?.publicKey;
      if (!staticPub) throw new Error("Noise IK: la clé statique du répondant est requise (pré-message ← s)");
      this.rs = Buffer.from(staticPub);
      this.symmetric.mixHash(this.rs);
    }
  }

  /** Écrit un message de handshake : retourne les octets réseau. */
  writeMessage(payload: Uint8Array): Buffer {
    const writesNow = this.initiator ? this.messageIndex % 2 === 0 : this.messageIndex % 2 === 1;
    if (!writesNow) throw new Error("Noise: ce rôle ne peut pas écrire à ce tour du handshake");
    const tokens = MESSAGE_PATTERNS[this.pattern][this.messageIndex];
    if (!tokens) throw new Error("Noise: handshake déjà complet");

    const buffer: Buffer[] = [];
    for (const token of tokens) {
      if (token === "e") {
        this.e ??= x25519Generate();
        buffer.push(this.e.publicKey);
        this.symmetric.mixHash(this.e.publicKey);
      } else if (token === "s") {
        if (!this.s) throw new Error("Noise: clé statique locale requise (token s)");
        buffer.push(this.symmetric.encryptAndHash(this.s.publicKey));
      } else if (token === "ee") {
        if (!this.e || !this.re) throw new Error("Noise: ee sans clés éphémères");
        this.symmetric.mixKey(x25519Dh(this.e.privateKey, this.re));
      } else if (token === "es") {
        if (this.initiator) this.symmetric.mixKey(x25519Dh(this.requireE().privateKey, this.requireRs()));
        else this.symmetric.mixKey(x25519Dh(this.requireS().privateKey, this.requireRe()));
      } else if (token === "se") {
        if (this.initiator) this.symmetric.mixKey(x25519Dh(this.requireS().privateKey, this.requireRe()));
        else this.symmetric.mixKey(x25519Dh(this.requireE().privateKey, this.requireRs()));
      } else if (token === "ss") {
        // ss : statique locale × statique distante — symétrique pour les deux rôles.
        this.symmetric.mixKey(x25519Dh(this.requireS().privateKey, this.requireRs()));
      } else {
        throw new Error(`Noise: token inconnu ${token}`);
      }
    }
    buffer.push(this.symmetric.encryptAndHash(payload));
    this.messageIndex += 1;
    return Buffer.concat(buffer);
  }

  /** Lit un message de handshake : retourne la charge déchiffrée. */
  readMessage(message: Uint8Array): Buffer {
    const readsNow = this.initiator ? this.messageIndex % 2 === 1 : this.messageIndex % 2 === 0;
    if (!readsNow) throw new Error("Noise: ce rôle ne peut pas lire à ce tour du handshake");
    const tokens = MESSAGE_PATTERNS[this.pattern][this.messageIndex];
    if (!tokens) throw new Error("Noise: handshake déjà complet");

    let offset = 0;
    for (const token of tokens) {
      if (token === "e") {
        if (offset + 32 > message.length) throw new Error("Noise: message tronqué (e)");
        this.re = Buffer.from(message.subarray(offset, offset + 32));
        offset += 32;
        this.symmetric.mixHash(this.re);
      } else if (token === "s") {
        const length = this.symmetric.hasKey() ? 32 + 16 : 32;
        if (offset + length > message.length) throw new Error("Noise: message tronqué (s)");
        this.rs = this.symmetric.decryptAndHash(message.subarray(offset, offset + length));
        offset += length;
      } else if (token === "ee") {
        this.symmetric.mixKey(x25519Dh(this.requireE().privateKey, this.requireRe()));
      } else if (token === "es") {
        if (this.initiator) this.symmetric.mixKey(x25519Dh(this.requireE().privateKey, this.requireRs()));
        else this.symmetric.mixKey(x25519Dh(this.requireS().privateKey, this.requireRe()));
      } else if (token === "se") {
        if (this.initiator) this.symmetric.mixKey(x25519Dh(this.requireS().privateKey, this.requireRe()));
        else this.symmetric.mixKey(x25519Dh(this.requireE().privateKey, this.requireRs()));
      } else if (token === "ss") {
        this.symmetric.mixKey(x25519Dh(this.requireS().privateKey, this.requireRs()));
      } else {
        throw new Error(`Noise: token inconnu ${token}`);
      }
    }
    if (offset > message.length) throw new Error("Noise: message tronqué (charge)");
    const payload = this.symmetric.decryptAndHash(message.subarray(offset));
    this.messageIndex += 1;
    return payload;
  }

  isComplete(): boolean {
    return this.messageIndex >= MESSAGE_PATTERNS[this.pattern].length;
  }

  /** Split() — deux CipherStates : c1 chiffre les messages de l'initiateur,
   * c2 ceux du répondant (rev34 §5.3). */
  finish(): HandshakeResult {
    if (!this.isComplete()) throw new Error("Noise: handshake incomplet avant Split()");
    const { c1, c2, handshakeHash } = this.symmetric.split();
    return this.initiator ? { send: c1, recv: c2, handshakeHash, remoteStatic: this.rs ? Buffer.from(this.rs) : null } : { send: c2, recv: c1, handshakeHash, remoteStatic: this.rs ? Buffer.from(this.rs) : null };
  }

  get localStaticPublic(): Buffer | null {
    return this.s ? Buffer.from(this.s.publicKey) : null;
  }

  get remoteStaticPublic(): Buffer | null {
    return this.rs ? Buffer.from(this.rs) : null;
  }

  private requireS(): DhKeyPair {
    if (!this.s) throw new Error("Noise: clé statique locale absente");
    return this.s;
  }

  private requireE(): DhKeyPair {
    if (!this.e) throw new Error("Noise: clé éphémère locale absente");
    return this.e;
  }

  private requireRs(): Buffer {
    if (!this.rs) throw new Error("Noise: clé statique distante absente");
    return this.rs;
  }

  private requireRe(): Buffer {
    if (!this.re) throw new Error("Noise: clé éphémère distante absente");
    return this.re;
  }
}

/** Reconstruction d'une paire X25519 depuis un scalaire hexadécimal (vecteurs officiels). */
export function keyPairFromScalarHex(scalarHex: string): DhKeyPair {
  return x25519FromScalar(new Uint8Array(Buffer.from(scalarHex, "hex")));
}

/** Haché de handshake — empreinte de session côté tunnel. */
export function sessionFingerprint(handshakeHash: Buffer): string {
  return hashBytes("SHA256", handshakeHash).toString("hex").slice(0, 32);
}
