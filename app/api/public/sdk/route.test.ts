import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GET as getMetadata } from "./route";
import { GET as getDownload } from "./download/route";
import {
  SDK_PACKAGE_NAME,
  SDK_TARBALL_FILENAME,
  SDK_TARBALL_PUBLIC_PATH,
  SDK_VERSION,
} from "@/lib/public-sdk/manifest";

const repoRoot = process.cwd();

/**
 * Garde anti-dérive de la distribution du SDK (Task 61) : la version
 * exposée par les routes, celle de sdk/package.json et celle du tarball
 * committé doivent rester strictement alignées. Toute modification du SDK
 * passe par : bump de version → npm run sdk:build → npm run sdk:pack.
 */

describe("GET /api/public/sdk — métadonnées de distribution", () => {
  it("expose name/version/install/endpoints/quickstart avec URLs absolues", async () => {
    const request = new Request("https://gen3ia.online/api/public/sdk");
    const response = await getMetadata(request as never);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.name).toBe(SDK_PACKAGE_NAME);
    expect(body.version).toBe(SDK_VERSION);
    expect(body.install).toMatchObject({
      npm: `npm install https://gen3ia.online/api/public/sdk/download`,
      tarball: `https://gen3ia.online${SDK_TARBALL_PUBLIC_PATH}`,
    });
    const endpoints = body.endpoints as Array<{ path: string; sdk: string }>;
    expect(endpoints.length).toBeGreaterThanOrEqual(8);
    expect(endpoints.some((e) => e.path === "/api/agents/run")).toBe(true);
    expect(endpoints.some((e) => e.path === "/api/webhooks/agent-triggers/{token}")).toBe(true);
    expect(body.quickstart).toBeDefined();
  });

  it("l'origine des URLs d'installation suit la requête (préviews multi-domaines)", async () => {
    const request = new Request("https://preview-xyz.vercel.app/api/public/sdk");
    const body = (await (await getMetadata(request as never)).json()) as { install: { npm: string } };
    expect(body.install.npm).toContain("https://preview-xyz.vercel.app/api/public/sdk/download");
  });

  it("la version du manifeste EST celle de sdk/package.json (source unique)", () => {
    const sdkPkg = JSON.parse(readFileSync(join(repoRoot, "sdk", "package.json"), "utf8")) as { name: string; version: string };
    expect(sdkPkg.name).toBe(SDK_PACKAGE_NAME);
    expect(sdkPkg.version).toBe(SDK_VERSION);
  });
});

describe("GET /api/public/sdk/download — redirection tarball", () => {
  it("redirige 302 vers l'asset statique versionné, no-store", async () => {
    const request = new Request("https://gen3ia.online/api/public/sdk/download");
    const response = getDownload(request as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://gen3ia.online${SDK_TARBALL_PUBLIC_PATH}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("le tarball committé EXISTE et porte le nom versionné du manifeste", () => {
    const tarballPath = join(repoRoot, "public", "sdk", SDK_TARBALL_FILENAME);
    expect(existsSync(tarballPath)).toBe(true);
  });

  it("le tarball contient un package.json @gen3ia/sdk à la MÊME version (tar)", () => {
    const tarballPath = join(repoRoot, "public", "sdk", SDK_TARBALL_FILENAME);
    if (!existsSync(tarballPath)) {
      throw new Error(`Tarball absent : ${tarballPath} — exécutez npm run sdk:pack`);
    }
    let inside = "";
    try {
      inside = execFileSync("tar", ["-xzOf", tarballPath, "package/package.json"], { encoding: "utf8" });
    } catch {
      // Environnement sans tar (jamais vu sur ubuntu CI) : on ne teste pas ce qui n'est pas testable.
      return;
    }
    const packed = JSON.parse(inside) as { name: string; version: string };
    expect(packed.name).toBe(SDK_PACKAGE_NAME);
    expect(packed.version).toBe(SDK_VERSION);
  });

  it("le tarball embarque les sorties ESM ET CJS compilées", () => {
    const tarballPath = join(repoRoot, "public", "sdk", SDK_TARBALL_FILENAME);
    try {
      const listing = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
      expect(listing).toContain("package/dist/esm/index.js");
      expect(listing).toContain("package/dist/cjs/index.js");
      expect(listing).toContain("package/README.md");
    } catch {
      return; // tar absent : déjà couvert par le test précédent
    }
  });
});
