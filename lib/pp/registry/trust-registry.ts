/**
 * PP REGISTRE — base de confiance (Phase 1 du plan PP).
 *
 * Contient UNIQUEMENT des données publiques : identifiants d'applications
 * (AppID), clés publiques autorisées (PeerID = clé matérielle, clé statique
 * de transport), statut (en_attente/actif/révoqué), adresses réseau
 * temporaires et jetons d'invitation à usage unique. Aucune donnée métier.
 *
 * Bootstrap trust (plan §3/§4) : un PeerID n'existe dans le registre que via
 * un jeton d'invitation à usage unique consommé à l'enrôlement, puis
 * approuvé par l'administrateur (validation manuelle). Un pair « en_attente »
 * ne peut RIEN faire — ni résoudre des adresses, ni ouvrir un tunnel.
 */

import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type PeerStatus = "en_attente" | "actif" | "revoque";
export type HardwareAlgorithm = "ed25519" | "ecdsa-p256";

export interface PeerRecord {
  appId: string;
  /** PeerID = hex(SHA-256 de la clé matérielle publique) — identité du registre. */
  peerId: string;
  /** Clé PUBLIQUE matérielle brute (hex) — vérification des défis signés. */
  hardwarePubKey: string;
  /** Algorithme de signature matériel (Ed25519 serveurs, ECDSA P-256 web). */
  hardwareAlgo: HardwareAlgorithm;
  /** Clé statique de transport Noise (hex, 32 octets) pour l'optimisation IK. */
  transportStaticPub: string;
  status: PeerStatus;
  label?: string;
  createdAt: string;
  approvedAt?: string;
  revokedAt?: string;
  enrolledViaToken: string;
  addresses: Array<{ addr: string; seenAt: string }>;
  lastSeenAt?: string;
}

export interface InvitationToken {
  token: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  usedByPeerId?: string;
  label?: string;
}

export interface TrustRegistrySnapshot {
  peers: Record<string, PeerRecord>;
  tokens: Record<string, InvitationToken>;
}

export interface RegistryStorage {
  load(): Promise<TrustRegistrySnapshot | null>;
  save(snapshot: TrustRegistrySnapshot): Promise<void>;
}

/** Stockage mémoire — tests et démo. */
export class MemoryRegistryStorage implements RegistryStorage {
  private snapshot: TrustRegistrySnapshot | null = null;
  async load(): Promise<TrustRegistrySnapshot | null> {
    return this.snapshot;
  }
  async save(snapshot: TrustRegistrySnapshot): Promise<void> {
    this.snapshot = snapshot;
  }
}

/** Stockage fichier JSON (conteneur persistant Hyperlift / cPanel). */
export class FileRegistryStorage implements RegistryStorage {
  constructor(private readonly filePath: string) {}
  async load(): Promise<TrustRegistrySnapshot | null> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as TrustRegistrySnapshot;
    } catch {
      return null;
    }
  }
  async save(snapshot: TrustRegistrySnapshot): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(snapshot, null, 1), { mode: 0o600 });
  }
}

export type RegistryEvent = { type: "enroll" | "approve" | "revoke" | "token_create" | "token_consume"; peerId?: string; appId?: string; at: string };

export class TrustRegistry {
  private peers: Record<string, PeerRecord> = {};
  private tokens: Record<string, InvitationToken> = {};
  private listeners: Array<(event: RegistryEvent) => void> = [];

  constructor(private readonly storage?: RegistryStorage) {}

  async init(): Promise<void> {
    const snapshot = await this.storage?.load();
    if (snapshot) {
      this.peers = snapshot.peers ?? {};
      this.tokens = snapshot.tokens ?? {};
    }
  }

  onEvent(listener: (event: RegistryEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: RegistryEvent): void {
    for (const listener of this.listeners) listener(event);
    void this.storage?.save(this.snapshot());
  }

  snapshot(): TrustRegistrySnapshot {
    return { peers: { ...this.peers }, tokens: { ...this.tokens } };
  }

  /** Création d'un jeton d'invitation à usage unique (tableau de bord admin). */
  createInvitation(opts: { ttlHours?: number; label?: string } = {}): InvitationToken {
    const token: InvitationToken = {
      token: crypto.randomBytes(24).toString("hex"),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (opts.ttlHours ?? 24) * 3_600_000).toISOString(),
      label: opts.label,
    };
    this.tokens[token.token] = token;
    this.emit({ type: "token_create", at: token.createdAt });
    return token;
  }

