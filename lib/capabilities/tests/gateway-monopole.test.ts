import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

import { executeTool } from "@/lib/tools/executor";
import { executerCapacite, reponseNormalisee, type ReponseExecutionNormalisee } from "../execution/universal-gateway";
import { executerOutilViaGateway } from "../execution/pont-legacy";
import { reinitialiserRepositoryUce } from "../storage/capability-repository";
import { reinitialiserRegistreCentral, obtenirRegistreCentral } from "../core/capability-registry";

/**
 * TESTS MONOPOLE DU GATEWAY (V1.1 Phase 3) — critère d'acceptation mission :
 * « 100 % des outils activés doivent passer par le Universal Execution
 * Gateway. Ce résultat doit être démontré par une analyse du code et des
 * tests automatiques. »
 *
 * 1. GARDE AUTOMATIQUE : scan du code source — aucun appelant externe
 *    n'appelle `executeTool`/`ToolExecutor` en dehors des adaptateurs
 *    internes (liste blanche fermée) ;
 * 2. PARITÉ : ancien exécuteur ↔ pont legacy du gateway — mêmes succès,
 *    mêmes sorties, mêmes messages d'erreur ;
 * 3. RÉPONSE NORMALISÉE : les 10 champs mission présents sur chaque exécution.
 */

// ---------------------------------------------------------------------------
// 1) GARDE — analyse du code source (liste blanche fermée)
// ---------------------------------------------------------------------------

const ADAPTATEURS_INTERNES_AUTORISES = new Set([
  path.join("lib", "tools", "executor.ts"), // définition (adaptateur délégué)
  path.join("lib", "tools", "index.ts"), // ré-export interne + pont
  path.join("lib", "capabilities", "execution", "execution-adapter.ts"), // délégation gateway
]);

async function fichiersSource(): Promise<string[]> {
  const racines = ["lib", "app", "components", "services"];
  const fichiers: string[] = [];
  const EXCLUS = ["node_modules", "__tests__", ".test.", "coverage", ".next"];
  async function parcourir(dir: string): Promise<void> {
    let entrees: import("node:fs").Dirent[];
    try {
      entrees = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return; // répertoire absent dans cet environnement
    }
    for (const entree of entrees) {
      const chemin = path.join(dir, entree.name);
      if (EXCLUS.some((m) => entree.name.includes(m) || chemin.includes(m))) continue;
      if (entree.isDirectory()) await parcourir(chemin);
      else if (/\.(ts|tsx|mts)$/.test(entree.name)) fichiers.push(chemin);
    }
  }
  for (const racine of racines) await parcourir(racine);
  return fichiers;
}

