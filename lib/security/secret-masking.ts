/**
 * Masquage automatique des secrets — défense en profondeur.
 *
 * Utilisé à DEUX étages :
 *  1. côté serveur, avant l'enregistrement d'une sortie terminal
 *     (piste d'audit et affichage IDE ne stockent JAMAIS un secret) ;
 *  2. côté client, avant rendu (ceinture + bretelles si une donnée
 *     historique précédait la règle serveur).
 *
 * Les motifs couvrent les formats de credentials les plus courants :
 * clés OpenAI/Anthropic, tokens GitHub, clés AWS, JWT, tokens Slack,
 * tokens Vercel, en-têtes Bearer et affectations `clé = valeur` explicites.
 */

const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Clés type OpenAI / Anthropic / génériques sk-
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: "sk-***masqué***" },
  // Tokens GitHub (ghp_, gho_, ghs_, ghu_, github_pat_)
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, replacement: "ghp_***masqué***" },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: "github_pat_***masqué***" },
  // Clés d'accès AWS
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "AKIA***masqué***" },
  // JWT (trois segments base64url)
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, replacement: "eyJ***masqué***" },
  // Tokens Slack
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: "xox***masqué***" },
  // Tokens Vercel / Mistral / Bearer explicites
  { pattern: /\bvcp_[A-Za-z0-9]{10,}\b/g, replacement: "vcp_***masqué***" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, replacement: "Bearer ***masqué***" },
  // Affectations explicites : api_key=…, SECRET:…, password=…
  {
    pattern: /\b(api[_-]?key|apikey|secret|token|password|passwd|pwd|authorization|access[_-]?token|refresh[_-]?token|private[_-]?key)\b(\s*[:=]\s*)("[^"\s]{6,}"|'[^'\s]{6,}'|[A-Za-z0-9._~+/=-]{8,})/gi,
    replacement: "$1$2***masqué***",
  },
  // Variables d'environnement sensibles exportées (export FOO_KEY=…)
  {
    pattern: /\bexport\s+([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*)\s*=\s*\S+/g,
    replacement: "export $1=***masqué***",
  },
];

/** Remplace toute valeur ressemblant à un secret par un marqueur visible. */
export function maskSecrets(text: string): string {
  if (!text) return text;
  let masked = text;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}
