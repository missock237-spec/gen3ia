/**
 * PP NOISE — CipherState et SymmetricState (Noise rev34 §4.1, §5.2).
 * Implémentation littérale de la spécification ; validée bit à bit par les
 * vecteurs officiels cacophony/snow (tests/unit/pp-noise-vectors.test.ts).
 */

import { aeadDecrypt, aeadEncrypt, hashBytes, noiseHkdf, HASH_LENGTHS, MAX_NONCE, type CipherName, type HashName } from "./suite";

export class NoiseCipherState {
  private key: Buffer | null = null;
  private nonce = 0n;

  constructor(private readonly algorithm: CipherName, private readonly hash: HashName) {}

  initializeKey(key: Uint8Array | null): void {
    this.key = key && key.length > 0 ? Buffer.from(key) : null;
    this.nonce = 0n;
  }

  hasKey(): boolean {
    return this.key !== null;
  }

  setNonce(nonce: bigint): void {
    this.nonce = nonce;
  }

  /** Compteur courant — utilisé par le tunnel pour la rotation de clés. */
  get nonceValue(): bigint {
    return this.nonce;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Buffer {
    if (this.nonce === MAX_NONCE) throw new Error("Noise: nonce épuisé (2^64-1) — session à rekeyer");
    if (!this.key) return Buffer.from(plaintext);
    const out = aeadEncrypt(this.algorithm, this.key, this.nonce, ad, plaintext);
    this.nonce += 1n;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Buffer {
    if (this.nonce === MAX_NONCE) throw new Error("Noise: nonce épuisé (2^64-1) — session à rekeyer");
    if (!this.key) return Buffer.from(ciphertext);
    const out = aeadDecrypt(this.algorithm, this.key, this.nonce, ad, ciphertext);
    this.nonce += 1n;
    return out;
  }

  /** Rotation de clé (Perfect Forward Secrecy continu, rev34 §4.2). */
  rekey(): void {
    if (!this.key) throw new Error("Noise: rekey sans clé initialisée");
    const next = aeadEncrypt(this.algorithm, this.key, MAX_NONCE, new Uint8Array(0), new Uint8Array(32));
    this.key = Buffer.from(next.subarray(0, 32));
  }
}

export class NoiseSymmetricState {
  private chainingKey: Buffer;
  private handshakeHash: Buffer;
  readonly cipherState: NoiseCipherState;

  constructor(
    readonly protocolName: string,
    private readonly algorithm: CipherName,
    private readonly hash: HashName,
  ) {
    const nameBytes = Buffer.from(protocolName, "utf8");
    if (nameBytes.length <= HASH_LENGTHS[hash]) {
      this.handshakeHash = Buffer.concat([nameBytes, Buffer.alloc(HASH_LENGTHS[hash] - nameBytes.length)]);
    } else {
      this.handshakeHash = hashBytes(hash, nameBytes);
    }
    this.chainingKey = Buffer.from(this.handshakeHash);
    this.cipherState = new NoiseCipherState(algorithm, hash);
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = noiseHkdf(this.chainingKey, ikm, 2, this.hash);
    this.chainingKey = ck;
    this.cipherState.initializeKey(tempK);
  }

  mixHash(data: Uint8Array): void {
    this.handshakeHash = hashBytes(this.hash, Buffer.concat([this.handshakeHash, Buffer.from(data)]));
  }

  hasKey(): boolean {
    return this.cipherState.hasKey();
  }

  encryptAndHash(plaintext: Uint8Array): Buffer {
    let ciphertext: Buffer;
    if (this.cipherState.hasKey()) {
      ciphertext = this.cipherState.encryptWithAd(this.handshakeHash, plaintext);
      this.mixHash(ciphertext);
    } else {
      ciphertext = Buffer.from(plaintext);
      this.mixHash(plaintext);
    }
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Buffer {
    let plaintext: Buffer;
    if (this.cipherState.hasKey()) {
      plaintext = this.cipherState.decryptWithAd(this.handshakeHash, ciphertext);
      this.mixHash(ciphertext);
    } else {
      plaintext = Buffer.from(ciphertext);
      this.mixHash(ciphertext);
    }
    return plaintext;
  }

  split(): { c1: NoiseCipherState; c2: NoiseCipherState; handshakeHash: Buffer; chainingKey: Buffer } {
    const [tempK1, tempK2] = noiseHkdf(this.chainingKey, new Uint8Array(0), 2, this.hash);
    const c1 = new NoiseCipherState(this.algorithm, this.hash);
    const c2 = new NoiseCipherState(this.algorithm, this.hash);
    c1.initializeKey(tempK1);
    c2.initializeKey(tempK2);
    return { c1, c2, handshakeHash: Buffer.from(this.handshakeHash), chainingKey: Buffer.from(this.chainingKey) };
  }

  get hashValue(): Buffer {
    return Buffer.from(this.handshakeHash);
  }
}
