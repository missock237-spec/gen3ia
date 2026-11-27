import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GEN3IA_TOOLS } from "@/lib/tools/registry";
import { KNOWN_TOOL_SECURITY_NAMES } from "@/lib/security/tool-permissions";
import { PROJECT_SERVICE_TOOLS } from "@/lib/agents/services/bridge";
import { createDefaultToolRegistry } from "@/lib/tools";

/**
 * GARDE DE COHÉRENCE DES REGISTRES D'OUTILS (v2 — 2026-11-27, audit outils).
 *
 * L'audit a mesuré une désynchronisation réelle : 13 outils du catalogue
 * sans définition de sécurité (annoncés au planificateur, rejetés par
 * authorizeTool → échec garanti), 2 définitions de sécurité sans entrée
 * catalogue (capacités invisibles), 8 exécuteurs réels absents du catalogue
 * (le planner les jugeait « INDISPONIBLE » à tort), et des fantômes
 * (camera.capture, ads.publish, file.modify, artifact.download) référencés
 * sans exécuteur. Ce test rend ces classes de bugs IMPOSSIBLES à
 * réintroduire : les trois couches (catalogue GEN3IA_TOOLS ↔ TOOL_SECURITY ↔
 * registre exécutable default-registry) doivent rester synchronisées, ainsi
 * que PROJECT_SERVICE_TOOLS.
 *
 * Capacité annoncée = capacité exécutable = capacité visible du
 * planificateur — ou l'outil n'existe pas (doctrine it.58 : jamais de
 * fantôme, jamais d'échec garanti).
 */

/** Env généreuses : TOUTES les registrations conditionnelles ont lieu. */
const ENV_GENEREUSES: Record<string, string> = {
  COMPOSIO_API_KEY: "test-composio-key",
  NOTION_API_TOKEN: "test-notion-token",
  CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
  GITHUB_TOKEN: "test-github-token",
  WHATSAPP_ACCESS_TOKEN: "test-whatsapp-token",
  WHATSAPP_PHONE_NUMBER_ID: "test-whatsapp-id",
  RESEND_API_KEY: "test-resend-key",
  EMAIL_FROM_ADDRESS: "test@gen3ia.test",
};

const sauvegardeEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const [cle, valeur] of Object.entries(ENV_GENEREUSES)) {
    sauvegardeEnv[cle] = process.env[cle];
    process.env[cle] = valeur;
  }
});

afterAll(() => {
  for (const [cle, valeur] of Object.entries(sauvegardeEnv)) {
    if (valeur === undefined) delete process.env[cle];
    else process.env[cle] = valeur;
  }
});

describe("cohérence des registres d'outils (v2 — audit outils)", () => {
  const catalogue = GEN3IA_TOOLS.map((t) => t.name);

  it("aucun doublon dans le catalogue GEN3IA_TOOLS", () => {
    const doublons = catalogue.filter((nom, i) => catalogue.indexOf(nom) !== i);
    expect(doublons).toEqual([]);
  });

  it("tout outil du CATALOGUE possède une définition de SÉCURITÉ (annoncé = exécutable)", () => {
    const sansDefinition = catalogue.filter((nom) => !KNOWN_TOOL_SECURITY_NAMES.has(nom));
    expect(sansDefinition).toEqual([]);
  });

  it("toute définition de SÉCURITÉ correspond à un outil du CATALOGUE (capacité cachée interdite)", () => {
    const horsCatalogue = [...KNOWN_TOOL_SECURITY_NAMES].filter((nom) => !catalogue.includes(nom));
    expect(horsCatalogue).toEqual([]);
  });

  it("tout outil du REGISTRE EXÉCUTABLE possède une définition de sécurité (authorizeTool ne lève jamais)", () => {
    const registry = createDefaultToolRegistry();
    const ids = registry.list().map((t) => t.id ?? t.name);
    const sansDefinition = ids.filter((id) => !KNOWN_TOOL_SECURITY_NAMES.has(id));
    expect(sansDefinition).toEqual([]);
  });

  it("tout outil du REGISTRE EXÉCUTABLE est annoncé au CATALOGUE (le planner ne juge plus « INDISPONIBLE » à tort)", () => {
    const registry = createDefaultToolRegistry();
    const ids = registry.list().map((t) => t.id ?? t.name);
    const invisibles = ids.filter((id) => !catalogue.includes(id));
    expect(invisibles).toEqual([]);
  });

  it("tout outil-service du projet (PROJECT_SERVICE_TOOLS) possède une définition de sécurité", () => {
    const sansDefinition = PROJECT_SERVICE_TOOLS.filter((nom) => !KNOWN_TOOL_SECURITY_NAMES.has(nom));
    expect(sansDefinition).toEqual([]);
  });

  it("aucun fantôme retiré (it.58 + v2) ne réapparaît dans une couche quelconque", () => {
    const fantomes = ["file.modify", "artifact.download", "voice.list", "phone.call", "ui.components", "camera.capture", "ads.publish", "jules.create_task", "jules.get_task"];
    for (const fantome of fantomes) {
      expect(catalogue).not.toContain(fantome);
      expect(KNOWN_TOOL_SECURITY_NAMES.has(fantome)).toBe(false);
      expect(PROJECT_SERVICE_TOOLS).not.toContain(fantome);
    }
  });
});
