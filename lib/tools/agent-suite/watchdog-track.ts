import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { adminDb } from "@/lib/firebase/admin";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";
import { markupToText } from "@/lib/content/html-text";
import type { ToolDefinition } from "@/lib/tools/types";
import { generateStructuredForUser } from "./llm-json";

/**
 * Task 140 — Tool « watchdog.track » (Web Change & Anomaly Watchdog).
 *
 * Surveillance de pages stratégiques : enregistre une référence (snapshot
 * texte), puis à chaque vérification DIFFÉRE le contenu courant, CLASSIFIE
 * les changements (stratégique vs cosmétique — dates, compteurs et pubs
 * ignorés) et tient l'historique.
 *
 * Contrat :
 *  - mode register : validation SSRF, fetch (UA Gen3ia, 1 redirection
 *    revalidée, plafond 5 Mo, timeout 15 s), snapshot texte normalisé +
 *    empreinte SHA-256, persistance dans « agentWatchdogs » ;
 *  - mode check : diff déterministe ligne à ligne (ajouts/retraits plafonnés
 *    à 10), classification IA (generateStructuredForUser) avec repli
 *    déterministe si l'IA échoue, référence TOUJOURS avancée au contenu
 *    courant (la prochaine vérification est incrémentale) ;
 *  - historique plafonné à 50 entrées (la plus ancienne est évacuée) ;
 *  - portée utilisateur stricte : chaque lecture/écriture vérifie
 *    doc.userId === context.userId (sinon « introuvable », sans fuite
 *    d'information sur l'existence du document) ;
 *  - status n'expose JAMAIS la référence complète (aperçu 300 caractères).
 */

/* ────────────────────────────────────────────────────────────────────────
 * Constantes
 * ──────────────────────────────────────────────────────────────────────── */

const COLLECTION = "agentWatchdogs";
const MAX_HISTORY_ENTRIES = 50;
const BASELINE_MAX_CHARS = 100_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const MAX_DIFF_LINES = 10;
const MAX_DIFF_LINE_CHARS = 200;
const BASELINE_PREVIEW_CHARS = 300;

const FETCH_HEADERS = { "User-Agent": "Gen3ia-AI-Studio/1.0" };

/* ────────────────────────────────────────────────────────────────────────
 * Entrée / sortie
 * ──────────────────────────────────────────────────────────────────────── */

const WatchdogTrackInput = z
  .object({
    mode: z.enum(["register", "check", "status", "remove"]),
    url: z.string().url().optional(),
    label: z.string().max(120).optional(),
    instructions: z.string().max(2_000).optional(),
    watchId: z.string().min(1).max(128).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === "register" && !data.url) {
      ctx.addIssue({ code: "custom", message: "Le mode « register » exige une URL à surveiller." });
    }
    if ((data.mode === "check" || data.mode === "status" || data.mode === "remove") && !data.watchId) {
      ctx.addIssue({
        code: "custom",
        message: `Le mode « ${data.mode} » exige l'identifiant de la surveillance (watchId).`,
      });
    }
  });

export interface WatchdogHistoryEntry {
  checkedAt: number;
  changed: boolean;
  strategic: boolean;
  summary: string;
}

export interface WatchdogChangeClassification {
  superficial: boolean;
  strategic: boolean;
  category: "prix" | "offre" | "produit" | "réglementaire" | "technique" | "contenu" | "autre";
  summary: string;
  importance: number;
}

interface WatchdogDoc {
  id: string;
  userId: string;
  url: string;
  label: string;
  instructions: string;
  baselineText: string;
  baselineHash: string;
  createdAt: number;
  lastCheckedAt: number;
  lastChangeAt: number | null;
  history: WatchdogHistoryEntry[];
  active: boolean;
}

export type WatchdogTrackResult =
  | { watchId: string; label: string; baselineChars: number; message: string }
  | { watchId: string; changed: false; message: string }
  | {
      watchId: string;
      changed: true;
      classification: WatchdogChangeClassification;
      addedLines: string[];
      removedLines: string[];
      historySize: number;
    }
  | {
      watchId: string;
      url: string;
      label: string;
      instructions: string;
      createdAt: number;
      lastCheckedAt: number;
      lastChangeAt: number | null;
      active: boolean;
      baselineChars: number;
      baselinePreview: string;
      history: WatchdogHistoryEntry[];
    }
  | { watchId: string; removed: true };

/* ────────────────────────────────────────────────────────────────────────
 * Classification IA (fail-soft)
 * ──────────────────────────────────────────────────────────────────────── */

const ChangeClassificationSchema = z.object({
  superficial: z.boolean(),
  strategic: z.boolean(),
  category: z.enum(["prix", "offre", "produit", "réglementaire", "technique", "contenu", "autre"]),
  summary: z.string().max(600),
  importance: z.number().int().min(1).max(5),
});

