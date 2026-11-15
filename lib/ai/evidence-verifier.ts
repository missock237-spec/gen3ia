import "server-only";

export type Evidence = {
  title?: string;
  url?: string;
  snippet?: string;
  source?: string;
  publishedAt?: string;
};

export type VerificationResult = {
  status: "verified" | "insufficient" | "conflicting";
  evidence: Evidence[];
  instruction: string;
};

/**
 * Normalise les résultats provenant d'un outil de recherche avant de les
 * présenter au modèle. Cette couche ne prétend jamais qu'une source existe :
 * sans URL/titre/snippet exploitable, l'information reste non vérifiée.
 */
export function verifyEvidence(items: Evidence[], minimum = 1): VerificationResult {
  const evidence = items.filter((item) =>
    Boolean((item.url?.trim() || item.title?.trim()) && item.snippet?.trim()),
  ).slice(0, 12);

  if (evidence.length < minimum) {
    return {
      status: "insufficient",
      evidence,
      instruction: "Aucune preuve exploitable suffisante. Ne présente pas les informations externes comme des faits vérifiés et signale l'incertitude si elle est pertinente.",
    };
  }

  const urls = new Set(evidence.map((item) => item.url?.trim()).filter(Boolean));
  return {
    status: urls.size > 1 ? "verified" : "verified",
    evidence,
    instruction: "Utilise uniquement les affirmations que les éléments de preuve soutiennent. N'invente jamais de citation, d'URL, de date ou de source.",
  };
}

export function formatEvidenceContext(result: VerificationResult): string {
  if (!result.evidence.length) return result.instruction;
  return [
    "PREUVES EXTERNES DISPONIBLES:",
    result.instruction,
    ...result.evidence.map((item, index) =>
      `[${index + 1}] ${item.title ?? item.source ?? "Source"}${item.url ? ` — ${item.url}` : ""}${item.publishedAt ? ` — ${item.publishedAt}` : ""}\n${item.snippet}`,
    ),
  ].join("\n");
}
