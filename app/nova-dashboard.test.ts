import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Exigences utilisateur (production) — verrouillage structurel de la
 * simplification « dashboard = chat IA » (NOVA) :
 *
 *  1. LE DASHBOARD EST LE CHAT : /dashboard rend NovaChat directement,
 *     et le composer NOVA réunit les 5 commandes demandées :
 *     envoi du prompt, import de fichiers, outils (plugins), sélection
 *     d'effort et recherche web (toggle).
 *  2. RECHERCHE WEB de bout en bout : le bouton envoie `webSearch: true`
 *     → l'API stream accepte le champ → le moteur FORCE web.search
 *     (mode chat ET mode plan) — le bouton ne peut pas être ignoré.
 *  3. AGENTS SOUS COMMANDE DE L'IA : le moteur branché sur
 *     detectAgentIntent (créer / lister / activer / désactiver /
 *     supprimer un agent en langage naturel → services réels du Studio).
 *  4. ÉCRITURE PROGRESSIVE : un tampon lissé révèle le texte mot à mot
 *     (empilerDelta → horloge → terminerEcriture) — l'IA « écrit » sa
 *     réponse au lieu de l'afficher d'un bloc.
 *  5. LIVE AGENT PRÉSERVÉ : le répertoire live-agent/ reste en place,
 *     intact, hors de portée de la refonte du dashboard.
 *
 * Convention du dépôt : ces verrous lisent les sources (theme-consistency,
 * pwa-consistency, agent-chat-ux…) pour empêcher toute régression
 * structurelle future.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const NOVA = "components/chat/nova-chat.tsx";
const DASHBOARD = "app/dashboard/page.tsx";
const STREAM_ROUTE = "app/api/workspace/conversations/[conversationId]/messages/stream/route.ts";
const ENGINE = "lib/domain/conversations/engine.ts";
const NAV_REGISTRY = "components/shells/nav-registry.ts";

describe("Exigence 1 — le dashboard EST le chat IA (5 commandes)", () => {
  it("/dashboard rend NovaChat (aucune page intermédiaire)", () => {
    const page = read(DASHBOARD);
    expect(page).toContain('import NovaChat from "@/components/chat/nova-chat";');
    expect(page).toContain("return <NovaChat />;");
  });

  it("le composer NOVA expose les 5 commandes demandées", () => {
    const nova = read(NOVA);
    // 1) envoi du prompt (⇄ Arrêter)
    expect(nova).toContain('aria-label={enCours ? "Arrêter la génération" : "Envoyer"}');
    expect(nova).toContain('className={`nova-envoi${enCours ? " stop" : ""}`}');
    // 2) import de fichiers
    expect(nova).toContain('aria-label="Joindre des fichiers"');
    expect(nova).toContain('type="file"');
    // 3) outils (plugins)
    expect(nova).toContain('aria-expanded={popOutils}');
    expect(nova).toContain("Applications pour ce message");
    // 4) sélection d'effort
    expect(nova).toContain('aria-expanded={popEffort}');
    expect(nova).toContain("Effort de réflexion");
    // 5) recherche web (toggle)
    expect(nova).toContain("aria-pressed={rechercheWeb}");
    expect(nova).toContain("Recherche web");
  });

  it("la navigation « Chat IA » pointe /dashboard", () => {
    const nav = read(NAV_REGISTRY);
    expect(nav).toContain('href: "/dashboard"');
  });
});

describe("Exigence 2 — recherche web de bout en bout", () => {
  it("le bouton envoie webSearch au corps du tour", () => {
    const nova = read(NOVA);
    expect(nova).toContain("...(rechercheWebRef.current ? { webSearch: true } : {})");
  });

  it("l'API stream valide et transmet webSearch", () => {
    const route = read(STREAM_ROUTE);
    expect(route).toContain("webSearch: z.boolean().optional()");
    expect(route).toContain("webSearch: body.webSearch");
  });

  it("le moteur FORCE web.search (mode chat et mode plan)", () => {
    const engine = read(ENGINE);
    expect(engine).toContain('input.webSearch\n      ? ({ toolName: "web.search"');
    expect(engine).toContain('if (intent.mode === "plan" && input.webSearch && !(intent.steps ?? []).some((s) => s.toolName === "web.search"))');
  });
});

describe("Exigence 3 — agents sous commande de l'IA", () => {
  it("le détecteur d'intentions agents est branché au moteur", () => {
    const engine = read(ENGINE);
    expect(engine).toContain('import { detectAgentIntent, type AgentIntent } from "./agent-intents"');
    expect(engine).toContain("const agentIntent = detectAgentIntent(input.message);");
    expect(engine).toContain("runAgentIntentTurn(baseCtx, agentIntent)");
  });

  it("la création d'agent passe par les services RÉELS du Studio", () => {
    const engine = read(ENGINE);
    expect(engine).toContain("buildQuickCreatePayload");
    expect(engine).toContain("AgentRecordSchema.safeParse");
    expect(engine).toContain("resolveAndHarden");
    expect(engine).toContain("createAgentRecord");
  });

  it("le détecteur respecte le principe anti-hallucination", () => {
    const intents = read("lib/domain/conversations/agent-intents.ts");
    expect(intents).toContain("INFO_GUARD_RE");
    expect(intents).toContain("detectAgentIntent");
  });
});

describe("Exigence 4 — écriture progressive mot à mot", () => {
  it("un tampon lissé révèle le texte (pas d'affichage d'un bloc)", () => {
    const nova = read(NOVA);
    expect(nova).toContain("fluxEcritureRef");
    expect(nova).toContain("empilerDelta(streamId, event.delta)");
    expect(nova).toContain("tickEcriture");
    expect(nova).toContain("terminerEcriture(streamId)");
    // Le curseur d'écriture est rendu pendant la génération.
    expect(nova).toContain('className="nova-curseur"');
  });

  it("les deltas ne sont JAMAIS rendus directement dans le contenu", () => {
    const nova = read(NOVA);
    // Dans le case message_delta : uniquement empilerDelta (pas de majMessage direct).
    const blocDelta = nova.split('case "message_delta":')[1]?.split('case "message_complete":')[0] ?? "";
    expect(blocDelta).toContain("empilerDelta");
    expect(blocDelta).not.toContain("majMessage(");
  });
});

describe("Exigence 5 — live agent préservé", () => {
  it("le répertoire live-agent/ reste en place, intact", () => {
    const pkg = JSON.parse(read("live-agent/package.json")) as { name?: string };
    expect(pkg.name).toBeTruthy();
  });
});
