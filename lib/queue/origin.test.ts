import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertSafeDestinationUrl, isAllowedJobHost, resolveJobOrigin } from "./origin";

/**
 * ORIGINE CANONIQUE DES PUBLICATIONS QSTASH (fix CodeQL js/request-forgery).
 *
 * Comportements verrouillés : l'origine des ticks est lue UNIQUEMENT dans
 * GEN3IA_APP_ORIGIN (jamais l'origine de la requête entrante, falsifiable),
 * https obligatoire hors dev local, allowlist d'hôtes stricte (extensible
 * uniquement par GEN3IA_ALLOWED_ORIGINS, elle-même validée), slash final
 * retiré, warn console une fois par processus — JAMAIS d'écriture Firestore.
 *
 * Gardes structurels (convention du dépôt, fs.readFileSync) : plus AUCUN
 * fichier des routes de queue / chat agent / files vidéo ne dérive une
 * destination de `request.nextUrl.origin` — le motif de repli historique
 * `process.env.GEN3IA_APP_ORIGIN?.trim() || request.nextUrl.origin` est
 * interdit dans ces sources.
 */

const CANONICAL = "https://gen3ia.online";

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  setEnv({ GEN3IA_APP_ORIGIN: undefined, GEN3IA_ALLOWED_ORIGINS: undefined });
  vi.restoreAllMocks();
});

describe("resolveJobOrigin — lecture env seule", () => {
  it("env absente → { ok:false, reason:'unset' } (jamais l'origine de la requête en repli)", () => {
    setEnv({ GEN3IA_APP_ORIGIN: undefined });
    expect(resolveJobOrigin()).toEqual({ ok: false, reason: "unset" });
  });

  it("env blanche → unset (les espaces sont ignorés)", () => {
    setEnv({ GEN3IA_APP_ORIGIN: "   " });
    expect(resolveJobOrigin()).toEqual({ ok: false, reason: "unset" });
  });

  it("origine canonique de production → ok, SANS slash final", () => {
    setEnv({ GEN3IA_APP_ORIGIN: "https://gen3ia.online/" });
    expect(resolveJobOrigin()).toEqual({ ok: true, origin: CANONICAL });
  });

  it("les hôtes www.gen3ia.online et gen3ia.vercel.app sont acceptés", () => {
    for (const origin of ["https://www.gen3ia.online", "https://gen3ia.vercel.app"]) {
      setEnv({ GEN3IA_APP_ORIGIN: origin });
      expect(resolveJobOrigin()).toEqual({ ok: true, origin });
    }
  });
});

describe("resolveJobOrigin — validation stricte", () => {
  it("hôte hors allowlist → { ok:false, reason:'invalid' }", () => {
    setEnv({ GEN3IA_APP_ORIGIN: "https://attacker.example.net" });
    const result = resolveJobOrigin();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid");
  });

  it("https exigé hors localhost : http://gen3ia.online est refusé", () => {
    setEnv({ GEN3IA_APP_ORIGIN: "http://gen3ia.online" });
    const result = resolveJobOrigin();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/https requis/);
  });

  it("http toléré pour le développement local (localhost, 127.0.0.1, [::1])", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      setEnv({ GEN3IA_APP_ORIGIN: origin });
      expect(resolveJobOrigin()).toEqual({ ok: true, origin });
    }
  });

  it("URL malformée → invalid avec détail", () => {
    setEnv({ GEN3IA_APP_ORIGIN: "pas une url" });
    const result = resolveJobOrigin();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid");
      expect(result.detail).toMatch(/URL invalide/);
    }
  });
});

describe("GEN3IA_ALLOWED_ORIGINS — extension contrôlée de l'allowlist", () => {
  it("une origine additionnelle VALIDÉE est acceptée par resolveJobOrigin", () => {
    setEnv({ GEN3IA_APP_ORIGIN: "https://staging.gen3ia.online", GEN3IA_ALLOWED_ORIGINS: "https://staging.gen3ia.online" });
    expect(resolveJobOrigin()).toEqual({ ok: true, origin: "https://staging.gen3ia.online" });
  });

  it("les entrées invalides de la liste sont ignorées : jamais d'élargissement accidentel", () => {
    setEnv({
      GEN3IA_APP_ORIGIN: "https://staging.gen3ia.online",
      GEN3IA_ALLOWED_ORIGINS: "garbage, ftp://x, https://staging.gen3ia.online",
    });
    expect(resolveJobOrigin()).toEqual({ ok: true, origin: "https://staging.gen3ia.online" });
    // Un hôte ABSENT de la liste (même https valide) reste refusé :
    setEnv({ GEN3IA_APP_ORIGIN: "https://attacker.example.net" });
    expect(resolveJobOrigin().ok).toBe(false);
  });

  it("la liste ne peut pas réintroduire le http non local", () => {
    setEnv({ GEN3IA_APP_ORIGIN: "http://gen3ia.online", GEN3IA_ALLOWED_ORIGINS: "http://gen3ia.online" });
    expect(resolveJobOrigin().ok).toBe(false);
  });
});

