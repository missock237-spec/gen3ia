import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task 140 — Outil « simulation.run » (Agentic Social Simulation Studio).
 *
 * Voies réelles vérifiées : sessions de personas via generateStructuredForUser
 * (LLM facturé — mocké à la frontière du module de facturation), agrégation
 * DÉTERMINISTE des sévérités (critique / majeur / mineur), ancrage fail-soft
 * sur une page réelle (fetch + garde SSRF), rapport markdown PERSISTÉ via
 * persistMarkdownDeliverable (engine + artifact-store mockés à la frontière).
 */

vi.mock("@/lib/billing/ai-execution", () => ({
  generateForUser: vi.fn(),
}));

vi.mock("@/lib/documents/engine", () => ({
  generateArtifact: vi.fn(),
}));

vi.mock("@/lib/documents/artifact-store", () => ({
  storeArtifactBuffer: vi.fn(),
}));

vi.mock("@/lib/security/url-safety", () => ({
  assertPublicHttpUrl: vi.fn(),
}));

import { generateForUser } from "@/lib/billing/ai-execution";
import { generateArtifact } from "@/lib/documents/engine";
import { storeArtifactBuffer } from "@/lib/documents/artifact-store";
import { assertPublicHttpUrl } from "@/lib/security/url-safety";

import {
  aggregateSimulationFindings,
  simulationRunTool,
  type SimulatedSession,
} from "./simulation-run";

const mockedGenerate = vi.mocked(generateForUser);
const mockedGenerateArtifact = vi.mocked(generateArtifact);
const mockedStore = vi.mocked(storeArtifactBuffer);
const mockedAssertUrl = vi.mocked(assertPublicHttpUrl);

const CONTEXT = { userId: "user-1", executionId: "exec-1" };

/* ------------------------------------------------------------------ */
/* Données de test                                                     */
/* ------------------------------------------------------------------ */

function validSession(overrides: Partial<SimulatedSession> = {}): SimulatedSession {
  return {
    personaName: "Persona",
    actions: [
      { step: 1, action: "Ouvre la page d'accueil", expectation: "Comprendre l'offre", outcome: "success" },
    ],
    satisfactionScore: 7,
    frictionPoints: [],
    wouldAbandon: false,
    ...overrides,
  };
}

/** Sessions indexées par nom de persona — le prompt LLM contient « PERSONA : <nom> ». */
let sessionsByPersona: Record<string, SimulatedSession> = {};
let synthesisPayload: { overallScore: number; summary: string; recommendations: string[] } = {
  overallScore: 5,
  summary: "Le tunnel freine les personas pressées et les erreurs sont muettes.",
  recommendations: ["Raccourcir le tunnel d'achat", "Afficher les messages d'erreur"],
};

const BASE_INPUT = {
  targetName: "Boutique démo",
  targetDescription: "Boutique en ligne de formation avec tunnel d'achat en cinq étapes.",
  scenario: "Un client veut acheter une formation et paie en ligne.",
};

const THREE_PERSONAS = [
  { name: "Novice curieux", archetype: "novice" as const },
  { name: "Acheteur pressé", archetype: "impatient_buyer" as const },
  { name: "Utilisateur méfiant", archetype: "skeptic" as const },
];

/** Le runtime (lib/tools/executor.ts) PARSE l'entrée via inputSchema avant execute — idem ici. */
function simInput(overrides: Record<string, unknown> = {}) {
  return simulationRunTool.inputSchema.parse({ ...BASE_INPUT, ...overrides });
}