const CLASSIFY_SYSTEM_PROMPT = [
  "Tu es un analyste de surveillance de pages web.",
  "On te donne les lignes ajoutées et retirées entre deux versions d'une page surveillée, avec les consignes éventuelles de l'utilisateur.",
  "Classe le changement : COSMÉTIQUE (superficial: dates, compteurs, publicités, mentions légales mineures, mise en page) ou STRATÉGIQUE (prix, offre, produit, disponibilité, obligations réglementaires, rupture de service).",
  "Réponds UNIQUEMENT avec le JSON { \"superficial\": bool, \"strategic\": bool, \"category\": \"prix|offre|produit|réglementaire|technique|contenu|autre\", \"summary\": \"…\", \"importance\": 1-5 }.",
].join("\n");

const FALLBACK_CLASSIFICATION: WatchdogChangeClassification = {
  superficial: true,
  strategic: false,
  category: "autre",
  summary: "Changement détecté mais non classé (analyse IA indisponible) — consultez les lignes ajoutées/retirées.",
  importance: 2,
};

/* ────────────────────────────────────────────────────────────────────────
 * Helpers déterministes
 * ──────────────────────────────────────────────────────────────────────── */

/** Normalise le HTML en texte comparable : blancs compactés, lignes structurelles conservées. */
function normalizeText(html: string): { text: string; hash: string } {
  const text = markupToText(html)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .slice(0, BASELINE_MAX_CHARS)
    .trim();
  const hash = createHash("sha256").update(text).digest("hex");
  return { text, hash };
}

/** Diff déterministe : lignes ajoutées et retirées (plafonnées, dédupliquées). */
function diffLines(oldText: string, newText: string): { addedLines: string[]; removedLines: string[] } {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  const addedLines: string[] = [];
  const addedSeen = new Set<string>();
  for (const line of newLines) {
    if (oldSet.has(line) || addedSeen.has(line)) continue;
    addedSeen.add(line);
    if (addedLines.length < MAX_DIFF_LINES) addedLines.push(line);
  }

  const removedLines: string[] = [];
  const removedSeen = new Set<string>();
  for (const line of oldLines) {
    if (newSet.has(line) || removedSeen.has(line)) continue;
    removedSeen.add(line);
    if (removedLines.length < MAX_DIFF_LINES) removedLines.push(line);
  }

  return { addedLines, removedLines };
}

