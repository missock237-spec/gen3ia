import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Exigences utilisateur (production) — verrouillage structurel des 4
 * corrections de l'expérience agent IA :
 *  1. PLEIN ÉCRAN : le chat de l'agent IA possède un vrai mode plein écran
 *     (bouton d'en-tête + overlay « fixed inset-0 » + API Fullscreen native).
 *  2. REPRISE APRÈS REFRESH : la conversation et la mission en cours
 *     réapparaissent après actualisation de la page (sessionStorage +
 *     ré-armement du suivi live sur run non terminal).
 *  3. POLYVALENCE : l'agent ne refuse plus les demandes « hors domaine » —
 *     il répond à tout et exécute les tâches avec les outils fournis ; la
 *     porte de refus déterministe ne couvre que l'impossible matériel.
 *
 * Convention du dépôt : ces verrous lisent les sources (theme-consistency,
 * pwa-consistency…) pour empêcher toute régression structurelle future.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

const PANEL = "components/agent/agent-chat-panel.tsx";

describe("Exigence 1 — mode PLEIN ÉCRAN du chat agent IA", () => {
  const panel = read(PANEL);

  it("le panneau expose une bascule plein écran complète (état + ref + API native)", () => {
    expect(panel).toContain("const [fullscreen, setFullscreen] = React.useState(false);");
    expect(panel).toContain("const sectionRef = React.useRef<HTMLElement | null>(null);");
    expect(panel).toContain("function toggleFullscreen()");
    expect(panel).toContain("requestFullscreen");
    expect(panel).toContain("document.exitFullscreen");
    // Synchronisation avec la sortie native (Échap / F11).
    expect(panel).toContain('document.addEventListener("fullscreenchange", onChange)');
  });

  it("le bouton d'en-tête existe et est accessible (aria-pressed + libellés explicites)", () => {
    expect(panel).toContain('onClick={toggleFullscreen}');
    expect(panel).toContain("aria-pressed={fullscreen}");
    expect(panel).toContain("⛶ Plein écran");
    expect(panel).toContain("◱ Quitter le plein écran");
  });

  it("l'overlay plein écran couvre TOUTE l'interface (fixed inset-0 au-dessus de tout)", () => {
    expect(panel).toContain('fullscreen ? "fixed inset-0 z-[100] h-[100dvh] max-h-none w-screen lg:rounded-none lg:border-0 lg:shadow-none" : ""');
    // Le ref est bien attaché à la section plein écran.
    expect(panel).toMatch(/<section\s*\n\s*ref=\{sectionRef\}/);
  });
});

describe("Exigence 2 — REPRISE APRÈS REFRESH (conversation + mission en cours)", () => {
  const panel = read(PANEL);

  it("la dernière conversation ouverte est mémorisée par agent (sessionStorage)", () => {
    expect(panel).toContain("function conversationStorageKey(agentId: string)");
    expect(panel).toContain("gen3ia:agent-chat:conversation:");
    expect(panel).toContain("function rememberConversation(id: string | null)");
    expect(panel).toContain("sessionStorage.setItem(conversationStorageKey(agent.id), id)");
    // Le reset utilisateur efface la mémorisation (pas de fil fantôme).
    expect(panel).toContain("rememberConversation(null);");
  });

  it("au montage, la conversation mémorisée est rouverte automatiquement", () => {
    expect(panel).toContain("REPRISE APRÈS REFRESH");
    expect(panel).toContain("sessionStorage.getItem(conversationStorageKey(agent.id))");
    expect(panel).toContain("void openConversation(stored);");
  });

  it("un run non terminal réarme le suivi live (la mission reste visible en exécution)", () => {
    expect(panel).toContain("const freshestRun = runList[0];");
    expect(panel).toContain('const terminalStatuses = ["completed", "failed", "cancelled", "awaiting_approval", "waiting_approval"];');
    expect(panel).toContain("setTracking({\n          runId: freshestRun.id,");
  });

  it("le panneau mission live s'affiche même quand la requête locale est terminée (tracking seul)", () => {
    expect(panel).toContain("const missionLive = loading || tracking !== null;");
    expect(panel).toContain("{missionLive && (");
    // Bandeau honnête de reprise : l'utilisateur VOIT que la mission continue.
    expect(panel).toContain("elle continue côté serveur, même après l&apos;actualisation de la page");
  });
});

describe("Exigence 3 — agent POLYVALENT (aucun refus de domaine)", () => {
  it("la charte impose la polyvalence et interdit le refus de domaine", () => {
    const charter = read("lib/agents/charter.ts");
    expect(charter).toContain("PÉRIMÈTRE & POLYVALENCE");
    expect(charter).toContain("Ne refuse JAMAIS une demande au motif que le sujet sort de ton domaine");
    expect(charter).not.toContain("refus courtois et professionnel");
    expect(charter).not.toContain("PÉRIMÈTRE STRICT");
  });

  it("le classificateur ne renvoie inScope:false QUE pour l'impossible matériel", () => {
    const engine = read("lib/agents/chat-engine.ts");
    expect(engine).toContain("Les agents Gen3ia sont POLYVALENTS");
    expect(engine).toContain("inScope: false UNIQUEMENT si la demande est matériellement impossible");
    // L'ancienne règle de refus inter-métiers a disparu.
    expect(engine).not.toContain("CLAIREMENT d'un AUTRE métier");
  });

  it("la route n'utilise plus de refus hors-domaine (renommé en capacité indisponible)", () => {
    const route = read("app/api/agent/chat/route.ts");
    expect(route).toContain("unavailableCapabilityReply");
    expect(route).not.toContain("outOfScopeReply");
    expect(route).not.toContain("refus professionnel");
  });

  it("l'interface du chat ne promet plus un agent cantonné à son domaine", () => {
    const panel = read(PANEL);
    expect(panel).toContain("spécialiste {typeLabel}</strong>, avec les outils et connecteurs fournis");
    expect(panel).toContain("répond à tout et agit avec les outils fournis");
    expect(panel).not.toContain("exclusivement dans mon domaine");
    expect(panel).not.toContain("répond et agit uniquement en");
  });
});
