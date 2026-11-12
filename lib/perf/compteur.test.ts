import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Compteurs de performance par route (Task 9-a) : p50/p95 (rang le plus
 * proche), familles de statut, normalisation des identifiants de segments,
 * plafond de cardinalité. Registre réinitialisé entre chaque scénario.
 */

import {
  instantaneCompteursPerf,
  normaliserCheminRoute,
  noterRequetePerf,
  reinitialiserCompteursPourTests,
} from "./compteur";

beforeEach(() => {
  reinitialiserCompteursPourTests();
});

afterEach(() => {
  reinitialiserCompteursPourTests();
});

function ligne(route: string) {
  const lignes = instantaneCompteursPerf().filter((l) => l.route === route);
  expect(lignes, `une seule série pour ${route}`).toHaveLength(1);
  return lignes[0]!;
}

describe("comptage et percentiles", () => {
  it("calcule p50/p95 exacts sur un échantillon déterministe 1..100", () => {
    for (let i = 1; i <= 100; i += 1) {
      noterRequetePerf("/api/test/demo", i <= 97 ? 200 : 500, i);
    }

    const serie = ligne("/api/test/demo");
    expect(serie.total).toBe(100);
    expect(serie.parStatut).toEqual({ "2xx": 97, "5xx": 3 });
    // Rang le plus proche : ceil(0.5*100)=50e valeur triée = 50 ; ceil(0.95*100)=95e = 95.
    expect(serie.p50Ms).toBe(50);
    expect(serie.p95Ms).toBe(95);
    expect(serie.moyenneMs).toBe(50.5);
    expect(serie.echantillons).toBe(100);
  });

  it("p50 et p95 sur un petit échantillon (n=1 → p50=p95=valeur)", () => {
    noterRequetePerf("/api/test/unique", 200, 12);
    const serie = ligne("/api/test/unique");
    expect(serie.p50Ms).toBe(12);
    expect(serie.p95Ms).toBe(12);
    expect(serie.total).toBe(1);
  });

  it("borne les durées négatives/non finies à 0 sans casser la mesure", () => {
    noterRequetePerf("/api/test/borne", 200, -8);
    noterRequetePerf("/api/test/borne", 200, Number.NaN);
    noterRequetePerf("/api/test/borne", 200, 30);
    const serie = ligne("/api/test/borne");
    expect(serie.total).toBe(3);
    expect(serie.p50Ms).toBe(0);
    expect(serie.p95Ms).toBe(30);
    expect(serie.echantillons).toBe(3);
  });

  it("ring buffer : l'échantillon est plafonné à 500 (fenêtre récente)", () => {
    for (let i = 1; i <= 600; i += 1) {
      noterRequetePerf("/api/test/fenetre", 200, i);
    }
    const serie = ligne("/api/test/fenetre");
    expect(serie.total).toBe(600);
    expect(serie.echantillons).toBe(500);
    // Les 100 premières durées ont été évincées : fenêtre = 101..600.
    // Rang le plus proche : ceil(0.5*500)=250e → 350 ; ceil(0.95*500)=475e → 575.
    expect(serie.p50Ms).toBe(350);
    expect(serie.p95Ms).toBe(575);
  });
});

describe("normalisation des chemins", () => {
  it("replie les identifiants numériques, UUID et jetons longs en :id", () => {
    expect(normaliserCheminRoute("/api/teams/42/members")).toBe("/api/teams/:id/members");
    expect(
      normaliserCheminRoute("/api/teams/550e8400-e29b-41d4-a716-446655440000/members"),
    ).toBe("/api/teams/:id/members");
    expect(normaliserCheminRoute("/api/video/projects/a1b2c3d4e5f6a7b8/render")).toBe(
      "/api/video/projects/:id/render",
    );
    expect(normaliserCheminRoute("/api/workspace/tasks/TASK_abcd1234efgh5678/approve")).toBe(
      "/api/workspace/tasks/:id/approve",
    );
  });

  it("supprime query string et fragment (cardinalité arbitraire interdite)", () => {
    expect(normaliserCheminRoute("/api/health?verbose=1&x=2")).toBe("/api/health");
    expect(normaliserCheminRoute("/api/metrics#section")).toBe("/api/metrics");
  });

  it("laisse les segments littéraux courts et les noms de fichiers intacts", () => {
    expect(normaliserCheminRoute("/chat")).toBe("/chat");
    expect(normaliserCheminRoute("/api/health/infra")).toBe("/api/health/infra");
    expect(normaliserCheminRoute("/sw.js")).toBe("/sw.js");
    expect(normaliserCheminRoute("/_next/static/chunks/main.js")).toBe(
      "/_next/static/chunks/main.js",
    );
    expect(normaliserCheminRoute("")).toBe("/");
  });

  it("deux requêtes sur le même id replient vers la MÊME série (pas d'explosion)", () => {
    noterRequetePerf("/api/video/projects/aaaabbbbccccdddd/render", 200, 5);
    noterRequetePerf("/api/video/projects/1111222233334444/render", 200, 7);
    const lignes = instantaneCompteursPerf().filter(
      (l) => l.route === "/api/video/projects/:id/render",
    );
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.total).toBe(2);
  });
});

describe("plafond de cardinalité", () => {
  it("au-delà de 256 routes distinctes, les nouveaux chemins se fondent dans « autre »", () => {
    for (let i = 1; i <= 300; i += 1) {
      noterRequetePerf(`/api/test/route-${i}`, 200, 1);
    }
    const lignes = instantaneCompteursPerf();
    // 256 routes littérales + la série de repli « autre » — JAMAIS plus.
    expect(lignes).toHaveLength(257);
    const repli = lignes.find((l) => l.route === "autre");
    expect(repli).toBeDefined();
    expect(repli!.total).toBe(44); // routes 257..300

    // Une route déjà suivie avant le plafond reste suivie individuellement.
    expect(lignes.some((l) => l.route === "/api/test/route-1")).toBe(true);
    // Toute nouvelle route continue d'alimenter « autre ».
    noterRequetePerf("/api/test/route-301", 200, 2);
    expect(ligne("autre").total).toBe(45);
  });
});

describe("sortie déterministe", () => {
  it("trie les routes alphabétiquement (diffs et scrapers stables)", () => {
    noterRequetePerf("/api/zebra", 200, 1);
    noterRequetePerf("/api/alpha", 200, 1);
    noterRequetePerf("/chat", 200, 1);
    const routes = instantaneCompteursPerf().map((l) => l.route);
    expect(routes).toEqual([...routes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(routes[0]).toBe("/api/alpha");
  });
});
