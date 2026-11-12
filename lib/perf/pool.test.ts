import { afterAll, describe, expect, it } from "vitest";

/**
 * Pool HTTP sortant (Task 9-a) : agent keep-alive actif (undici présent dans
 * le dépôt), requêtes HTTP réelles sur un serveur local, et timeout propre
 * sur un serveur muet. Aucun appel réseau externe : tout reste sur la
 * boucle locale.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  agentSortantActif,
  fermerAgentSortantPourTests,
  requeteSortante,
} from "./pool";

const serveurs: http.Server[] = [];

afterAll(async () => {
  await Promise.all(serveurs.map((serveur) => new Promise<void>((resolve) => serveur.close(() => resolve()))));
  await fermerAgentSortantPourTests();
});

function demarrerServeur(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    const serveur = http.createServer(handler);
    serveurs.push(serveur);
    serveur.listen(0, "127.0.0.1", () => {
      const adresse = serveur.address() as AddressInfo;
      resolve(`http://127.0.0.1:${adresse.port}`);
    });
  });
}

describe("requeteSortante — pool keep-alive", () => {
  it("l'agent undici est actif (présent via package.json overrides)", async () => {
    await expect(agentSortantActif()).resolves.toBe(true);
  });

  it("exécute des requêtes HTTP réelles et renvoie un JSON lisible", async () => {
    const base = await demarrerServeur((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, chemin: req.url ?? "" }));
    });

    const reponse = await requeteSortante(`${base}/sonde`, { timeoutMs: 3_000 });
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toEqual({ ok: true, chemin: "/sonde" });

    // Deuxième appel : même origine → la connexion keep-alive est réutilisée
    // (aucun moyen d'observer le socket depuis le test ; on vérifie que la
    // réutilisation ne dégrade pas la réponse).
    const reponse2 = await requeteSortante(`${base}/sonde-2`, { timeoutMs: 3_000 });
    expect(reponse2.status).toBe(200);
    await expect(reponse2.json()).resolves.toEqual({ ok: true, chemin: "/sonde-2" });
  });

  it("impose un timeout propre : un serveur muet fait échouer la requête", async () => {
    // Serveur qui accepte la connexion mais ne répond JAMAIS.
    const base = await demarrerServeur(() => {
      /* volontairement muet — aucune res.end() */
    });

    const debut = Date.now();
    await expect(
      requeteSortante(`${base}/jamais`, { timeoutMs: 200 }),
    ).rejects.toThrow();
    const ecoule = Date.now() - debut;
    // Le délai est respecté (marge généreuse pour les CI lentes) : la
    // requête ne pend PAS jusqu'au timeout réseau système.
    expect(ecoule).toBeLessThan(5_000);
    expect(ecoule).toBeGreaterThanOrEqual(150);
  });

  it("respecte les options method/headers/body", async () => {
    const base = await demarrerServeur((req, res) => {
      let corps = "";
      req.on("data", (morceau: Buffer) => {
        corps += morceau.toString();
      });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ methode: req.method, corps, type: req.headers["content-type"] ?? null }));
      });
    });

    const reponse = await requeteSortante(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      timeoutMs: 3_000,
    });
    expect(reponse.status).toBe(200);
    await expect(reponse.json()).resolves.toEqual({
      methode: "POST",
      corps: '{"a":1}',
      type: "application/json",
    });
  });
});
