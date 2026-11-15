import { describe, expect, it } from "vitest";

/**
 * MOTEUR DE VARIABLES DE PROMPTS : jetons connus résolus avec l'état réel
 * (date/heure/fuseau/utilisateur/agent), jetons inconnus SUPPRIMÉS (jamais
 * de placeholder qui fuit dans le prompt), fuseau invalide = repli UTC.
 */

import {
  applyPromptVariables,
  buildPromptVariables,
  renderPromptTemplate,
} from "./prompt-template";

const NOW = new Date("2026-10-03T09:05:00.000Z"); // samedi

describe("buildPromptVariables", () => {
  it("résout date/heure/weekday dans le fuseau fourni", () => {
    const variables = buildPromptVariables({ timezone: "Africa/Douala", now: NOW }); // UTC+1 → 10:05
    expect(variables.date).toBe("03/10/2026");
    expect(variables.time).toBe("10:05");
    expect(variables.weekday).toBe("samedi");
    expect(variables.year).toBe("2026");
    expect(variables.timezone).toBe("Africa/Douala");
    expect(variables.datetime).toContain("10:05");
    expect(variables.datetime).toContain("Africa/Douala");
  });

  it("sans fuseau : UTC explicite", () => {
    const variables = buildPromptVariables({ now: NOW });
    expect(variables.timezone).toBe("UTC");
    expect(variables.time).toBe("09:05");
  });

  it("fuseau invalide : repli UTC garanti (jamais d'exception)", () => {
    const variables = buildPromptVariables({ timezone: "Mars/Base-1", now: NOW });
    expect(variables.time).toBe("09:05");
  });

  it("utilisateur et agent présents seulement si fournis", () => {
    const full = buildPromptVariables({ userName: "Alice", userEmail: "a@x.io", agentName: "Compta", agentType: "finance", now: NOW });
    expect(full["user.name"]).toBe("Alice");
    expect(full["user.email"]).toBe("a@x.io");
    expect(full["agent.name"]).toBe("Compta");
    expect(full["agent.type"]).toBe("finance");

    const minimal = buildPromptVariables({ now: NOW });
    expect(minimal["user.name"]).toBeUndefined();
    expect(minimal["agent.name"]).toBeUndefined();
  });

  it("agentTypeLabel prime sur agentType", () => {
    const variables = buildPromptVariables({ agentType: "finance", agentTypeLabel: "Assistant comptable", now: NOW });
    expect(variables["agent.type"]).toBe("Assistant comptable");
  });
});

describe("renderPromptTemplate", () => {
  it("remplace les jetons connus et SUPPRIME les inconnus (signalés)", () => {
    const { text, unresolved } = renderPromptTemplate(
      "Bonjour {{user.name}}, nous sommes {{weekday}} {{date}}. Contexte : {{secret.api_key}} et {{jeton.bizarre}}.",
      { "user.name": "Alice", weekday: "samedi", date: "03/10/2026" },
    );
    expect(text).toBe("Bonjour Alice, nous sommes samedi 03/10/2026. Contexte :  et .");
    expect(unresolved.sort()).toEqual(["jeton.bizarre", "secret.api_key"]);
  });

  it("tolère les espaces dans les délimiteurs", () => {
    const { text } = renderPromptTemplate("Il est {{ time }} à {{  timezone }}.", { time: "10:05", timezone: "UTC" });
    expect(text).toBe("Il est 10:05 à UTC.");
  });
});

describe("applyPromptVariables (charte réelle)", () => {
  it("charte avec variables dynamiques entièrement résolue", () => {
    const { text } = applyPromptVariables(
      "Tu es {{agent.name}}, spécialiste {{agent.type}}. Utilisateur : {{user.name}}. Nous sommes le {{date}} ({{weekday}}), il est {{time}} ({{timezone}}). Rapport demandé avant {{deadline}}.",
      { agentName: "Analyste", agentType: "finance", userName: "Alice", timezone: "Africa/Douala", now: NOW },
    );
    expect(text).toContain("Tu es Analyste");
    expect(text).toContain("Utilisateur : Alice");
    expect(text).toContain("(samedi)");
    expect(text).toContain("10:05");
    expect(text).not.toContain("{{");
    expect(text).not.toContain("deadline");
  });

  it("unresolved reflète les variables demandées mais non fournies", () => {
    const { unresolved } = applyPromptVariables("Heure : {{time}} ; boss : {{user.name}} ; {{agent.name}} manquant.", { now: NOW });
    expect(unresolved.sort()).toEqual(["agent.name", "user.name"]);
  });
});
