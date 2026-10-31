import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * VERROU BIDIRECTIONNEL it.60 (28ᵉ test garde) — LE PONT COLAB PULL-MODE.
 *
 * Demande propriétaire : « donne-moi la commande à exécuter pour que je
 * puisse te connecter au terminal de Google Colab pour que tu puisses
 * entraîner gen3 ».
 *
 * L'architecture retenue (training/colab/agent-pull-colab.sh + branche
 * colab-bridge) est un PULL-MODE HTTPS sortant uniquement — le même pattern
 * que le pull-mode VPS du projet : AUCUN tunnel, AUCUN port ouvert, AUCUN
 * token en dur. Ce garde verrouille les garanties de sécurité annoncées.
 */

const RACINE = path.join(import.meta.dirname, "..", "..");
const AGENT = readFileSync(path.join(RACINE, "training", "colab", "agent-pull-colab.sh"), "utf8");
const README = readFileSync(path.join(RACINE, "training", "colab", "bridge", "README.md"), "utf8");

describe("it.60 — le pont Colab pull-mode (agent-pull-colab.sh)", () => {
  it("existe, est exécutable et syntaxiquement complet (shebang bash)", () => {
    const stat = statSync(path.join(RACINE, "training", "colab", "agent-pull-colab.sh"));
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o111).not.toBe(0);
    expect(AGENT.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(AGENT.length).toBeGreaterThan(3000);
  });

  it("cible le bon dépôt, la bonne branche de données et le bon répertoire bridge", () => {
    expect(AGENT).toContain('REPO="missock237-spec/gen3ia"');
    expect(AGENT).toContain('BRANCH="colab-bridge"');
    expect(AGENT).toContain('BRIDGE_DIR="training/colab/bridge"');
    expect(AGENT).toContain("https://api.github.com/repos/${REPO}/contents");
  });

  it("HTTPS SORTANT UNIQUEMENT : aucun tunnel, aucun port ouvert, aucun serveur", () => {
    // Interdits absolus : tunnels/reverse shells/écoutes locales.
    expect(AGENT).not.toMatch(/ngrok|cloudflared|localtunnel/i);
    expect(AGENT).not.toMatch(/ssh\s+(-[^\s]*\s+)*-R/); // pas de reverse SSH
    expect(AGENT).not.toMatch(/nc\s+-l|ncat\s+-l|socat.*LISTEN/);
    expect(AGENT).not.toMatch(/python3?\s+-m\s+http\.server|SimpleHTTPServer/);
    // Le SEUL hôte distant utilisé en exécution est l'API GitHub (raw = la
    // commande d'installation documentée en commentaire — lecture seule).
    const hotes = [...AGENT.matchAll(/https:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]);
    expect(hotes.length).toBeGreaterThan(0);
    for (const hote of hotes) {
      expect(["api.github.com", "raw.githubusercontent.com"]).toContain(hote);
    }
  });

  it("le token reste dans la session du propriétaire : saisie masquée, jamais en dur, jamais loggé", () => {
    expect(AGENT).toContain("read -rsp"); // saisie masquée
    expect(AGENT).not.toMatch(/ghp_[A-Za-z0-9]+|gho_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+/);
    // Le token n'est JAMAIS redirigé vers un fichier ni affiché.
    expect(AGENT).not.toMatch(/echo\s+"\$\{?PAT\}?"?\s*[>|]/);
    expect(AGENT).not.toMatch(/cat\s+<<.*\$\{?PAT/);
    // Les messages de commit du bridge ne contiennent pas le token.
    expect(AGENT).toContain("gen3ia-colab:");
    expect(AGENT).not.toMatch(/gen3ia-colab:[^"]*PAT/);
  });

  it("les ordres viennent EXCLUSIVEMENT du dépôt (inbox de la branche bridge) — opt-in propriétaire", () => {
    expect(AGENT).toContain("inbox.json");
    expect(AGENT).toContain("ref=${BRANCH}");
    expect(AGENT).toContain("Ctrl+C"); // arrêt à tout instant documenté dans le script
    expect(AGENT).toContain("stop"); // arrêt propre via {"stop": true}
    expect(AGENT).toContain("exit 0");
  });

  it("garde-fous d'exécution : timeout par commande, cap de log, idempotence par id", () => {
    expect(AGENT).toContain('CMD_TIMEOUT="${GEN3IA_TIMEOUT:-14400}"');
    expect(AGENT).toContain('timeout "${CMD_TIMEOUT}"');
    expect(AGENT).toContain("LOG_CAP=380000");
    expect(AGENT).toContain("LAST_ID=");
    expect(AGENT).toContain("tail -c"); // cap : la FIN du log est conservée
  });
});

describe("it.60 — le protocole du bridge est documenté honnêtement (README)", () => {
  it("documente la commande de lancement unique côté Colab (URL raw cohérente avec le dépôt)", () => {
    expect(README).toContain(
      "https://raw.githubusercontent.com/missock237-spec/gen3ia/main/training/colab/agent-pull-colab.sh",
    );
    expect(README).toContain("bash <(curl");
  });

  it("documente les canaux, le format d'inbox et les garanties de sécurité", () => {
    expect(README).toContain("inbox.json");
    expect(README).toContain("out-");
    expect(README).toContain("colab-bridge");
    expect(README).toContain("Jamais commité");
    expect(README).toContain("HTTPS sortant uniquement");
    expect(README).toContain("Ctrl+C");
  });
});
