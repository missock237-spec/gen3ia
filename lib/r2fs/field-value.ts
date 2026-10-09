import "server-only";

import { isArrayRemoveSentinel, isArrayUnionSentinel, isDeleteSentinel, isIncrementSentinel, isServerTimestampSentinel, type SentinelKind } from "./serialization";

/**
 * MIGRATION R2 TOTALE — moteur r2fs (FieldValue).
 *
 * Drop-in de `FieldValue` de firebase-admin/firestore : CLASSE à méthodes
 * statiques — utilisable comme VALEUR (FieldValue.increment(...)) ET comme
 * TYPE (positions `Timestamp | FieldValue` héritées du projet).
 *
 * Les instances SONT les sentinelles (marqueurs internes portant
 * `__fs_sentinel__`) : résolues par le moteur à l'écriture (increment →
 * lecture+CAS ; delete → champ retiré ; serverTimestamp → horodatage du
 * commit ; arrayUnion/arrayRemove → fusion de tableau). AUCUNE sentinelle
 * n'est jamais persistée.
 */
export class FieldValue {
  // Même nom de propriété que les sentinelles du moteur (duck-typing isSentinel).
  readonly __fs_sentinel__: SentinelKind["__fs_sentinel__"];
  readonly operand?: number;
  readonly values?: unknown[];

  private constructor(kind: SentinelKind["__fs_sentinel__"], operand?: number, values?: unknown[]) {
    this.__fs_sentinel__ = kind;
    this.operand = operand;
    this.values = values;
  }

  /** Incrémente un champ numérique (opérande négatif accepté). */
  static increment(operand: number): FieldValue {
    if (typeof operand !== "number" || !Number.isFinite(operand)) {
      throw new Error("FieldValue.increment: opérande numérique fini requis.");
    }
    return new FieldValue("increment", operand);
  }

  /** Supprime le champ du document (set/merge et update). */
  static delete(): FieldValue {
    return new FieldValue("delete");
  }

  /** Horodatage serveur (millisecondes du commit). */
  static serverTimestamp(): FieldValue {
    return new FieldValue("serverTimestamp");
  }

  /** Union de tableau (éléments ajoutés s'ils n'y sont pas déjà). */
  static arrayUnion(...values: unknown[]): FieldValue {
    return new FieldValue("arrayUnion", undefined, values);
  }

  /** Retrait de tableau (toutes les occurrences de chaque valeur). */
  static arrayRemove(...values: unknown[]): FieldValue {
    return new FieldValue("arrayRemove", undefined, values);
  }

  /** Vue sentinelle pour le moteur (l'instance EST déjà une sentinelle). */
  toSentinel(): SentinelKind {
    switch (this.__fs_sentinel__) {
      case "increment":
        return { __fs_sentinel__: "increment", operand: this.operand ?? 0 };
      case "arrayUnion":
        return { __fs_sentinel__: "arrayUnion", values: this.values ?? [] };
      case "arrayRemove":
        return { __fs_sentinel__: "arrayRemove", values: this.values ?? [] };
      default:
        return { __fs_sentinel__: this.__fs_sentinel__ } as SentinelKind;
    }
  }
}

/** Garde d'usage (réexport sémantique, utilisée par le moteur). */
export {
  isDeleteSentinel,
  isIncrementSentinel,
  isServerTimestampSentinel,
  isArrayUnionSentinel,
  isArrayRemoveSentinel,
};
