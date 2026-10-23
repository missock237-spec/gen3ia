import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NextRequest } from "next/server";

/**
 * Feature flags Gen3ia (Task M) — lib/flags/feature-flags.ts.
 *
 * Contrat validé ici :
 *  1. PARSE : "1"/"true"/"on" (casse et espaces libres) → actif ;
 *     "0"/"false"/"off" → inactif (kill-switch) ; toute autre valeur →
 *     défaut du catalogue + UN SEUL warning (jamais d'interprétation
 *     silencieuse) ;
 *  2. DÉFAUT : variable absente ou vide → `defaut` du catalogue ;
 *  3. KILL-SWITCH RÉEL : /api/metrics (app/api/metrics/route.ts) est gated
 *     derrière GEN3IA_FLAG_SLI_ENDPOINT — défaut ACTIF (zéro rupture), la
 *     valeur 0 renvoie un 404 JSON propre ;
 *  4. listeFlags() : diagnostics complets reflétant l'env courant ;
 *  5. assertFlag : nom inconnu → erreur explicite FR (garde-fou runtime).
 */

import {
  assertFlag,
  CATALOGUE_FLAGS,
  estActive,
  listeFlags,
  nomVariableEnv,
  resoudreFlag,
} from "./feature-flags";

// Le route handler réel (branchement exemple du flag) — même philosophie
// que app/api/metrics/route.test.ts : on teste le code livré, pas un mock.
import { GET } from "@/app/api/metrics/route";

const VAR_SLI = "GEN3IA_FLAG_SLI_ENDPOINT";

function requete(): NextRequest {
  return new NextRequest("http://gen3ia.local/api/metrics", { method: "GET" });
}

beforeEach(() => {
  delete process.env[VAR_SLI];
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env[VAR_SLI];
  vi.restoreAllMocks();
});

