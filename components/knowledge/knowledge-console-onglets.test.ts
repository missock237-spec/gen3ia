import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * KNOWLEDGE SPACES — ONGLETS DÉCLENCHEURS + COMPÉTENCES (it.50) —
 * conventions du dépôt : vitest tourne en Node SANS jsdom ni
 * @testing-library/react (cf. knowledge-console.test.ts). Le câblage des
 * 5 portes restantes du LOT 6 dans l'espace Connaissances
 * (components/knowledge/knowledge-console.tsx) est verrouillé
 * structurellement :
 *
 *  1. LES PORTES DÉCLENCHEURS SONT CONSOMMÉES DANS LEURS QUATRE MODES :
 *     GET liste, POST création (agent cible RÉEL choisi parmi les agents
 *     actifs du Studio — un agentId inventé reçoit le 422 du serveur,
 *     restitué tel quel), PATCH bascule activer/pause, DELETE retrait.
 *  2. LES PORTES COMPÉTENCES SONT CONSOMMÉES DANS LEURS TROIS MODES :
 *     GET bibliothèque (système + privées actives), POST Skill Factory
 *     LOCALE déterministe (zéro service externe), POST import catalogue
 *     skills.sh idempotent (déjà présent restitué item par item).
 *  3. L'ÉTAT EST HONNÊTE : 401 → connexion, 429 → message de la porte
 *     (10 créations/5 min, import catalogué), échec réseau affiché
 *     (role=alert) — onglets à la demande (aria-current), jamais avalé.
 *  4. ZÉRO DÉPENDANCE EXTERNE : les portes consommées sont uniquement
 *     les portes maison (authFetch same-origin, convention du fichier).
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const CONSOLE = "components/knowledge/knowledge-console.tsx";

describe("Knowledge Spaces — onglets déclencheurs + compétences (câblage LOT 6, it.50)", () => {
  const consoleData = read(CONSOLE);

  it("les portes déclencheurs sont consommées dans leurs quatre modes (liste, création, bascule, suppression)", () => {
    // GET — liste des règles du compte.
    expect(consoleData).toContain('authFetch("/api/knowledge/triggers", { cache: "no-store" })');
    // POST — création (règle de correspondance + agent cible + objectif).
    expect(consoleData).toContain('authFetch("/api/knowledge/triggers", {');
    expect(consoleData).toContain('action: { type: "run_agent_mission", agentId: triggerAgent, objectiveTemplate: triggerObjectif.trim() }');
    // PATCH + DELETE — bascule activer/pause et retrait (ressource [id]).
    expect(consoleData).toContain("`/api/knowledge/triggers/${trigger.id}`");
    expect(consoleData).toContain('method: "PATCH"');
    expect(consoleData).toContain('{ method: "DELETE" }');
    // L'agent cible est choisi parmi les agents RÉELS du Studio (actifs).
    expect(consoleData).toContain('authFetch("/api/agents"');
    expect(consoleData).toContain('agent.status === "active"');
    // Les jetons du modèle d'objectif sont annoncés à l'utilisateur.
    expect(consoleData).toContain("{{document.name}}");
    expect(consoleData).toContain("{{document.excerpt}}");
    // La validation est annoncée côté serveur (honnêteté du contrat).
    expect(consoleData).toContain("L&apos;agent cible doit exister et être actif");
  });

  it("les portes compétences sont consommées dans leurs trois modes (bibliothèque, factory locale, import idempotent)", () => {
    // GET — bibliothèque (compétences système + privées actives).
    expect(consoleData).toContain('authFetch("/api/skills?status=active"');
    // POST — Skill Factory LOCALE déterministe (objectif, type, capacités,
    // outils, sortie attendue) — zéro service externe.
    expect(consoleData).toContain('authFetch("/api/skills/create"');
    expect(consoleData).toContain("requiredCapabilities:");
    expect(consoleData).toContain("requiredTools:");
    expect(consoleData).toContain("DÉTERMINISTE par la Skill Factory locale");
    // POST — import idempotent du catalogue skills.sh.
    expect(consoleData).toContain('authFetch("/api/skills/import"');
    expect(consoleData).toContain("Importer le catalogue");
    // L'idempotence est restituée item par item (déjà présent = pas d'écriture).
    expect(consoleData).toContain("déjà dans la bibliothèque");
    expect(consoleData).toContain("importée");
  });

  it("l'état est honnête : 401 → connexion, 429 → message de la porte, échec affiché, onglets à la demande", () => {
    // 401 — messages de connexion par volet (connaissances / compétences).
    expect(consoleData).toContain("Connectez-vous pour gérer vos connaissances.");
    expect(consoleData).toContain("Connectez-vous pour gérer vos compétences.");
    // 429 — messages de la porte restitués (rate-limit create, import).
    expect(consoleData).toContain("Trop de créations rapprochées. Réessayez dans quelques instants.");
    // Échec réseau affiché (role alert + status) — jamais avalé.
    expect(consoleData).toContain('role="alert"');
    expect(consoleData).toContain('role="status"');
    // Onglets réels, accessibles, à la demande (aria-current, deep-links).
    expect(consoleData).toContain("Sections de l'espace connaissances");
    expect(consoleData).toContain("aria-current={tab === item.id ? \"page\" : undefined}");
    expect(consoleData).toContain('label: "Déclencheurs"');
    expect(consoleData).toContain('label: "Compétences"');
    // Chargement À LA DEMANDE : zéro requête au montage pour les volets
    // non visités (l'effect est conditionné à l'onglet actif).
    expect(consoleData).toContain("Chargement À LA DEMANDE");
    expect(consoleData).toContain("void chargerTriggers();");
    expect(consoleData).toContain("void chargerSkills();");
  });

  it("zéro dépendance externe : les portes consommées sont uniquement les portes maison", () => {
    const sectionVolets = consoleData.slice(
      consoleData.indexOf("DÉCLENCHEURS D'INGESTION (concept post-SaaS #9)"),
      consoleData.indexOf("const projetActif"),
    );
    expect(sectionVolets).toContain("/api/knowledge/triggers");
    expect(sectionVolets).toContain("/api/skills");
    expect(sectionVolets).not.toMatch(/https?:\/\//);
    expect(sectionVolets).not.toContain("axios");
  });
});
