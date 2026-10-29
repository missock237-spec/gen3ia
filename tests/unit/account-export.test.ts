import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Garde-fou — PORTABILITÉ COMPLÈTE DU COMPTE (itération 25, Job 478451).
 *
 * Constat d'audit : l'export RGPD historique ne couvrait que la mémoire
 * personnalisée, et AUCUNE surface utilisateur n'exposait les endpoints
 * d'export/effacement (dead code côté utilisateur — même pathologie que
 * l'ErrorBoundary non importé de l'itération 22).
 *
 * Ce test verrouille :
 * 1. le module d'export complet (format auto-descriptif, manifest honnête
 *    par namespace, fail-soft : UNE section en erreur n'invalide pas les
 *    autres, caps explicites et signalées) ;
 * 2. la route /api/account/export (garde auth + rate limit, pièce jointe
 *    horodatée, jamais cachée) ;
 * 3. la section UI « Mes données » des Paramètres (les trois droits
 *    effectivement cliquables, double consentement d'effacement) ;
 * 4. le câblage réel dans app/settings/page.tsx.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

vi.mock("@/lib/memory/privacy", () => ({ exportUserData: vi.fn() }));
vi.mock("@/lib/chat/repository", () => ({ listConversations: vi.fn(), listMessages: vi.fn() }));
vi.mock("@/lib/agents/repository", () => ({ listAgentsForUser: vi.fn() }));

import { ACCOUNT_EXPORT_CAPS, exportAccountData } from "@/lib/privacy/account-export";
import { exportUserData } from "@/lib/memory/privacy";
import { listConversations, listMessages } from "@/lib/chat/repository";
import { listAgentsForUser } from "@/lib/agents/repository";

const mockExportUserData = vi.mocked(exportUserData);
const mockListConversations = vi.mocked(listConversations);
const mockListMessages = vi.mocked(listMessages);
const mockListAgents = vi.mocked(listAgentsForUser);

function baseMemoire() {
  return {
    format: "gen3ia.memory-export" as const,
    version: 1 as const,
    exportedAt: "2026-10-29T00:00:00.000Z",
    userId: "u1",
    memories: [{ key: "k", value: "v", source: "test" }],
    aiFeedback: [],
    aiFeedbackLessons: [],
    toolConsents: {},
  };
}

describe("exportAccountData — portabilité complète", () => {
  beforeEach(() => {
    mockExportUserData.mockReset().mockResolvedValue(baseMemoire());
    mockListConversations.mockReset().mockResolvedValue([]);
    mockListMessages.mockReset().mockResolvedValue([]);
    mockListAgents.mockReset().mockResolvedValue([]);
  });

  it("format auto-descriptif : gen3ia.account-export v1, userId, caps exposées", async () => {
    const out = await exportAccountData("u1");
    expect(out.format).toBe("gen3ia.account-export");
    expect(out.version).toBe(1);
    expect(out.userId).toBe("u1");
    expect(out.caps).toEqual(ACCOUNT_EXPORT_CAPS);
    expect(out.exportedAt).toBeTruthy();
  });

  it("reconstitue conversations + messages chronologiques (order asc) et agents", async () => {
    mockListConversations.mockResolvedValue([
      { id: "c1", title: "Fil un", status: "active", createdAt: "2026-10-28T10:00:00Z", updatedAt: "2026-10-28T11:00:00Z" },
      { id: "c2", title: "Fil deux", status: "archived", createdAt: "2026-10-27T10:00:00Z", updatedAt: "2026-10-27T11:00:00Z", agentId: "a9" },
    ] as never);
    mockListMessages.mockImplementation(async (_uid, cid) =>
      cid === "c1"
        ? ([
            { id: "m1", role: "user", content: "Bonjour", createdAt: "2026-10-28T10:01:00Z" },
            { id: "m2", role: "assistant", content: "Bonjour !", createdAt: "2026-10-28T10:02:00Z" },
          ] as never)
        : [],
    );
    mockListAgents.mockResolvedValue([{ id: "a1", type: "screening-rh" }] as never);

    const out = await exportAccountData("u1");
    expect(out.conversations).toHaveLength(2);
    expect(out.conversations[0].messages).toHaveLength(2);
    expect(out.conversations[0].messages[0].contenu).toBe("Bonjour");
    expect(out.conversations[1].agentId).toBe("a9");
    expect(out.agents).toHaveLength(1);
    // Le manifest raconte la même histoire que les données.
    expect(out.manifest.conversations.count).toBe(2);
    expect(out.manifest.conversations.tronque).toBe(false);
    expect(out.manifest.agents.count).toBe(1);
    expect(out.manifest.memoire.count).toBe(1);
    // Chronologie ascendante exigée (fil lisible tel quel).
    expect(mockListMessages).toHaveBeenCalledWith("u1", "c1", ACCOUNT_EXPORT_CAPS.messagesParConversation, { order: "asc" });
  });

  it("caps honnêtes : dépassement ⇒ données tronquées ET manifest.tronque=true", async () => {
    const centCinquante = Array.from({ length: 150 }, (_, i) => ({ id: `a${i}`, type: "x" }));
    mockListAgents.mockResolvedValue(centCinquante as never);
    mockListConversations.mockResolvedValue(
      Array.from({ length: ACCOUNT_EXPORT_CAPS.conversations }, (_, i) => ({
        id: `c${i}`,
        title: `Fil ${i}`,
        status: "active",
        createdAt: "2026-10-28T10:00:00Z",
        updatedAt: "2026-10-28T11:00:00Z",
      })) as never,
    );
    const out = await exportAccountData("u1");
    expect(out.agents).toHaveLength(ACCOUNT_EXPORT_CAPS.agents); // tronqué à la cap
    expect(out.manifest.agents.tronque).toBe(true);
    expect(out.manifest.conversations.tronque).toBe(true); // 50/50 = au cap
  });

  it("fail-soft : une section en erreur n'invalide NI le manifest NI les autres", async () => {
    mockExportUserData.mockRejectedValue(new Error("R2 injoignable"));
    mockListConversations.mockResolvedValue([
      { id: "c1", title: "Fil un", status: "active", createdAt: "2026-10-28T10:00:00Z", updatedAt: "2026-10-28T11:00:00Z" },
    ] as never);
    const out = await exportAccountData("u1");
    expect(out.manifest.memoire.tronque).toBe(true);
    expect(out.manifest.memoire.erreur).toContain("R2 injoignable");
    expect(out.manifest.conversations.count).toBe(1);
    expect(out.conversations).toHaveLength(1);
    expect(out.agents).toEqual([]);
  });

  it("userId vide : refus immédiat — jamais d'export croisé", async () => {
    await expect(exportAccountData("")).rejects.toThrow("requires userId");
    await expect(exportAccountData("   ")).rejects.toThrow("requires userId");
  });
});

describe("Route /api/account/export", () => {
  const route = read("app/api/account/export/route.ts");

  it("garde authentifiée + rate limit dédié (5/heure, même école que memory-export)", () => {
    expect(route).toContain('key: "account-export"');
    expect(route).toContain("rateLimit: { limit: 5, windowMs: 60 * 60 * 1000 }");
    expect(route).toContain("protectRoute");
    expect(route).toContain("guard.context.userId");
  });

  it("pièce jointe horodatée, JSON explicite, jamais mise en cache", () => {
    expect(route).toContain('filename="gen3ia-compte-${stamp}.json"');
    expect(route).toContain('"cache-control": "no-store"');
    expect(route).toContain("application/json; charset=utf-8");
  });

  it("délègue à exportAccountData — aucune logique métier dupliquée", () => {
    expect(route).toContain("exportAccountData");
  });
});

describe("Section UI « Mes données » (settings)", () => {
  const section = read("components/settings/data-governance-section.tsx");

  it("les TROIS droits sont effectivement branchés sur leurs endpoints", () => {
    expect(section).toContain('"/api/account/export"');
    expect(section).toContain('"/api/memory/export"');
    expect(section).toContain('"/api/memory/purge"');
    // Appels authentifiés (authFetch) — pas de fetch nu sur les données perso.
    expect(section).toContain("authFetch");
  });

  it("effacement : double consentement (armement puis confirm: true)", () => {
    expect(section).toContain("purgeArmee");
    expect(section).toContain('JSON.stringify({ confirm: true })');
    expect(section).toContain("Confirmer l'effacement");
  });

  it("accessibilité : statut annoncé (role=status), boutons désactivés en cours", () => {
    expect(section).toContain('role="status"');
    expect(section).toContain("disabled={occuppe}");
  });
});

describe("Câblage settings + périmètre mémoire inchangé", () => {
  it("app/settings/page.tsx importe et rend DataGovernanceSection", () => {
    const page = read("app/settings/page.tsx");
    expect(page).toContain('import { DataGovernanceSection } from "@/components/settings/data-governance-section"');
    expect(page).toContain("<DataGovernanceSection />");
  });

  it("l'export mémoire historique reste INTACT (contrat Task 42 inchangé)", () => {
    const privacy = read("lib/memory/privacy.ts");
    expect(privacy).toContain('format: "gen3ia.memory-export"');
    const memoryRoute = read("app/api/memory/export/route.ts");
    expect(memoryRoute).toContain("gen3ia-memoire-");
  });
});
