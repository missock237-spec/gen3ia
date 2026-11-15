import { z } from "zod";

import type { ToolDefinition } from "@/lib/tools/types";

/**
 * Task 140 — Tool « transcript.redact » (Call Transcription Redactor).
 *
 * Masquage TEMPS RÉEL des données sensibles dans une transcription d'appel :
 * numéros de carte bancaire (validation Luhn), CVV contextuel, IBAN, NIR
 * (sécurité sociale), identifiants/mots de passe, téléphones et emails.
 *
 * 100 % DÉTERMINISTE — aucun appel LLM : fiabilité et latence compatibles
 * avec un traitement en direct du flux de transcription.
 *
 * Garde-fous :
 *  - ORDRE D'APPLICATION critique (les cartes AVANT les téléphones : un PAN
 *    à 16 chiffres ne doit jamais être traité comme un numéro de téléphone,
 *    et le NIR avant les téléphones pour la même raison) ;
 *  - regex linéaires anti-ReDoS (aucun quantificateur imbriqué — classes de
 *    caractères disjointes, décomposition unique de chaque correspondance) ;
 *  - idempotence : appliquer l'outil sur sa propre sortie ne rajoute AUCUN
 *    masque (les masques ne contiennent pas de chiffres ré-examinables, et
 *    les identifiants déjà masqués en « • » sont ignorés) ;
 *  - aucun secret original ne sort de l'outil : les métadonnées ne portent
 *    que { type, index, length }.
 */

/* ────────────────────────────────────────────────────────────────────────
 * Entrée
 * ──────────────────────────────────────────────────────────────────────── */

const CustomPatternSchema = z.object({
  name: z.string().min(1).max(60),
  pattern: z.string().min(2).max(200),
});

const RedactOptionsSchema = z.object({
  /** Cartes bancaires, IBAN et CVV contextuel (données de paiement). */
  cardNumbers: z.boolean().default(true),
  /** Identifiants et mots de passe énoncés à l'oral. */
  credentials: z.boolean().default(true),
  /** NIR, téléphones et emails (données personnelles). */
  personalData: z.boolean().default(true),
  customPatterns: z.array(CustomPatternSchema).max(10).optional(),
});

const TranscriptRedactInput = z.object({
  transcript: z.string().min(1).max(200_000),
  // zod 4 : .prefault (et non .default) — la valeur passe par le parse, ce
  // qui laisse les défauts internes s'appliquer ({} → tout activé).
  options: RedactOptionsSchema.prefault({}),
});

/* ────────────────────────────────────────────────────────────────────────
 * Regex de détection — LINÉAIRES (anti-ReDoS)
 * ──────────────────────────────────────────────────────────────────────── */

/** Candidats PAN : 13 à 19 chiffres, séparateurs espace ou tiret uniquement. */
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
/** IBAN : 2 lettres + 2 chiffres de contrôle + 4 à 9 groupes alphanumériques. */
const IBAN_RE = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){4,9}\b/g;
/** CVV contextuel (FR + EN) : mot-clé, ≤ 15 non-chiffres, puis 3-4 chiffres. */
const CVV_CONTEXT_RE = /(?:cvv|cvc|cryptogramme|code de s[ée]curit[ée]|code secret)\D{0,15}(\d{3,4})\b/gi;
/** NIR français (numéro de sécurité sociale) — clé facultative. */
const NIR_RE = /\b[12]\s?\d{2}\s(?:0[1-9]|1[0-2])\s(?:2[A-Za-z]|\d{2})\s\d{3}\s\d{3}(?:\s\d{2})?\b/g;
/** Identifiants / mots de passe énoncés : contexte + séparateur + valeur. */
const CREDENTIALS_RE = /(?:mot de passe|password|mdp|mon code|code pin|identifiant)\s*(?:est|=|:)\s*(\S{4,80})/gi;
/** Téléphone international (indicatif +). */
const PHONE_INTL_RE = /\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d){6,12}\b/g;
/** Téléphone français (0 + 4 groupes de 2 chiffres). */
const PHONE_FR_RE = /\b0\d(?:[\s.-]?\d{2}){4}\b/g;
/** Adresse email. */
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g;