beforeEach(() => {
  // resetAllMocks (et non clearAllMocks) : aucune file d'implémentation « Once » ne doit fuiter entre tests.
  vi.resetAllMocks();
  mockedAssertUrl.mockImplementation(async (url: string) => new URL(url));
  mockedGenerateArtifact.mockResolvedValue({
    filename: "rapport-de-simulation-boutique-demo.md",
    mimeType: "text/markdown; charset=utf-8",
    format: "md",
    data: Buffer.from("# Rapport de simulation — Boutique démo"),
    artifactId: "gen-1",
    storagePath: "users/user-1/artifacts/gen-1/rapport.md",
  } as Awaited<ReturnType<typeof generateArtifact>>);
  mockedStore.mockResolvedValue({
    artifactId: "art-1",
    name: "rapport-de-simulation-boutique-demo.md",
    storageKey: "users/user-1/artifacts/art-1/rapport.md",
  });
  sessionsByPersona = {
    "Novice curieux": validSession({
      // Le nom renvoyé par le LLM est volontairement faux : le serveur impose le nom d'entrée.
      personaName: "nom renvoyé par le LLM",
      actions: [
        { step: 1, action: "Ouvre la page d'accueil", expectation: "Comprendre l'offre", outcome: "success" },
        {
          step: 2,
          action: "Soumet le formulaire vide",
          expectation: "Voir un message d'erreur clair",
          outcome: "blocker",
          note: "Aucune validation, la page ne réagit pas",
        },
      ],
      satisfactionScore: 4,
      frictionPoints: ["Messages d'erreur absents lors de la saisie invalide"],
      wouldAbandon: true,
    }),
    "Acheteur pressé": validSession({
      personaName: "Acheteur pressé",
      actions: [
        {
          step: 1,
          action: "Clique sur « Acheter maintenant »",
          expectation: "Finaliser en moins d'une minute",
          outcome: "friction",
        },
      ],
      satisfactionScore: 3,
      frictionPoints: ["Tunnel d'achat en 5 étapes trop long pour acheter vite"],
      wouldAbandon: true,
    }),
    "Utilisateur méfiant": validSession({
      personaName: "Utilisateur méfiant",
      actions: [
        { step: 1, action: "Ouvre la page de paiement", expectation: "Voir le prix total avant de payer", outcome: "success" },
        {
          step: 2,
          action: "Valide le panier",
          expectation: "Une confirmation claire",
          outcome: "friction",
          note: "Le prix final diffère de l'affiché",
        },
        {
          step: 3,
          action: "Tente de payer avec une carte refusée",
          expectation: "Comprendre la cause du refus",
          outcome: "blocker",
        },
      ],
      satisfactionScore: 2,
      frictionPoints: ["Messages d'erreur absents lors de la validation du panier"],
      wouldAbandon: false,
    }),
  };
  synthesisPayload = {
    overallScore: 5,
    summary: "Le tunnel freine les personas pressées et les erreurs sont muettes.",
    recommendations: ["Raccourcir le tunnel d'achat", "Afficher les messages d'erreur"],
  };
  // Répartiteur déterministe : session de persona si le prompt la nomme, sinon synthèse.
  mockedGenerate.mockImplementation(async (params) => {
    const content = params.request.messages[0]?.content ?? "";
    const entry = Object.entries(sessionsByPersona).find(([name]) => content.includes(`PERSONA : ${name}`));
    const payload = entry ? entry[1] : synthesisPayload;
    return {
      response: {
        id: "resp-test",
        provider: "glm",
        model: "glm-test",
        text: JSON.stringify(payload),
        usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        latencyMs: 5,
      },
      chargeMinor: 0,
      providerCostEur: 0,
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Schéma d'entrée                                                    */
/* ------------------------------------------------------------------ */

describe("outil simulation.run — schéma d'entrée", () => {
  it("applique les personas et la profondeur par défaut", () => {
    const parsed = simulationRunTool.inputSchema.parse(BASE_INPUT);
    expect(parsed.personas).toHaveLength(3);
    expect(parsed.personas.map((persona) => persona.archetype)).toEqual(["novice", "impatient_buyer", "skeptic"]);
    expect(parsed.depth).toBe("standard");
  });

  it("refuse 7 personas (maximum 6) et accepte la borne 6", () => {
    const personas = Array.from({ length: 7 }, (_, i) => ({ name: `Persona ${i + 1}`, archetype: "novice" as const }));
    expect(() => simulationRunTool.inputSchema.parse({ ...BASE_INPUT, personas })).toThrow();
    expect(() =>
      simulationRunTool.inputSchema.parse({ ...BASE_INPUT, personas: personas.slice(0, 6) }),
    ).not.toThrow();
  });

  it("refuse une description trop courte, un scénario trop court et une URL invalide", () => {
    expect(() => simulationRunTool.inputSchema.parse({ ...BASE_INPUT, targetDescription: "trop court" })).toThrow();
    expect(() => simulationRunTool.inputSchema.parse({ ...BASE_INPUT, scenario: "ab" })).toThrow();
    expect(() => simulationRunTool.inputSchema.parse({ ...BASE_INPUT, targetUrl: "pas-une-url" })).toThrow();
  });

  it("refuse un archétype inconnu", () => {
    expect(() =>
      simulationRunTool.inputSchema.parse({
        ...BASE_INPUT,
        personas: [{ name: "Persona X", archetype: "tourist" }],
      }),
    ).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* Agrégation déterministe (unitaire)                                  */
/* ------------------------------------------------------------------ */

describe("aggregateSimulationFindings — sévérités déterministes", () => {
  it("chaque blocage devient un constat critique avec reproduction du parcours", () => {
    const findings = aggregateSimulationFindings([
      validSession({
        personaName: "A",
        actions: [
          { step: 1, action: "Étape un", expectation: "Passer", outcome: "success" },
          { step: 2, action: "Étape bloquante", expectation: "Continuer", outcome: "blocker" },
        ],
      }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].personas).toEqual(["A"]);
    expect(findings[0].title).toContain("Blocage : Étape bloquante");
    expect(findings[0].reproduction).toContain("étape 1");
    expect(findings[0].reproduction).toContain("étape 2");
  });

  it("une friction partagée par deux personas est MAJEURE, une friction isolée est MINEURE", () => {
    const findings = aggregateSimulationFindings([
      validSession({ personaName: "A", frictionPoints: ["Messages d'erreur absents lors de la saisie invalide"] }),
      validSession({ personaName: "B", frictionPoints: ["Messages d'erreur absents lors de la validation du panier"] }),
      validSession({ personaName: "C", frictionPoints: ["Tunnel d'achat en 5 étapes trop long pour acheter vite"] }),
    ]);
    const major = findings.find((finding) => finding.severity === "major");
    const minor = findings.find((finding) => finding.severity === "minor");
    expect(major?.personas).toEqual(["A", "B"]);
    expect(minor?.personas).toEqual(["C"]);
    // Ordre stable : critique, puis majeur, puis mineur.
    expect(findings.map((finding) => finding.severity)).toEqual(["major", "minor"]);
  });

  it("deux blocages dissemblables restent deux constats critiques distincts", () => {
    const findings = aggregateSimulationFindings([
      validSession({
        personaName: "A",
        actions: [{ step: 1, action: "Soumet le formulaire vide", expectation: "Erreur claire", outcome: "blocker" }],
      }),
      validSession({
        personaName: "B",
        actions: [
          { step: 1, action: "Tente de payer avec une carte refusée", expectation: "Cause du refus", outcome: "blocker" },
        ],
      }),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.severity === "critical")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Exécution                                                           */
/* ------------------------------------------------------------------ */

describe("outil simulation.run — exécution (3 personas sans URL)", () => {
  it("simule chaque persona, agrège les constats, synthétise et PERSISTE le rapport", async () => {
    const output = await simulationRunTool.execute(simInput({ personas: THREE_PERSONAS }), CONTEXT);

    // Une session LLM par persona + une synthèse, toutes facturées via generateForUser.
    expect(mockedGenerate).toHaveBeenCalledTimes(4);
    for (const [params] of mockedGenerate.mock.calls) {
      expect(params.request.task).toBe("agent");
      expect(params.userId).toBe("user-1");
    }

    // Le nom de persona est imposé côté serveur (le LLM avait renvoyé autre chose).
    expect(output.report.sessions.map((session) => session.personaName)).toEqual([
      "Novice curieux",
      "Acheteur pressé",
      "Utilisateur méfiant",
    ]);

    // Sévérités déterministes : 2 critiques (blocages), 1 majeure (friction
    // partagée novice + méfiant), 1 mineure (friction de l'acheteur seul).
    const findings = output.report.findings;
    expect(findings).toHaveLength(4);
    expect(findings.filter((finding) => finding.severity === "critical")).toHaveLength(2);
    const major = findings.find((finding) => finding.severity === "major");
    expect(major?.personas).toEqual(["Novice curieux", "Utilisateur méfiant"]);
    const minor = findings.find((finding) => finding.severity === "minor");
    expect(minor?.personas).toEqual(["Acheteur pressé"]);
    expect(findings[0].severity).toBe("critical");
    expect(findings[3].severity).toBe("minor");

    // Synthèse LLM propagée.
    expect(output.report.overallScore).toBe(5);
    expect(output.report.recommendations).toEqual(["Raccourcir le tunnel d'achat", "Afficher les messages d'erreur"]);

    // Rapport markdown persisté (artefact réel).
    expect(mockedGenerateArtifact).toHaveBeenCalledTimes(1);
    const call = mockedGenerateArtifact.mock.calls[0][0];
    expect(call.userId).toBe("user-1");
    expect(call.plan.title).toBe("Rapport de simulation — Boutique démo");
    expect(call.plan.format).toBe("md");
    const headings = call.plan.blocks
      .filter((block: { type: string }) => block.type === "heading")
      .map((block: { text: string }) => block.text);
    expect(headings).toContain("Vue d'ensemble");
    expect(headings).toContain("Constats par sévérité");
    expect(headings).toContain("Détail par persona");
    expect(headings).toContain("Recommandations");
    expect(mockedStore).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "user-1", name: "rapport-de-simulation-boutique-demo.md" }),
    );
    expect(output.artifactId).toBe("art-1");
    expect(output.filename).toBe("rapport-de-simulation-boutique-demo.md");
    expect(output.warnings).toEqual([]);
  });

  it("la synthèse reçoit maxTokens 1500 et les sessions 2000", async () => {
    await simulationRunTool.execute(simInput({ personas: THREE_PERSONAS }), CONTEXT);
    const synthesisCall = mockedGenerate.mock.calls.find(([params]) =>
      params.request.messages[0]?.content.includes("SESSIONS SIMULÉES"),
    );
    expect(synthesisCall).toBeDefined();
    expect(synthesisCall?.[0].request.maxTokens).toBe(1500);
    const personaCall = mockedGenerate.mock.calls.find(([params]) =>
      params.request.messages[0]?.content.includes("PERSONA : Novice curieux"),
    );
    expect(personaCall?.[0].request.maxTokens).toBe(2000);
  });
});

describe("outil simulation.run — ancrage sur une page réelle (fail-soft)", () => {
  it("récupère la page cible et ancre le prompt de persona dans le contenu réel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html><body><h1>Bienvenue sur la boutique démo</h1><p>Livraison offerte</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const output = await simulationRunTool.execute(
      simInput({ personas: THREE_PERSONAS, targetUrl: "https://exemple.com/boutique" }),
      CONTEXT,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toBe("Gen3ia-AI-Studio/1.0");
    const personaCall = mockedGenerate.mock.calls.find(([params]) =>
      params.request.messages[0]?.content.includes("PERSONA : Novice curieux"),
    );
    expect(personaCall?.[0].request.messages[0]?.content).toContain("CONTENU RÉEL DE LA PAGE CIBLE");
    expect(personaCall?.[0].request.messages[0]?.content).toContain("Bienvenue sur la boutique démo");
    expect(output.warnings).toEqual([]);
  });

  it("suit une redirection unique en revalidant l'URL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/accueil" } }))
      .mockResolvedValueOnce(
        new Response("<html><body>Accueil après redirection</body></html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await simulationRunTool.execute(
      simInput({ personas: THREE_PERSONAS, targetUrl: "https://exemple.com/boutique" }),
      CONTEXT,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockedAssertUrl).toHaveBeenCalledTimes(2);
    expect(mockedGenerate.mock.calls[0][0].request.messages[0]?.content).toContain("Accueil après redirection");
  });

  it("échec de récupération : la simulation continue ancrée sur la description, avec avertissement", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const output = await simulationRunTool.execute(
      simInput({ personas: THREE_PERSONAS, targetUrl: "https://exemple.com/boutique" }),
      CONTEXT,
    );
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain("Impossible de récupérer la page cible");
    expect(output.warnings[0]).toContain("network down");
    // La simulation a bien été produite (4 appels LLM : 3 personas + synthèse).
    expect(mockedGenerate).toHaveBeenCalledTimes(4);
    expect(output.artifactId).toBe("art-1");
  });
});

describe("outil simulation.run — isolement des échecs de persona", () => {
  it("une persona dont la session est invalide est signalée sans casser les autres", async () => {
    // Satisfaction hors bornes (1-10) : le schéma rejette les deux tentatives.
    sessionsByPersona["Novice curieux"] = validSession({ satisfactionScore: 99 });

    const output = await simulationRunTool.execute(simInput({ personas: THREE_PERSONAS }), CONTEXT);

    expect(output.report.sessions.map((session) => session.personaName)).toEqual([
      "Acheteur pressé",
      "Utilisateur méfiant",
    ]);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain("Novice curieux");
    // 2 tentatives pour la persona invalide + 1 par persona valide + synthèse.
    expect(mockedGenerate).toHaveBeenCalledTimes(5);
  });

  it("lève une erreur française si AUCUNE persona n'a pu être simulée", async () => {
    mockedGenerate.mockResolvedValue({
      response: {
        id: "resp-test",
        provider: "glm",
        model: "glm-test",
        text: "je ne suis pas un JSON",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        latencyMs: 1,
      },
      chargeMinor: 0,
      providerCostEur: 0,
    });

    await expect(
      simulationRunTool.execute(simInput({ personas: [{ name: "Solo", archetype: "novice" }] }), CONTEXT),
    ).rejects.toThrow(/Aucune session de persona n'a pu être simulée/);
  });
});
