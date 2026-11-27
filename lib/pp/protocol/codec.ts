/**
 * PP PROTOCOLE — contrats binaires Protobuf + framing tunnel (Phase 4).
 *
 * Le JSON lourd est remplacé par des messages binaires typés (plan PP §1,
 * ligne « Sérialisation des données »). La charge utile (paramètres des
 * commandes) reste du JSON UTF-8 dans un champ bytes : les nouveaux champs
 * de commande n'exigent aucune recompilation du schéma — le contrat
 * structurel (corrélation, commande, horodatage, erreurs) lui est STRICT.
 */

import { load as loadProto, type Type } from "protobufjs";
import path from "node:path";

export const PP_FRAME_MAX_BYTES = 1_048_576; // 1 Mio — au-delà : fragmentation refusée (fail-closed)

/** Contrat Protobuf PP v1 — chargé une seule fois par processus. */
let protocolPromise: Promise<Type> | null = null;

export function loadPpProtocol(): Promise<Type> {
  if (!protocolPromise) {
    protocolPromise = loadProto(path.resolve(import.meta.dirname, "pp.proto")).then((root) => {
      const messageType = root.lookupType("pp.v1.PpMessage");
      if (!messageType) throw new Error("pp.proto : type pp.v1.PpMessage introuvable");
      return messageType;
    });
  }
  return protocolPromise;
}

export type PpMessageKind = "REQUEST" | "RESPONSE" | "EVENT" | "PING" | "PONG" | "ERROR";

export interface PpMessage {
  kind: PpMessageKind;
  /** Identifiant de corrélation RPC (uuid v4 côté émetteur). */
  id: string;
  command?: string;
  /** Paramètres JSON UTF-8 (ou résultat). */
  payload?: Uint8Array;
  timestampMs?: bigint;
  errorCode?: string;
  errorMessage?: string;
  confirmationRequired?: boolean;
}

/** Encodage Protobuf strict (throw sur champ inconnu — pas de drift silencieux). */
export async function encodePpMessage(message: PpMessage): Promise<Uint8Array> {
  const type = await loadPpProtocol();
  const instance = type.fromObject({
    kind: message.kind,
    id: message.id,
    command: message.command ?? "",
    payload: message.payload ?? null,
    timestampMs: message.timestampMs ?? BigInt(Date.now()),
    errorCode: message.errorCode ?? "",
    errorMessage: message.errorMessage ?? "",
    confirmationRequired: message.confirmationRequired ?? false,
  });
  return type.encode(instance).finish();
}

export async function decodePpMessage(bytes: Uint8Array): Promise<PpMessage> {
  const type = await loadPpProtocol();
  const decoded = type.toObject(type.decode(bytes), { defaults: false, longs: BigInt, enums: String });
  return {
    kind: (decoded.kind ?? "REQUEST") as PpMessageKind,
    id: decoded.id ?? "",
    command: decoded.command || undefined,
    payload: decoded.payload && decoded.payload.length > 0 ? new Uint8Array(decoded.payload) : undefined,
    timestampMs: decoded.timestampMs,
    errorCode: decoded.errorCode || undefined,
    errorMessage: decoded.errorMessage || undefined,
    confirmationRequired: decoded.confirmationRequired || undefined,
  };
}

/** Frame tunnel : préfixe de longueur 4 octets big-endian + contenu Noise. */
export function frameEncode(content: Uint8Array): Buffer {
  if (content.length > PP_FRAME_MAX_BYTES) throw new Error(`PP frame trop grande : ${content.length} > ${PP_FRAME_MAX_BYTES}`);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(content.length, 0);
  return Buffer.concat([header, Buffer.from(content)]);
}

export const FRAME_HEADER_BYTES = 4;

/** Découpe un tampon d'arrivée en frames complètes (accumulateur de flux). */
export class FrameAssembler {
  private buffer = Buffer.alloc(0);

  /** Retourne toutes les frames complètes contenues dans le fragment reçu. */
  push(fragment: Uint8Array): Uint8Array[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(fragment)]);
    const frames: Uint8Array[] = [];
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const length = this.buffer.readUInt32BE(0);
      if (length > PP_FRAME_MAX_BYTES) throw new Error(`PP frame refusée : longueur ${length} hors bornes`);
      if (this.buffer.length < FRAME_HEADER_BYTES + length) break;
      frames.push(new Uint8Array(this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)));
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length);
    }
    return frames;
  }
}