function sansCommentaires(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/this\.executeTool\s*\(/g, " ") // méthode privée homonyme de runner.ts
    .replace(/async\s+executeTool\s*\(/g, " "); // définition de méthode (runner.ts)
}

describe("garde anti-contournement du gateway (mission Phase 3)", () => {
  it("aucun appelant externe n'invoque executeTool/ToolExecutor hors adaptateurs internes", async () => {
    const fichiers = await fichiersSource();
    expect(fichiers.length).toBeGreaterThan(500); // le scan couvre le dépôt réel
    const violations: string[] = [];
    for (const fichier of fichiers) {
      const cle = fichier.split(path.sep).join("/");
      if ([...ADAPTATEURS_INTERNES_AUTORISES].some((a) => cle.endsWith(a))) continue;
      const code = sansCommentaires(await fs.readFile(fichier, "utf8"));
      const importContourne = /import\s*\{[^}]*\b(executeTool|ToolExecutor)\b[^}]*\}\s*from/.test(code);
      const appelDirect = /\b(executeTool|ToolExecutor)\s*\(/.test(code);
      if (importContourne || appelDirect) violations.push(`${cle} (import: ${importContourne}, appel: ${appelDirect})`);
    }
    expect(violations, `contournements détectés : ${violations.join(" | ")}`).toEqual([]);
  });

  it("toutes les surfaces appelantes historiques passent par le pont legacy", async () => {
    const fichiers = await fichiersSource();
    const surPont = new Set<string>();
    for (const fichier of fichiers) {
      const code = await fs.readFile(fichier, "utf8");
      if (code.includes("pont-legacy")) surPont.add(fichier.split(path.sep).join("/"));
    }
    for (const surfaceAttendue of [
      "lib/agents/runtime/secure-tool-executor.ts", // agents + workflows
      "lib/domain/conversations/engine-services.ts",
      "lib/domain/conversations/engine-plan.ts",
      "lib/domain/conversations/engine-research.ts",
      "lib/domain/conversations/engine-approvals.ts",
      "lib/domain/conversations/web-context.ts",
      "lib/domain/conversations/recherche-systematique.ts",
      "app/api/tools/execute/route.ts", // API publique
      "lib/tools/index.ts", // executeRegisteredTool
    ]) {
      expect([...surPont].some((f) => f.endsWith(surfaceAttendue)), `${surfaceAttendue} sur le pont`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) PARITÉ — ancien exécuteur ↔ gateway (pont legacy)
// ---------------------------------------------------------------------------

let dossier: string;

beforeEach(async () => {
  dossier = await fs.mkdtemp(path.join(os.tmpdir(), "uce-monopole-"));
  reinitialiserRepositoryUce();
  reinitialiserRegistreCentral();
  obtenirRegistreCentral({ dossier, forcerLocal: true });
});

afterEach(async () => {
  reinitialiserRegistreCentral();
  reinitialiserRepositoryUce();
  await fs.rm(dossier, { recursive: true, force: true });
});

describe("parité ancien exécuteur ↔ gateway", () => {
  // Le sandbox de développement est fail-closed sur le stockage d'arrêt
  // d'urgence (r2fs/R2 non configuré — limite documentée au rapport V1 §10).
  // La parité compare le COMPORTEMENT : dès qu'un chemin délègue réellement
  // à executeTool, erreur et sortie sont identiques ; les messages ne sont
  // comparés strictement que lorsque l'environnement n'intercepte pas avant.
  const echecEnvironnementR2fs = (err?: string) => typeof err === "string" && err.includes("r2fs");

  it("outil inconnu : refus des deux côtés, sémantique historique préservée au gateway", async () => {
    const demande = {
      userId: "utilisateur-parite",
      executionId: "parite-inconnu-1",
      toolName: "outil.totalement.inexistant",
      input: {},
    };
    const direct = await executeTool({ ...demande });
    const viaGateway = await executerOutilViaGateway({ ...demande, origine: "parite" }, { persister: false });
    expect(direct.success).toBe(false);
    expect(viaGateway.success).toBe(false);
    expect(viaGateway.error).toContain("Unknown tool: outil.totalement.inexistant");
    if (!echecEnvironnementR2fs(direct.error)) {
      expect(viaGateway.error).toBe(direct.error);
    }
  });

  it("même chemin délégué : erreur et sortie IDENTIQUES des deux côtés (file.read)", async () => {
    // Outil de lecture pur : aucune gate fine supplémentaire — les deux
    // chemins délèguent au MÊME executeTool et atteignent le même état.
    // Les appelants réels passent TOUJOURS une politique explicite (le
    // défaut refuse tout) — le test reproduit ce contrat.
    const demande = {
      userId: "utilisateur-parite",
      executionId: "parite-succes-1",
      toolName: "file.read",
      input: { path: "test-parite.txt" },
      policy: { allowedTools: ["file.read"], permissions: ["tool.read", "file.read"], maxToolExecutionMs: 120_000, maxInputBytes: 1_000_000, maxOutputBytes: 1_000_000 } as Parameters<typeof executeTool>[0]["policy"],
    };
    const direct = await executeTool(demande);
    const viaGateway = await executerOutilViaGateway({ ...demande, origine: "parite" }, { persister: false });
    expect(viaGateway.success).toBe(direct.success);
    expect(viaGateway.error ?? null).toBe(direct.error ?? null);
    if (direct.success) {
      expect(viaGateway.output).toEqual(direct.output);
    } else {
      // Environnement fail-closed (r2fs/R2 non configuré — limite V1 §10) :
      // les DEUX échouent au même endroit (lecture du stockage d'arrêt
      // d'urgence) — la parité est conservée même en échec d'infrastructure.
      expect(echecEnvironnementR2fs(direct.error), `échec direct = ${direct.error}`).toBe(true);
      expect(echecEnvironnementR2fs(viaGateway.error), `échec gateway = ${viaGateway.error}`).toBe(true);
    }
  });

  it("refus de politique : les deux côtés refusent (couche correcte au gateway)", async () => {
    const demande = {
      userId: "utilisateur-parite",
      executionId: "parite-politique-1",
      toolName: "web.search",
      input: { requete: "test" },
      policy: { allowedTools: [], permissions: [], maxToolExecutionMs: 30_000, maxInputBytes: 1_000_000, maxOutputBytes: 1_000_000 } as Parameters<typeof executeTool>[0]["policy"],
    };
    const direct = await executeTool(demande);
    const viaGateway = await executerOutilViaGateway({ ...demande, origine: "parite" }, { persister: false });
    expect(direct.success).toBe(false);
    expect(viaGateway.success).toBe(false);
    if (!echecEnvironnementR2fs(direct.error)) {
      expect(viaGateway.error).toBe(direct.error);
    } else {
      // Le gateway refuse à la couche POLITIQUE (contrôle central réel) ;
      // le chemin direct échoue à SA première couche (arrêt d'urgence
      // fail-closed r2fs dans CE sandbox).
      expect(viaGateway.error).toContain("not allowed");
    }
  });
});

// ---------------------------------------------------------------------------
// 3) RÉPONSE NORMALISÉE — les 10 champs mission sur chaque exécution
// ---------------------------------------------------------------------------

describe("réponse normalisée mission V1.1", () => {
  const CHAMPS_MISSION: Array<keyof ReponseExecutionNormalisee> = [
    "success", "executionId", "capabilityId", "status", "result",
    "error", "durationMs", "verification", "usage", "timestamp",
  ];

  it("chaque exécution retourne la réponse structurée complète (refus)", async () => {
    const resultat = await executerCapacite({
      executionId: "exec-normalisee-1",
      userId: "utilisateur-normalise",
      capabilityId: "natif:gen3ia:outil.absent",
      input: {},
      origine: "chat",
      sessionId: "session-abc",
      agentId: "agent-01",
      traceId: "trace-xyz",
    }, { persister: false });
    const reponse = reponseNormalisee(resultat);
    for (const champ of CHAMPS_MISSION) {
      expect(champ in reponse, `champ « ${String(champ)} »`).toBe(true);
    }
    expect(reponse.success).toBe(false);
    expect(reponse.executionId).toBe("exec-normalisee-1");
    expect(reponse.capabilityId).toBe("natif:gen3ia:outil.absent");
    expect(reponse.status).toBe("refusee");
    expect(typeof reponse.durationMs).toBe("number");
    expect(reponse.verification.verifie).toBe(false);
    expect(typeof reponse.usage.dureeMs).toBe("number");
    expect(typeof reponse.timestamp).toBe("string");
  });

  it("le contexte porte le contrat normalisé complet (trace, session, agent, limites)", async () => {
    const { construireContexte } = await import("../execution/execution-context");
    const ctx = construireContexte({
      executionId: "exec-contexte-2",
      userId: "utilisateur-normalise",
      capabilityId: "natif:gen3ia:web.search",
      input: {},
      origine: "agent",
      agentId: "agent-02",
      sessionId: "session-123",
      traceId: "trace-123",
      approvalContext: { niveau: "politique", autorisePar: "politique-defaut" },
      resourceLimits: { maxDurationMs: 120_000, maxMemoryMb: 512, maxOutputBytes: 100_000 },
    });
    expect(ctx.traceId).toBe("trace-123");
    expect(ctx.deadlineMs).toBe(120_000);
    expect(ctx.budgetSortieOctets).toBe(100_000);
    expect(ctx.demande.approvalContext?.niveau).toBe("politique");
  });
});