describe("isAllowedJobHost", () => {
  it("accepte les hôtes de production, locaux, insensible à la casse", () => {
    expect(isAllowedJobHost("gen3ia.online")).toBe(true);
    expect(isAllowedJobHost("GEN3IA.online")).toBe(true);
    expect(isAllowedJobHost("www.gen3ia.online")).toBe(true);
    expect(isAllowedJobHost("gen3ia.vercel.app")).toBe(true);
    expect(isAllowedJobHost("localhost")).toBe(true);
    expect(isAllowedJobHost("127.0.0.1")).toBe(true);
  });

  it("refuse hôte inconnu, sous-domaine arbitraire et chaîne vide", () => {
    expect(isAllowedJobHost("attacker.example.net")).toBe(false);
    expect(isAllowedJobHost("evil-gen3ia.online")).toBe(false);
    expect(isAllowedJobHost("api.gen3ia.online")).toBe(false);
    expect(isAllowedJobHost("")).toBe(false);
  });

  it("honore GEN3IA_ALLOWED_ORIGINS (lecture à l'appel)", () => {
    expect(isAllowedJobHost("staging.gen3ia.online")).toBe(false);
    setEnv({ GEN3IA_ALLOWED_ORIGINS: "https://staging.gen3ia.online" });
    expect(isAllowedJobHost("staging.gen3ia.online")).toBe(true);
  });
});

describe("assertSafeDestinationUrl — défense en profondeur", () => {
  it("accepte une destination https allowlistée (et http local)", () => {
    expect(() => assertSafeDestinationUrl(`${CANONICAL}/api/queue/mission-tick`)).not.toThrow();
    expect(() => assertSafeDestinationUrl("http://localhost:3000/api/video/worker/tick")).not.toThrow();
  });

  it("lève une Error FR sur http non local", () => {
    expect(() => assertSafeDestinationUrl("http://gen3ia.online/api/queue/mission-tick")).toThrow(/https requis/);
  });

  it("lève une Error FR sur hôte non autorisé", () => {
    expect(() => assertSafeDestinationUrl("https://attacker.example.net/exfil")).toThrow(/non autorisé/);
  });

  it("lève une Error FR sur URL malformée", () => {
    expect(() => assertSafeDestinationUrl("n'importe quoi")).toThrow(/Destination QStash invalide/);
  });
});

describe("télémétrie console — warn FR une fois par processus, jamais Firestore", () => {
  it("un même problème n'émet le warn qu'UNE seule fois (déduplication)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Valeur UNIQUE pour ce test : la déduplication est indexée par message.
    setEnv({ GEN3IA_APP_ORIGIN: "https://warn-once-probe.invalid.example" });
    resolveJobOrigin();
    resolveJobOrigin();
    resolveJobOrigin();
    const relevant = warnSpy.mock.calls.filter((call) => String(call[0]).includes("warn-once-probe"));
    expect(relevant).toHaveLength(1);
    expect(String(relevant[0]?.[0])).toMatch(/\[queue\/origin\]/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Gardes structurels (convention du dépôt) : AUCUN repli sur l'origine
// requête dans les sources qui publient des ticks.
// ────────────────────────────────────────────────────────────────────────────

describe("garde : aucune destination dérivée de la requête (fix CodeQL request-forgery)", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  /** Liste récursive des .ts d'un dossier (sources + tests — tout est garde). */
  function listTsFiles(relativeDir: string): string[] {
    const absolute = path.join(process.cwd(), relativeDir);
    return readdirSync(absolute, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => path.join(relativeDir, f));
  }

  const guardedSources: string[] = [
    ...listTsFiles("app/api/queue"),
    ...listTsFiles("app/api/agent/chat"),
    "app/api/networks/[id]/run/route.ts",
    "lib/video/production-queue.ts",
    "lib/video/render-queue.ts",
    "lib/queue/qstash.ts",
  ];

  it("aucun fichier gardé ne référence request.nextUrl.origin (grep source)", () => {
    for (const file of guardedSources) {
      const source = read(file);
      expect(source, `${file} ne doit plus dériver la destination de la requête`).not.toContain(
        "request.nextUrl.origin",
      );
    }
  });

  it("le motif de repli falsifiable `|| request.nextUrl.origin` est interdit (grep source)", () => {
    for (const file of guardedSources) {
      const source = read(file);
      expect(source, `${file} contient encore le repli sur l'origine requête`).not.toMatch(
        /\|\|\s*request\.nextUrl\.origin/,
      );
    }
  });

  it("les publishers résolvent l'origine canonique en interne (allowlist serveur)", () => {
    const qstash = read("lib/queue/qstash.ts");
    // Le publish haute positionne la défense en profondeur en première ligne.
    expect(qstash).toContain("assertSafeDestinationUrl(destinationUrl);");
    // Les deux publishers résolvent EN INTERNE (plus de paramètre origin).
    expect(qstash).toMatch(/publishMissionTick\(\s*runId: string/);
    expect(qstash).toMatch(/publishDispatchTick\(\s*options: \{ delaySeconds: number; slotEpoch: number \}/);
    expect(read("lib/queue/origin.ts")).toContain('process.env.GEN3IA_APP_ORIGIN?.trim()');
    expect(read("lib/video/render-queue.ts")).toContain("resolveJobOrigin()");
    expect(read("lib/video/production-queue.ts")).toContain("resolveJobOrigin()");
  });
});