describe("estActive — parse des valeurs d'environnement", () => {
  it("active le flag pour 1 / true / on, insensible casse et espaces", () => {
    // SLI_ENDPOINT a défaut true — pour que le test soit discriminant sur le
    // PARSE (pas sur le défaut), on compare source: "env".
    for (const valeur of ["1", "true", "on", "TRUE", "On", " 1 ", "\ttrue\n"]) {
      process.env[VAR_SLI] = valeur;
      expect(resoudreFlag("SLI_ENDPOINT")).toEqual({
        actif: true,
        source: "env",
        valeurBrute: valeur.trim().toLowerCase(),
      });
    }
  });

  it("désactive le flag pour 0 / false / off (kill-switch explicite)", () => {
    for (const valeur of ["0", "false", "off", "FALSE", "Off", " 0 "]) {
      process.env[VAR_SLI] = valeur;
      expect(resoudreFlag("SLI_ENDPOINT")).toEqual({
        actif: false,
        source: "env",
        valeurBrute: valeur.trim().toLowerCase(),
      });
    }
  });

  it("retombe sur le défaut + UN SEUL warning pour une valeur non reconnue", () => {
    const warn = vi.mocked(console.warn);
    process.env[VAR_SLI] = "yes";
    const resolu = resoudreFlag("SLI_ENDPOINT");
    expect(resolu.actif).toBe(CATALOGUE_FLAGS.SLI_ENDPOINT.defaut);
    expect(resolu.source).toBe("defaut");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("GEN3IA_FLAG_SLI_ENDPOINT");
    expect(warn.mock.calls[0]?.[0]).toContain("yes");

    // Anti-spam : deuxième appel, aucun warning supplémentaire.
    resoudreFlag("SLI_ENDPOINT");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("une valeur vide est traitée comme ABSENTE (défaut, sans warning)", () => {
    process.env[VAR_SLI] = "   ";
    expect(resoudreFlag("SLI_ENDPOINT")).toEqual({
      actif: CATALOGUE_FLAGS.SLI_ENDPOINT.defaut,
      source: "defaut",
      valeurBrute: null,
    });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("estActive — défauts du catalogue", () => {
  it("variable ABSENTE → defaut du catalogue (SLI_ENDPOINT = true)", () => {
    delete process.env[VAR_SLI];
    expect(estActive("SLI_ENDPOINT")).toBe(true);
    expect(resoudreFlag("SLI_ENDPOINT").source).toBe("defaut");
  });

  it("le kill-switch prime sur le défaut : 0 désactive un flag à défaut true", () => {
    process.env[VAR_SLI] = "0";
    expect(estActive("SLI_ENDPOINT")).toBe(false);
  });

  it("nomVariableEnv construit GEN3IA_FLAG_<NOM>", () => {
    expect(nomVariableEnv("SLI_ENDPOINT")).toBe("GEN3IA_FLAG_SLI_ENDPOINT");
  });
});

describe("kill-switch RÉEL — GET /api/metrics derrière GEN3IA_FLAG_SLI_ENDPOINT", () => {
  it("sans la variable (défaut actif) : 200 texte Prometheus — zéro rupture", async () => {
    delete process.env[VAR_SLI];
    const response = await GET(requete());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("avec GEN3IA_FLAG_SLI_ENDPOINT=1 : 200 (activation explicite)", async () => {
    process.env[VAR_SLI] = "1";
    const response = await GET(requete());
    expect(response.status).toBe(200);
  });

  it("avec GEN3IA_FLAG_SLI_ENDPOINT=0 : 404 JSON propre (scraping coupé)", async () => {
    process.env[VAR_SLI] = "0";
    const response = await GET(requete());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const corps = (await response.json()) as { success: boolean; error: string };
    expect(corps.success).toBe(false);
    expect(corps.error).toContain("GEN3IA_FLAG_SLI_ENDPOINT");
  });

  it("avec une valeur non reconnue : défaut appliqué (200), pas de 404", async () => {
    process.env[VAR_SLI] = "peut-être";
    const response = await GET(requete());
    expect(response.status).toBe(200);
  });
});

describe("listeFlags — diagnostics", () => {
  it("liste chaque flag du catalogue avec sa définition complète", () => {
    const flags = listeFlags();
    const sli = flags.find((f) => f.nom === "SLI_ENDPOINT");
    expect(sli).toBeDefined();
    expect(sli?.variable).toBe("GEN3IA_FLAG_SLI_ENDPOINT");
    expect(sli?.defaut).toBe(true);
    expect(sli?.description.length).toBeGreaterThan(10);
    expect(sli?.depuis).toContain("Task M");
  });

  it("reflète l'état résolu de l'environnement courant", () => {
    expect(listeFlags().find((f) => f.nom === "SLI_ENDPOINT")?.source).toBe("defaut");
    process.env[VAR_SLI] = "off";
    const sli = listeFlags().find((f) => f.nom === "SLI_ENDPOINT");
    expect(sli?.actif).toBe(false);
    expect(sli?.source).toBe("env");
    expect(sli?.valeurBrute).toBe("off");
  });

  it("expose AUCUN secret (un flag n'est jamais une donnée sensible)", () => {
    for (const flag of listeFlags()) {
      // Heuristique : aucune valeur ne doit ressembler à un token long.
      expect((flag.valeurBrute ?? "").length).toBeLessThan(20);
    }
  });
});

describe("assertFlag — garde-fou runtime", () => {
  it("renvoie la définition d'un flag connu", () => {
    expect(assertFlag("SLI_ENDPOINT")).toBe(CATALOGUE_FLAGS.SLI_ENDPOINT);
  });

  it("lève une erreur FR explicite pour un nom inconnu (appel dynamique)", () => {
    expect(() => assertFlag("SLI_ENDPOINTS" as never)).toThrow(/Flag inconnu/);
    expect(() => assertFlag("sli_endpoint" as never)).toThrow(/CATALOGUE_FLAGS/);
  });
});