  /**
   * Enrôlement : consomme le jeton (usage unique + expiration) et enregistre
   * le pair en « en_attente ». Un AppID donné ne peut pas prendre le PeerID
   * d'un autre AppID (vol d'identité refusé).
   */
  async enroll(appId: string, peerId: string, hardwarePubKey: string, hardwareAlgo: HardwareAlgorithm, transportStaticPub: string, invitationToken: string): Promise<PeerRecord> {
    const token = this.tokens[invitationToken];
    if (!token) throw new Error("PP enrôlement : jeton d'invitation inconnu");
    if (token.usedAt) throw new Error("PP enrôlement : jeton déjà consommé (usage unique)");
    if (Date.now() > Date.parse(token.expiresAt)) throw new Error("PP enrôlement : jeton expiré");

    const existing = this.peers[peerId];
    if (existing && existing.appId !== appId) throw new Error("PP enrôlement : PeerID déjà enrôlé sous un autre AppID");

    token.usedAt = new Date().toISOString();
    token.usedByPeerId = peerId;
    const record: PeerRecord = {
      appId,
      peerId,
      hardwarePubKey,
      hardwareAlgo,
      transportStaticPub,
      status: "en_attente",
      createdAt: token.usedAt,
      enrolledViaToken: invitationToken.slice(0, 8) + "…",
      addresses: [],
    };
    this.peers[peerId] = record;
    this.emit({ type: "token_consume", at: token.usedAt });
    this.emit({ type: "enroll", peerId, appId, at: record.createdAt });
    return record;
  }

  /** Approbation manuelle (tableau de bord) : en_attente → actif. */
  approve(peerId: string, label?: string): PeerRecord {
    const record = this.require(peerId);
    if (record.status === "revoque") throw new Error("PP : un pair révoqué doit être re-enrôlé avec un nouveau jeton");
    record.status = "actif";
    record.approvedAt = new Date().toISOString();
    if (label) record.label = label;
    this.emit({ type: "approve", peerId, at: record.approvedAt });
    return record;
  }

  /** Révocation instantanée : coupe les tunnels vivants via les listeners. */
  revoke(peerId: string): PeerRecord {
    const record = this.require(peerId);
    record.status = "revoque";
    record.revokedAt = new Date().toISOString();
    record.addresses = [];
    this.emit({ type: "revoke", peerId, at: record.revokedAt });
    return record;
  }

  require(peerId: string): PeerRecord {
    const record = this.peers[peerId];
    if (!record) throw new Error(`PP registre : peer inconnu ${peerId.slice(0, 12)}…`);
    return record;
  }

  get(peerId: string): PeerRecord | undefined {
    return this.peers[peerId];
  }

  isActive(peerId: string): boolean {
    return this.peers[peerId]?.status === "actif";
  }

  list(status?: PeerStatus): PeerRecord[] {
    return Object.values(this.peers).filter((p) => !status || p.status === status);
  }

  listTokens(): InvitationToken[] {
    return Object.values(this.tokens);
  }

  /** Résolution d'adresses — réservée aux pairs ACTIFS (anti-reconnaissance). */
  resolveAddresses(peerId: string): Array<{ addr: string; seenAt: string }> {
    if (!this.isActive(peerId)) throw new Error("PP registre : résolution réservée aux pairs actifs");
    return [...(this.peers[peerId]?.addresses ?? [])];
  }

  recordAddress(peerId: string, addr: string): void {
    const record = this.peers[peerId];
    if (!record) throw new Error("PP registre : peer inconnu");
    const seenAt = new Date().toISOString();
    record.addresses = [{ addr, seenAt }, ...record.addresses.filter((a) => a.addr !== addr)].slice(0, 4);
    record.lastSeenAt = seenAt;
    void this.storage?.save(this.snapshot());
  }

  /** Mise à jour de la clé statique de transport (rotation du SDK). */
  updateTransportStaticPub(peerId: string, transportStaticPub: string): void {
    this.require(peerId).transportStaticPub = transportStaticPub;
    void this.storage?.save(this.snapshot());
  }
}

/** PeerID attendu : hex(SHA-256(clé publique matérielle)). */
export function peerIdFromPublicKey(publicKey: Uint8Array): string {
  return crypto.createHash("sha256").update(Buffer.from(publicKey)).digest("hex");
}