/** Fetch protégé : SSRF revalidée (y compris la redirection unique), plafond 5 Mo, timeout 15 s. */
async function fetchPageHtml(rawUrl: string): Promise<string> {
  const target = await assertPublicHttpUrl(rawUrl);
  let response = await fetch(target, {
    redirect: "manual",
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Page inaccessible : redirection sans destination.");
    const redirected = await assertPublicHttpUrl(new URL(location, target).toString());
    response = await fetch(redirected, {
      redirect: "manual",
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Page inaccessible : redirections multiples non suivies.");
    }
  }
  if (!response.ok) throw new Error(`Page inaccessible (HTTP ${response.status}).`);
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error("Page trop volumineuse (limite 5 Mo).");
  }
  const html = await response.text();
  if (Buffer.byteLength(html, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Page trop volumineuse (limite 5 Mo).");
  }
  return html;
}

/** Coerce un document stocké en WatchdogDoc (historique, nombres, chaînes). */
function asWatchdogDoc(data: Record<string, unknown> | undefined): WatchdogDoc {
  return {
    id: String(data?.id ?? ""),
    userId: String(data?.userId ?? ""),
    url: String(data?.url ?? ""),
    label: String(data?.label ?? ""),
    instructions: typeof data?.instructions === "string" ? data.instructions : "",
    baselineText: String(data?.baselineText ?? ""),
    baselineHash: String(data?.baselineHash ?? ""),
    createdAt: Number(data?.createdAt ?? 0),
    lastCheckedAt: Number(data?.lastCheckedAt ?? 0),
    lastChangeAt: typeof data?.lastChangeAt === "number" ? data.lastChangeAt : null,
    history: Array.isArray(data?.history) ? (data.history as WatchdogHistoryEntry[]) : [],
    active: data?.active !== false,
  };
}

/** Lecture + garde de propriété : l'existence d'un document d'autrui n'est jamais révélée. */
async function readOwnedWatchdog(watchId: string, userId: string): Promise<{ doc: WatchdogDoc; ref: ReturnType<typeof docRef> }> {
  const ref = docRef(watchId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new Error("Surveillance introuvable pour cet utilisateur.");
  const doc = asWatchdogDoc(snapshot.data());
  if (doc.userId !== userId) throw new Error("Surveillance introuvable pour cet utilisateur.");
  return { doc, ref };
}

function docRef(watchId: string) {
  return adminDb.collection(COLLECTION).doc(watchId);
}

/* ────────────────────────────────────────────────────────────────────────
 * Tool
 * ──────────────────────────────────────────────────────────────────────── */

export const watchdogTrackTool: ToolDefinition<z.infer<typeof WatchdogTrackInput>, WatchdogTrackResult> = {
  id: "watchdog.track",
  name: "Web Change & Anomaly Watchdog",
  description:
    "Watch a strategic web page: register a text baseline, then check for changes (deterministic line diff + AI classification of strategic vs cosmetic changes) with a bounded history per watch.",
  category: "web",
  risk: "medium",
  inputSchema: WatchdogTrackInput,
  async execute(input, context) {
    if (input.mode === "register") {
      const url = input.url ?? "";
      const html = await fetchPageHtml(url);
      const baseline = normalizeText(html);
      const watchId = randomUUID();
      const now = Date.now();
      let label = input.label?.trim() ?? "";
      if (!label) {
        try {
          label = new URL(url).hostname || url;
        } catch {
          label = url;
        }
      }
      const doc: WatchdogDoc = {
        id: watchId,
        userId: context.userId,
        url,
        label: label.slice(0, 120),
        instructions: input.instructions ?? "",
        baselineText: baseline.text,
        baselineHash: baseline.hash,
        createdAt: now,
        lastCheckedAt: now,
        lastChangeAt: null,
        history: [],
        active: true,
      };
      await docRef(watchId).set(doc as unknown as Record<string, unknown>);
      return {
        watchId,
        label: doc.label,
        baselineChars: baseline.text.length,
        message: "Surveillance enregistrée — les prochaines vérifications compareront la page à cette référence.",
      };
    }

    if (input.mode === "check") {
      const { doc, ref } = await readOwnedWatchdog(input.watchId ?? "", context.userId);
      const html = await fetchPageHtml(doc.url);
      const current = normalizeText(html);
      const now = Date.now();

      if (current.hash === doc.baselineHash) {
        await ref.update({ lastCheckedAt: now });
        return { watchId: doc.id, changed: false, message: "Aucun changement détecté." };
      }

      const { addedLines, removedLines } = diffLines(doc.baselineText, current.text);

      let classification = FALLBACK_CLASSIFICATION;
      try {
        classification = await generateStructuredForUser({
          userId: context.userId,
          executionId: context.executionId,
          task: "reasoning",
          system: CLASSIFY_SYSTEM_PROMPT,
          user: [
            doc.instructions ? `Consignes de l'utilisateur : ${doc.instructions}` : "",
            `URL surveillée : ${doc.url}`,
            `Lignes ajoutées :\n${formatDiffLines(addedLines)}`,
            `Lignes retirées :\n${formatDiffLines(removedLines)}`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          schema: ChangeClassificationSchema,
          maxTokens: 1_000,
        });
      } catch {
        /* Fail-soft : le changement reste signalé, la classification est explicite sur son indisponibilité. */
      }

      // La référence avance TOUJOURS au contenu courant (vérification incrémentale).
      const history = [...doc.history, { checkedAt: now, changed: true, strategic: classification.strategic, summary: classification.summary }];
      const boundedHistory = history.length > MAX_HISTORY_ENTRIES ? history.slice(history.length - MAX_HISTORY_ENTRIES) : history;
      await ref.update({
        baselineText: current.text,
        baselineHash: current.hash,
        lastCheckedAt: now,
        lastChangeAt: now,
        history: boundedHistory,
      });
      return {
        watchId: doc.id,
        changed: true,
        classification,
        addedLines,
        removedLines,
        historySize: boundedHistory.length,
      };
    }

    if (input.mode === "status") {
      const { doc } = await readOwnedWatchdog(input.watchId ?? "", context.userId);
      return {
        watchId: doc.id,
        url: doc.url,
        label: doc.label,
        instructions: doc.instructions,
        createdAt: doc.createdAt,
        lastCheckedAt: doc.lastCheckedAt,
        lastChangeAt: doc.lastChangeAt,
        active: doc.active,
        baselineChars: doc.baselineText.length,
        baselinePreview: doc.baselineText.slice(0, BASELINE_PREVIEW_CHARS),
        history: doc.history,
      };
    }

    // mode remove
    const { ref } = await readOwnedWatchdog(input.watchId ?? "", context.userId);
    await ref.delete();
    return { watchId: input.watchId ?? "", removed: true };
  },
};

function formatDiffLines(lines: string[]): string {
  if (lines.length === 0) return "(aucune)";
  return lines.map((line) => `- ${line.slice(0, MAX_DIFF_LINE_CHARS)}`).join("\n");
}
