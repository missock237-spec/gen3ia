import { createHash } from "node:crypto";
import { z } from "zod";

import { generate } from "@/lib/ai/router";
import type { LiveAction, LiveSession } from "./types";

/**
 * DÉCIDEUR VISION LIVE — MOTEUR NEURAL INTERNE UNIQUEMENT.
 *
 * Historique : avant la Task 150, ce module interrogeait des fournisseurs de
 * vision externes (OpenAI / Groq / Agnes). Ces IA externes ont été SUPPRIMÉES
 * du projet (purge Task 150) et le routeur IA (lib/ai/router.ts) ne sert plus
 * que le moteur neural Gen3 interne — qui ne possède PAS de capacité vision
 * (voir lib/ai/models.ts : les images jointes ne sont pas interprétées, aucune
 * transcription fabriquée).
 *
 * Restauration honnête (Task live 2026) :
 *  - PERCEPTION STRUCTURELLE RÉELLE : chaque frame JPEG est analysée pour ce
 *    que le serveur peut mesurer SANS interpréter les pixels — dimensions
 *    réelles lues dans les marqueurs SOF du JPEG, poids en octets, empreinte
 *    SHA-256 (dédup « écran inchangé » côté route). Aucune invention de
 *    contenu d'écran.
 *  - GUIDAGE PAR LE MOTEUR INTERNE : l'objectif, les métriques structurelles
 *    et le résultat de l'action précédente sont transmis au moteur Gen3
 *    (génération de texte) qui produit la narration et l'étape suivante.
 *  - ACTIONS SÛRES UNIQUEMENT : sans vision pixel, l'agent ne peut pas
 *    localiser un bouton — la décision ne peut proposer qu'une action
 *    `wait`. Toute action souris/clavier/fichier serait une fabrication de
 *    coordonnées : interdite à ce niveau (garde plus stricte que l'ancien
 *    garde « mode navigateur »).
 *  - DÉGRADATION EXPLICITE : si le moteur interne échoue ou renvoie une
 *    décision illisible, un message STRUCTUREL déterministe (jamais simulé)
 *    est renvoyé, avec `perception: "degraded"`.
 */

const DecisionSchema = z.object({
  done: z.boolean(),
  message: z.string().max(2000).default(""),
  /** Sans vision pixel : seule l'attente est une action honnête. */
  action: z
    .object({ type: z.literal("wait"), ms: z.number().int().min(50).max(30_000) })
    .nullable()
    .default(null),
});

export type LiveDecision = z.infer<typeof DecisionSchema>;

/** Niveau de perception réellement disponible pour la décision. */
export type LivePerception = "structural-guided" | "structural-degraded";

const MAX_FRAME_BYTES = 1_500_000;

export interface LiveActionFeedback {
  ok: boolean;
  error?: string;
  at: number;
}

export interface LiveFrameStructure {
  /** Dimensions réelles lues dans l'entête JPEG (SOF), null si illisibles. */
  dimensions: { width: number; height: number } | null;
  /** Poids réel de la frame en octets. */
  bytes: number;
  /** Empreinte SHA-256 du JPEG — dédup d'écran inchangé (route frames). */
  hash: string;
  /** Vrai si les dimensions déclarées par le client contredisent l'entête JPEG. */
  declaredMismatch: boolean;
}

/**
 * Analyse STRUCTURELLE réelle d'une frame JPEG : dimensions lues dans les
 * marqueurs SOF (SOF0/SOF1/SOF2…), poids binaire, empreinte SHA-256.
 * Aucune décodage pixel, aucune interprétation de contenu — des mesures.
 */
export function analyzeFrameStructure(jpeg: Buffer): LiveFrameStructure {
  const dimensions = parseJpegDimensions(jpeg);
  return {
    dimensions,
    bytes: jpeg.length,
    hash: createHash("sha256").update(jpeg).digest("hex"),
    declaredMismatch: false,
  };
}

/**
 * Lit les dimensions réelles dans les marqueurs JPEG (SOF0-SOF15 hors DHT/JPG/DAC).
 * Retourne null pour un JPEG tronqué ou illisible — jamais une estimation.
 */
function parseJpegDimensions(jpeg: Buffer): { width: number; height: number } | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = jpeg[offset + 1];
    // Markers sans longueur : FF01 (TEM), FFD0-FFD7 (RST).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > jpeg.length) return null;
    const length = jpeg.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > jpeg.length) return null;
      const height = jpeg.readUInt16BE(offset + 5);
      const width = jpeg.readUInt16BE(offset + 7);
      if (width > 0 && height > 0) return { width, height };
      return null;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS : pas de SOF.
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

/**
 * Extraction JSON tolérante (héritée du décideur historique) : certains
 * modèles enferment leur décision dans une fence markdown ou la bordent de
 * texte — JSON brut, fence, premier objet trouvé.
 */
function parseDecisionJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    // candidats suivants
  }
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // candidat suivant
    }
  }
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(content.slice(start, end + 1));
    } catch {
      // échec final
    }
  }
  throw new Error("Décision live illisible (JSON introuvable dans la réponse du moteur)");
}

const MAX_CONTEXT_ERROR = 2000;

const SYSTEM_TEXT = [
  "You are the planning voice of a user-owned Gen3ia Live Agent powered by the internal Gen3 neural engine.",
  "IMPORTANT: you have NO pixel vision. You never see the screen. You only receive objective text, REAL structural measurements of the last JPEG frame (dimensions, byte size, changed-or-not) and the previous action result.",
  "Never invent, describe or guess UI content, windows, texts or button positions you cannot see.",
  "Using only the objective and the structural signals, write a short, concrete and honest next-step instruction for the user (what to do on the computer, or what to verify).",
  "Prefer one minimal step per decision. Never propose destructive, financial, credential or irreversible steps.",
  "The only executable action you may return is `wait` (let the screen evolve); any mouse/keyboard/file action is forbidden because pixel coordinates would be fabricated.",
  "Mark done=true ONLY when the user's own previous feedback confirms the objective is achieved; otherwise done=false.",
  "Respond in the user's language (French by default).",
  "Return strict JSON: {done:boolean,message:string,action:null|{type:\"wait\",ms:number}}.",
].join(" ");

/**
 * Décision live sur une frame — moteur neural interne (aucun service externe).
 * Même signature que le décideur historique : la route frames reste inchangée.
 */
export async function decideLiveAction(
  session: LiveSession,
  jpeg: Buffer,
  width: number,
  height: number,
  feedback?: LiveActionFeedback,
): Promise<LiveDecision & { perception: LivePerception }> {
  if (!session.permissions.includes("screen.read")) throw new Error("Live session has no screen.read permission");
  if (jpeg.length === 0 || jpeg.length > MAX_FRAME_BYTES) throw new Error("Live frame exceeds the allowed size");

  const structure = analyzeFrameStructure(jpeg);

  const payload = JSON.stringify({
    objective: session.objective,
    mode: session.mode ?? "browser",
    viewport: { width, height },
    frameStructure: {
      realDimensions: structure.dimensions,
      bytes: structure.bytes,
      declaredDimensions: { width, height },
      dimensionMismatch: structure.dimensions
        ? structure.dimensions.width !== width || structure.dimensions.height !== height
        : null,
    },
    previousActionResult: feedback
      ? { ok: feedback.ok, error: feedback.error?.slice(0, MAX_CONTEXT_ERROR) }
      : null,
  });

  let engineMessage: string | null = null;
  let parsed: LiveDecision | null = null;
  try {
    const response = await generate({
      task: "agent",
      temperature: 0,
      maxTokens: 400,
      system: SYSTEM_TEXT,
      messages: [{ role: "user", content: payload }],
    });
    const candidate = DecisionSchema.safeParse(parseDecisionJson(response.text));
    if (candidate.success) {
      parsed = candidate.data;
      engineMessage = candidate.data.message;
    }
  } catch {
    // Dégradation explicite : le message structurel déterministe ci-dessous
    // est la réponse honnête (jamais une décision simulée).
  }

  if (!parsed) {
    const dimensions = structure.dimensions ? `${structure.dimensions.width}×${structure.dimensions.height}` : "illisible";
    return {
      done: false,
      message:
        `Observation structurelle (sans vision pixel) : frame ${dimensions}, ${Math.round(structure.bytes / 1024)} ko. ` +
        `Le moteur interne n'interprète pas les pixels — il ne peut ni décrire le contenu de l'écran ni localiser des éléments. ` +
        `Objectif enregistré : « ${session.objective.slice(0, 160)} ». La session reste active ; utilisez Arrêter pour clore.`,
      action: null,
      perception: "structural-degraded",
    };
  }

  // Garde dure : quelle que soit la réponse du moteur, seule une action
  // `wait` peut être exécutée (mode navigateur ET mode desktop) — sans
  // vision pixel, des coordonnées souris seraient une fabrication.
  // `parsed.action` est DÉJÀ validé par DecisionSchema (forme `wait`
  // exclusive) — aucun élargissement vers LiveActionSchema n'est permis ici.
  const action = parsed.action;
  const message = (engineMessage ?? parsed.message).slice(0, 2000);
  return {
    done: parsed.done,
    message,
    action: action ?? null,
    perception: "structural-guided",
  };
}

/**
 * Confirmation humaine requise : ne peut plus se produire (le décideur
 * interne ne propose que des `wait`) — conservé pour le contrat de la route
 * et pour une future réintroduction d'actions sensibles par un client PC.
 */
export function actionRequiresConfirmation(action: LiveAction): boolean {
  if (action.type === "file.write") return true;
  if (action.type === "keyboard.type") {
    return /password|secret|api[_ -]?key|token|recovery|private key/i.test(action.text);
  }
  return false;
}