/** Clés de comptage par famille de masque (FR, stables dans byType). */
const TYPE_CARD = "cartes";
const TYPE_IBAN = "iban";
const TYPE_CVV = "cvv";
const TYPE_NIR = "nir";
const TYPE_CREDENTIALS = "identifiants";
const TYPE_PHONE = "telephones";
const TYPE_EMAIL = "emails";

/* ────────────────────────────────────────────────────────────────────────
 * Sortie
 * ──────────────────────────────────────────────────────────────────────── */

export interface TranscriptRedactMatch {
  /** Famille du masque (ou nom du motif personnalisé). */
  type: string;
  /** Position dans le tampon au moment du masquage (passes successives). */
  index: number;
  /** Longueur du segment remplacé — jamais le contenu lui-même. */
  length: number;
}

export interface TranscriptRedactResult {
  redacted: string;
  totalRedactions: number;
  byType: Record<string, number>;
  /** Métadonnées de localisation (aucun secret, aucune valeur capturée). */
  matches: TranscriptRedactMatch[];
  skippedPatterns: Array<{ name: string; reason: string }>;
}

/* ────────────────────────────────────────────────────────────────────────
 * Helpers déterministes
 * ──────────────────────────────────────────────────────────────────────── */

/** Validation Luhn (algorithme des cartes bancaires). */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = digits.charCodeAt(i) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
const isUpperAlnum = (ch: string): boolean => /[A-Z0-9]/.test(ch);

/**
 * Masque `text` en conservant la MISE EN PAGE d'origine (séparateurs) et les
 * `keep` derniers caractères éligibles (ex. 4 derniers chiffres d'une carte).
 */
function maskKeepLast(text: string, keep: number, eligible: (ch: string) => boolean): string {
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (eligible(text[i])) total += 1;
  }
  let seen = 0;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (eligible(ch)) {
      seen += 1;
      out += seen > total - keep ? ch : "•";
    } else {
      out += ch;
    }
  }
  return out;
}

interface PassContext {
  byType: Record<string, number>;
  matches: TranscriptRedactMatch[];
}

interface PassMatch {
  match: string;
  groups: string[];
  offset: number;
}

/**
 * Applique une passe de masquage : chaque correspondance est soumise au
 * `replacer` qui retourne la version masquée ou `null` (correspondance
 * laissée intacte — ex. PAN qui échoue à la validation Luhn).
 * Remarque : le `replacer` est une FONCTION, les « $ » éventuels d'un motif
 * personnalisé ne sont donc JAMAIS interpolés dans le remplacement.
 */
function applyPass(buffer: string, type: string, regex: RegExp, replacer: (hit: PassMatch) => string | null, ctx: PassContext): string {
  regex.lastIndex = 0;
  return buffer.replace(regex, (...args: unknown[]) => {
    const match = String(args[0]);
    // Signature du callback : (match, p1…pn, offset, chaîne) — sans groupes nommés.
    const offset = Number(args[args.length - 2]);
    const groups: string[] = [];
    for (let i = 1; i <= args.length - 3; i += 1) {
      const group = args[i];
      groups.push(typeof group === "string" ? group : "");
    }
    const replacement = replacer({ match, groups, offset });
    if (replacement === null) return match;
    ctx.byType[type] = (ctx.byType[type] ?? 0) + 1;
    ctx.matches.push({ type, index: offset, length: match.length });
    return replacement;
  });
}

/* ────────────────────────────────────────────────────────────────────────
 * Tool
 * ──────────────────────────────────────────────────────────────────────── */

