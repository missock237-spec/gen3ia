/**
 * Noyau pur du domaine « mémoire permanente clé/valeur » (aucune dépendance
 * Firestore : tout est testable unitairement).
 *
 * Contrat de doublon retenu (choix SaaS entreprise) :
 *  - clé ABSENTE                → écriture normale (« create ») ;
 *  - clé présente, valeur IDENTIQUE (après normalisation) → 200 idempotent
 *    (« identical ») : répéter la même écriture ne doit rien casser ni
 *    rafraîchir artificiellement la date de mise à jour ;
 *  - clé présente, valeur DIFFÉRENTE, sans consentement explicite → CONFLIT
 *    (« conflict », HTTP 409) : l'écrasement silencieux rendait la perte de
 *    données invisible. L'appelant doit renvoyer `overwrite: true` pour
 *    confirmer le remplacement, ce qui laisse une trace d'intention claire
 *    côté API et permet à l'UI d'afficher une confirmation.
 */

const MAX_VALUE_BYTES = 50_000;

/** Motifs de secrets interdits dans les valeurs (politique anti-fuite). */
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/i,
  /AIza[0-9A-Za-z_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{20,}/i,
  /bearer\s+[A-Za-z0-9._-]{20,}/i,
  /password\s*[:=]/i,
  /api[_ -]?key\s*[:=]/i,
  /secret\s*[:=]/i,
] as const;

/**
 * Forme canonique d'une valeur telle qu'elle est stockée (chaîne) : un objet
 * est sérialisé en JSON pour que la comparaison de doublons soit stable entre
 * deux envois `{"a":1}` et `{ a: 1 }`.
 * Fonction pure : ne jette jamais (retourne "" pour vide).
 */
export function normalizeMemoryValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/**
 * Garde-fou secrets/taille (comportement historique préservé, NE PAS casser) :
 * renvoie la forme canonique à stocker ou lève une erreur explicite.
 */
export function assertSafeMemoryValue(value: unknown): string {
  const text = normalizeMemoryValue(value);
  if (!text) throw new Error("Memory value cannot be empty.");
  if (Buffer.byteLength(text, "utf8") > MAX_VALUE_BYTES) throw new Error("Memory value exceeds the allowed size.");
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) throw new Error("Memory rejected because it appears to contain credentials or secrets.");
  return text;
}

export type DuplicateDecisionAction = "create" | "identical" | "conflict";

export interface DuplicateDecision {
  action: DuplicateDecisionAction;
}

export interface DuplicateEvaluationInput {
  /** L'entrée existe-t-elle déjà pour cet utilisateur ? */
  exists: boolean;
  /** Valeur actuellement stockée (déjà normalisée côté persistance). */
  existingValue?: string;
  /** Nouvelle valeur proposée (n'importe quel type JSON). */
  incomingValue: unknown;
  /** Consentement explicite d'écrasement (champ `overwrite` de l'appel). */
  overwrite: boolean;
}

/**
 * Décision pure d'écriture en présence d'une clé potentiellement existante.
 * L'identité des valeurs est comparée sur la forme canonique (voir
 * normalizeMemoryValue) : « même contenu » ≠ « même référence objet ».
 */
export function evaluateDuplicateWrite(input: DuplicateEvaluationInput): DuplicateDecision {
  if (!input.exists) return { action: "create" };
  if (input.overwrite) return { action: "create" }; // Écrasement consenti explicitement.
  const incoming = normalizeMemoryValue(input.incomingValue);
  if (incoming === input.existingValue) return { action: "identical" };
  return { action: "conflict" };
}
