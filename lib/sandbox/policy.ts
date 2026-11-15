/**
 * POLITIQUE DE SÉCURITÉ DU TERMINAL INTÉGRÉ (Task 122).
 *
 * Deny-list PARTAGÉE par toutes les surfaces d'exécution de commandes —
 * terminal agent (`executeAgentTerminal`), terminal utilisateur
 * (`executeUserTerminalCommand`) et outil agent `terminal.run`
 * (lib/tools/terminal/run.ts). AUCUNE exécution serverless ne peut partir
 * sans que cette liste ait été appliquée (défense en profondeur : la liste
 * est réévaluée par lib/sandbox/serverless-exec.ts juste avant le spawn).
 *
 * Durcissement Task 122 (mode « serverless » — exécution RÉELLE en-processus
 * dans la microVM Vercel) : écriture hors /tmp, lectures /proc/self/environ
 * et /var/task (bundle Vercel), fichiers .env*, historiques shell,
 * unset/eval d'environnement, curl du service de metadata
 * (169.254.169.254), ssh/scp et décodages pipés vers un interpréteur
 * (base64 -d | sh…).
 */

/** Longueur maximale d'une commande terminal (entrée utilisateur). */
export const TERMINAL_MAX_COMMAND_LENGTH = 50_000;

export interface TerminalDenyRule {
  pattern: RegExp;
  /** Libellé du motif rejeté (affiché à l'agent/à l'utilisateur). */
  label: string;
}

/**
 * Patterns REJETÉS AVANT TOUTE exécution. La liste est volontairement
 * conservative : un faux positif coûte une reformulation, un faux négatif
 * coûte une exécution dangereuse.
 */
export const TERMINAL_DENIED_PATTERNS: readonly TerminalDenyRule[] = [
  // — Élévation / destruction système (historique, conservé) —
  { pattern: /(^|\s)(sudo|su)\b/i, label: "élévation de privilèges (sudo/su)" },
  { pattern: /rm\s+(?:-[^\s]*\s+)*-?rf\s+\//i, label: "rm -rf / (destruction racine)" },
  { pattern: /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;\s*:/, label: "fork bomb" },
  { pattern: /mkfs(?:\.[a-z0-9]+)?\b/i, label: "formatage de système de fichiers" },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/i, label: "extinction du système" },
  { pattern: /\bdocker(?:\s|$)/i, label: "contrôle Docker de l'hôte" },
  { pattern: /\b(?:mount|umount)\b/i, label: "montage de système de fichiers" },
  { pattern: /chmod\s+777/i, label: "chmod 777 (permissions universelles)" },
  { pattern: /\b(?:nc|netcat|socat)\b/i, label: "outil réseau brut (nc/socat)" },
  // — Périphériques & introspection système (durci Task 122) —
  { pattern: /\/proc\/|\/sys\/|\/dev\/mem|\/dev\/kmem/i, label: "accès aux pseudo-systèmes de fichiers (inclut /proc/self/environ)" },
  { pattern: /\/var\/task\b|\/var\/runtime\b/i, label: "lecture du bundle serverless (/var/task)" },
  // — Secrets & environnement (durci Task 122) —
  { pattern: /(^|[\s/"'])\.env[\w.]*\b/, label: "accès à un fichier .env (secrets)" },
  { pattern: /\.(?:bash|zsh|sh)_history\b|\bHISTFILE\b/, label: "lecture d'un historique shell" },
  {
    pattern: /(?:^|[\s;&|])(?:unset|export\s+-n|set\s+-u)\s+[^;\n|&]*\b(?:PATH|HOME|LANG|LC_[A-Z_]+|SHELL|USER|TMPDIR|PWD)\b/,
    label: "unset/export d'une variable d'environnement du processus",
  },
  { pattern: /\beval\s+\$/, label: "eval d'une expansion de variable (injection)" },
  // — Réseau sensible (durci Task 122) —
  { pattern: /\b169\.254\.169\.254\b|\b169\.254\.170\.2\b|metadata\.google\.internal/i, label: "interrogation du service de métadonnées cloud (169.254.169.254)" },
  { pattern: /\b(?:ssh|scp|sftp|rsync)\b/i, label: "transfert/connexion distante (ssh/scp/rsync)" },
  // — Pipe vers interpréteur (téléchargement OU décodage → exécution) —
  { pattern: /(?:curl|wget|fetch)\s+[^;\n]*\|\s*(?:ba)?sh/i, label: "téléchargement puis exécution immédiate (curl|sh)" },
  { pattern: /(?:base64|openssl|xxd|gunzip|zcat)\b[^;|]*\|\s*(?:ba)?sh/i, label: "décodage puis exécution immédiate (base64 -d|sh)" },
  { pattern: /\|\s*(?:ba|z|da)?sh\b/, label: "pipe vers un interpréteur shell" },
  // — Écriture hors /tmp (durci Task 122) —
  { pattern: /(?:^|[\s;&|)(])>{1,2}\s*(?:\/(?!tmp\/|dev\/null\b)|~\/)/, label: "redirection d'écriture hors /tmp" },
  { pattern: /\btee\s+(?:-[a-z]+\s+)*\/(?!tmp\/|dev\/null\b)/i, label: "tee vers un chemin hors /tmp" },
  { pattern: /\bdd\b[^;|]*\bof=\/(?!tmp\/)/i, label: "dd vers un chemin hors /tmp" },
  { pattern: /\binstall\s+[^;|]*\s(?:-t|--target-directory)\s+\/(?!tmp\/)/i, label: "install vers un répertoire hors /tmp" },
];

/** Première règle violée par la commande (null si rien à signaler). */
export function findTerminalDenial(command: string): TerminalDenyRule | null {
  return TERMINAL_DENIED_PATTERNS.find((rule) => rule.pattern.test(command)) ?? null;
}

/**
 * Vérifie une commande terminal AVANT exécution. Lève une erreur explicite
 * (contrat historique conservé : les routes mappent « safety policy » sur
 * HTTP 400 et les agents journalisent l'échec).
 */
export function assertTerminalCommandSafe(command: string): void {
  if (!command.trim()) throw new Error("Terminal command cannot be empty.");
  if (command.length > TERMINAL_MAX_COMMAND_LENGTH) throw new Error("Terminal command is too large.");
  const denial = findTerminalDenial(command);
  if (denial) {
    throw new Error(`Terminal command rejected by Gen3ia safety policy. (motif : ${denial.label})`);
  }
}