export const transcriptRedactTool: ToolDefinition<z.infer<typeof TranscriptRedactInput>, TranscriptRedactResult> = {
  id: "transcript.redact",
  name: "Call Transcription Redactor",
  description:
    "Mask sensitive data in a call transcript in real time: card numbers (Luhn-validated), CVV, IBAN, French social security numbers, spoken credentials, phone numbers and emails. Fully deterministic (no LLM).",
  category: "system",
  risk: "low",
  inputSchema: TranscriptRedactInput,
  async execute(input) {
    const options = input.options;
    const ctx: PassContext = { byType: {}, matches: [] };
    const skippedPatterns: Array<{ name: string; reason: string }> = [];
    let redacted = input.transcript;

    // ── 1. Cartes bancaires (AVANT les téléphones : un PAN à 16 chiffres
    //       ne doit jamais être interprété comme un numéro de téléphone).
    if (options.cardNumbers) {
      redacted = applyPass(redacted, TYPE_CARD, CARD_CANDIDATE_RE, (hit) => {
        const digits = hit.match.replace(/\D/g, "");
        if (digits.length < 13 || digits.length > 19) return null;
        if (!passesLuhn(digits)) return null;
        return maskKeepLast(hit.match, 4, isDigit);
      }, ctx);

      // ── 2. IBAN (après les cartes : les groupes de chiffres d'un PAN ne
      //       portent pas les 2 lettres de pays requises par l'IBAN).
      redacted = applyPass(redacted, TYPE_IBAN, IBAN_RE, (hit) => {
        const compact = hit.match.replace(/ /g, "");
        if (compact.length < 15 || compact.length > 34) return null;
        // Un IBAN français fait EXACTEMENT 27 caractères (pays + contrôle + BBAN).
        if (compact.startsWith("FR") && compact.length !== 27) return null;
        return maskKeepLast(hit.match, 4, isUpperAlnum);
      }, ctx);

      // ── 3. CVV contextuel — seuls les chiffres sont masqués, jamais les
      //       mots du contexte (« cvv », « code secret »… restent lisibles).
      redacted = applyPass(redacted, TYPE_CVV, CVV_CONTEXT_RE, (hit) => {
        const secret = hit.groups[0] ?? "";
        return hit.match.slice(0, hit.match.length - secret.length) + "•".repeat(secret.length);
      }, ctx);
    }

    // ── 4. NIR français (avant les téléphones : mêmes familles de chiffres).
    if (options.personalData) {
      redacted = applyPass(redacted, TYPE_NIR, NIR_RE, (hit) => hit.match.replace(/[^\s]/g, "•"), ctx);
    }

    // ── 5. Identifiants / mots de passe énoncés.
    if (options.credentials) {
      redacted = applyPass(redacted, TYPE_CREDENTIALS, CREDENTIALS_RE, (hit) => {
        const secret = hit.groups[0] ?? "";
        // Idempotence : une valeur déjà masquée en « • » n'est pas retraitée.
        if (secret.length > 0 && /^•+$/.test(secret)) return null;
        return hit.match.slice(0, hit.match.length - secret.length) + "••••••••";
      }, ctx);
    }

    // ── 6. Téléphones (international puis français) — garder 4 chiffres.
    if (options.personalData) {
      redacted = applyPass(redacted, TYPE_PHONE, PHONE_INTL_RE, (hit) => maskKeepLast(hit.match, 4, isDigit), ctx);
      redacted = applyPass(redacted, TYPE_PHONE, PHONE_FR_RE, (hit) => maskKeepLast(hit.match, 4, isDigit), ctx);

      // ── 7. Emails — remplacement intégral.
      redacted = applyPass(redacted, TYPE_EMAIL, EMAIL_RE, () => "[email protégé]", ctx);
    }

    // ── 8. Motifs personnalisés — en DERNIER, chacun isolé en try/catch :
    //       un motif invalide est signalé et ignoré, jamais un crash.
    for (const custom of options.customPatterns ?? []) {
      try {
        const customRegex = new RegExp(custom.pattern, "gi");
        redacted = applyPass(redacted, custom.name, customRegex, () => `[${custom.name} retiré]`, ctx);
      } catch {
        skippedPatterns.push({
          name: custom.name,
          reason: "expression régulière invalide — motif ignoré sans interrompre le masquage",
        });
      }
    }

    const totalRedactions = ctx.matches.length;
    return {
      redacted,
      totalRedactions,
      byType: ctx.byType,
      matches: ctx.matches,
      skippedPatterns,
    };
  },
};
