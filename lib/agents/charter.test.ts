import { describe, expect, it } from "vitest";

import { buildAgentCharter, labelForAgent, WIZARD_AGENT_TYPES, wizardTypeForKey } from "./charter";

const baseAgent = {
  name: "CodeMaster",
  description: "Agent développeur senior spécialisé en applications web.",
  type: "code",
  skills: ["React & Next.js", "Débogage"],
  agentMode: "standard" as const,
};

describe("charter de l'agent", () => {
  it("contient l'identité, la mission et les compétences", () => {
    const charter = buildAgentCharter(baseAgent);
    expect(charter).toContain("CodeMaster");
    expect(charter).toContain("Agent développeur senior spécialisé en applications web.");
    expect(charter).toContain("React & Next.js");
    expect(charter).toContain("Débogage");
  });

  it("impose un périmètre strict et un refus professionnel hors domaine", () => {
    const charter = buildAgentCharter(baseAgent);
    expect(charter).toContain("PÉRIMÈTRE STRICT");
    expect(charter).toContain("refus courtois et professionnel");
    expect(charter).toContain("n'agis jamais hors de ton rôle");
  });

  it("impose des règles de conduite professionnelles", () => {
    const charter = buildAgentCharter(baseAgent);
    expect(charter).toContain("RÈGLES DE CONDUITE PROFESSIONNELLE");
    expect(charter).toContain("français clair, précis et professionnel");
  });

  it("mentionne le fichier mémoire associé", () => {
    const charter = buildAgentCharter({
      ...baseAgent,
      memoryFile: { path: "users/u1/files/knowledge.pdf", name: "knowledge.pdf" },
    });
    expect(charter).toContain("MÉMOIRE DÉDIÉE");
    expect(charter).toContain("knowledge.pdf");
  });

  it("distingue la nature agent d'appel et agent standard", () => {
    const call = buildAgentCharter({ ...baseAgent, agentMode: "call" });
    const standard = buildAgentCharter({ ...baseAgent, agentMode: "standard" });
    expect(call).toContain("agent d'appel");
    expect(standard).toContain("agent standard");
    expect(call).not.toContain("agent standard —");
  });

  it("utilise le type personnalisé comme domaine d'expertise", () => {
    const charter = buildAgentCharter({ ...baseAgent, type: "universal", typeLabel: "Juridique" });
    expect(charter).toContain("Domaine d'expertise : Juridique");
    expect(charter).toContain("spécialiste : Juridique");
  });
});

describe("persona avancée dans la charte", () => {
  it("injecte ton, format, humour et langue configurés", () => {
    const charter = buildAgentCharter({
      ...baseAgent,
      persona: {
        tone: "convivial",
        verbosity: "concis",
        humor: "leger",
        language: "English",
        constraints: [],
        capabilities: { webSearch: true, codeExecution: true, dataAnalysis: true, fileGeneration: true },
      },
    });
    expect(charter).toContain("STYLE DE PERSONNALITÉ");
    expect(charter).toContain("chaleureux et accessible");
    expect(charter).toContain("3 à 6 phrases maximum");
    expect(charter).toContain("pointe discrète");
    expect(charter).toContain("systématiquement en English");
  });

  it("n'ajoute aucune section de style pour la persona par défaut", () => {
    const charter = buildAgentCharter({
      ...baseAgent,
      persona: {
        tone: "professionnel",
        verbosity: "equilibre",
        humor: "aucun",
        language: "Français",
        constraints: [],
        capabilities: { webSearch: true, codeExecution: true, dataAnalysis: true, fileGeneration: true },
      },
    });
    expect(charter).not.toContain("STYLE DE PERSONNALITÉ");
    expect(charter).not.toContain("CONTRAINTES ABSOLUES");
    expect(charter).not.toContain("LIMITES DE CAPACITÉS");
  });

  it("inscrit les interdictions du propriétaire comme contraintes absolues", () => {
    const charter = buildAgentCharter({
      ...baseAgent,
      persona: {
        tone: "professionnel",
        verbosity: "equilibre",
        humor: "aucun",
        language: "Français",
        constraints: ["Ne jamais donner de conseil médical", "Ne jamais promettre de délai"],
        capabilities: { webSearch: true, codeExecution: true, dataAnalysis: true, fileGeneration: true },
      },
    });
    expect(charter).toContain("CONTRAINTES ABSOLUES");
    expect(charter).toContain("Ne jamais donner de conseil médical");
    expect(charter).toContain("Ne jamais promettre de délai");
  });

  it("annonce les capacités désactivées comme limites", () => {
    const charter = buildAgentCharter({
      ...baseAgent,
      persona: {
        tone: "professionnel",
        verbosity: "equilibre",
        humor: "aucun",
        language: "Français",
        constraints: [],
        capabilities: { webSearch: false, codeExecution: false, dataAnalysis: true, fileGeneration: false },
      },
    });
    expect(charter).toContain("LIMITES DE CAPACITÉS");
    expect(charter).toContain("recherche web est DÉSACTIVÉE");
    expect(charter).toContain("exécution de code est DÉSACTIVÉE");
    expect(charter).toContain("génération de fichiers est DÉSACTIVÉE");
  });
});

describe("catalogue des types du wizard", () => {
  it("expose les 7 options dont un type personnalisé", () => {
    expect(WIZARD_AGENT_TYPES).toHaveLength(7);
    const keys = WIZARD_AGENT_TYPES.map((entry) => entry.key);
    expect(keys).toEqual(["code", "marketing", "research", "content", "automation", "universal", "custom"]);
  });

  it("couvre les types métier demandés (code, marketing, recherche, contenu)", () => {
    const labels = WIZARD_AGENT_TYPES.map((entry) => entry.label);
    expect(labels).toContain("Développement & Code");
    expect(labels).toContain("Marketing");
    expect(labels).toContain("Recherche & Analyse");
    expect(labels).toContain("Création de contenu");
  });

  it("résout chaque clé du wizard vers un type technique valide", () => {
    for (const entry of WIZARD_AGENT_TYPES) {
      expect(["universal", "code", "content", "research", "automation"]).toContain(entry.baseType);
      expect(wizardTypeForKey(entry.key)).toBeDefined();
    }
  });

  it("réserve l'atelier 21st.dev aux agents de code via les outils déclarés", () => {
    const code = wizardTypeForKey("code");
    expect(code?.declaredTools).toContain("code.execute");
    for (const entry of WIZARD_AGENT_TYPES.filter((item) => item.key !== "code")) {
      expect(entry.declaredTools).not.toContain("ui.components");
    }
  });
});

describe("labelForAgent", () => {
  it("privilégie le typeLabel saisi par l'utilisateur", () => {
    expect(labelForAgent({ type: "content", typeLabel: "Marketing" })).toBe("Marketing");
  });

  it("retombe sur le libellé du type technique", () => {
    expect(labelForAgent({ type: "code" })).toBe("Agent de code");
    expect(labelForAgent({ type: "unknown" })).toBe("Assistant IA");
  });
});
