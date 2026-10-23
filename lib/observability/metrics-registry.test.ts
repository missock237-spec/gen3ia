import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * REGISTRE DE MÉTRIQUES SLI (Task G — SRE) — contrats éprouvés :
 *  - incrément des compteurs par classe de route × famille de statut ;
 *  - classification à CARDINALITÉ BORNÉE (jamais le chemin brut) ;
 *  - ring buffer 500 : éviction FIFO + moyenne glissante sur la fenêtre ;
 *  - format texte Prometheus (préfixe gen3ia_, HELP/TYPE, sortie déterministe) ;
 *  - singleton globalThis : survit à un rechargement du module (hot-reload).
 */

import {
  classerChemin,
  classeStatut,
  enregistrerRequete,
  formaterPrometheus,
  instantane,
  type ClasseRoute,
} from "./metrics-registry";

/** Clé du singleton (dupliquée volontairement pour le nettoyage des tests). */
const CLE_GLOBALE = "__gen3iaMetricsRegistry__";

/** Remise à zéro : suppression du singleton globalThis (état frais par test). */
function reinitialiserRegistre(): void {
  delete (globalThis as unknown as Record<string, unknown>)[CLE_GLOBALE];
}

beforeEach(() => {
  reinitialiserRegistre();
});

describe("classerChemin — cardinalité strictement bornée", () => {
  it("classe les fichiers statiques servis depuis /public et /_next", () => {
    expect(classerChemin("/_next/static/chunks/main-abc123.js")).toBe("static");
    expect(classerChemin("/icons/icon-512.png")).toBe("static");
    expect(classerChemin("/version.json")).toBe("static");
    expect(classerChemin("/sw.js")).toBe("static");
    expect(classerChemin("/robots.txt")).toBe("static");
  });

  it("classe la surface chat (page canonique + API d'agent)", () => {
    expect(classerChemin("/chat")).toBe("chat");
    expect(classerChemin("/api/agent/chat")).toBe("chat");
    expect(classerChemin("/api/agent/chat/approve")).toBe("chat");
  });

  it("classe le reste des API et des pages, SANS fuir le chemin brut", () => {
    expect(classerChemin("/api/agents/uid-agent-9812/run")).toBe("api");
    expect(classerChemin("/api/webhooks/chariow")).toBe("api");
    expect(classerChemin("/billing")).toBe("pages");
    expect(classerChemin("/dashboard")).toBe("pages");
  });

  it("ne produit JAMAIS d'autre libellé que les 4 classes (anti-cardinalité)", () => {
    const classesAutorisees: ReadonlyArray<ClasseRoute> = ["chat", "api", "pages", "static"];
    // Chemins volontairement hostiles (ids uniques, injection, profondeur).
    const cheminsHostiles = [
      "/api/agents/req_8f3a9c2/run",
      "/api/knowledge/要素/深い/パス",
      "/chat/conversation-7f2b4a9c-1e3d-4f5a-b6c7-d8e9f0a1b2c3",
      "/preview/app-generée-8921",
      "/fichier/inconnu/xxxx?token=secret",
      "/ICONS/../secret",
    ];
    for (const chemin of cheminsHostiles) {
      expect(classesAutorisees).toContain(classerChemin(chemin));
    }
  });
});

describe("classeStatut — familles de statut bornées", () => {
  it("range chaque statut dans sa famille centaine", () => {
    expect(classeStatut(200)).toBe("2xx");
    expect(classeStatut(307)).toBe("3xx");
    expect(classeStatut(403)).toBe("4xx");
    expect(classeStatut(404)).toBe("4xx");
    expect(classeStatut(503)).toBe("5xx");
  });

  it("borne les statuts aberrants en 5xx (l'erreur reste une erreur)", () => {
    expect(classeStatut(0)).toBe("5xx");
    expect(classeStatut(600)).toBe("5xx");
    expect(classeStatut(-1)).toBe("5xx");
  });
});

describe("enregistrerRequete — compteurs par classe × famille de statut", () => {
  it("incrémente les bons compteurs et agrège par famille", () => {
    enregistrerRequete("chat", 200, 120);
    enregistrerRequete("chat", 200, 140);
    enregistrerRequete("chat", 403, 10);
    enregistrerRequete("api", 503, 900);
    enregistrerRequete("api", 503, 100);
    enregistrerRequete("pages", 307, 5);

    const photo = instantane();
    expect(photo.compteurs).toEqual([
      { route: "chat", statut: "2xx", total: 2 },
      { route: "chat", statut: "4xx", total: 1 },
      { route: "api", statut: "5xx", total: 2 },
      { route: "pages", statut: "3xx", total: 1 },
    ]);
  });

  it("omets les séries jamais observées (absence = 0 pour le scraper)", () => {
    enregistrerRequete("chat", 200, 100);
    const photo = instantane();
    expect(photo.compteurs).toHaveLength(1);
    expect(photo.compteurs[0]?.statut).toBe("2xx");
    expect(photo.compteurs[0]?.route).toBe("chat");
  });

  it("borne les durées aberrantes (négatives / non finies) à 0", () => {
    enregistrerRequete("api", 200, -50);
    enregistrerRequete("api", 200, Number.NaN);
    const photo = instantane();
    expect(photo.durees).toEqual([{ route: "api", moyenneMs: 0, echantillons: 2 }]);
  });
});

describe("ring buffer 500 — moyenne glissante", () => {
  it("évince FIFO au-delà de 500 et moyenne sur la fenêtre récente", () => {
    // 550 requêtes : 500 à 10 ms puis 50 à 1 000 ms → fenêtre = 450×10 + 50×1000.
    for (let i = 0; i < 500; i += 1) enregistrerRequete("chat", 200, 10);
    for (let i = 0; i < 50; i += 1) enregistrerRequete("chat", 200, 1000);

    const photo = instantane();
    expect(photo.durees).toHaveLength(1);
    expect(photo.durees[0]?.echantillons).toBe(500);
    expect(photo.durees[0]?.moyenneMs).toBe(109); // (450×10 + 50×1000) / 500
  });

  it("garde des buffers indépendants par classe de route", () => {
    enregistrerRequete("chat", 200, 200);
    enregistrerRequete("api", 200, 20);

    const photo = instantane();
    const chat = photo.durees.find((serie) => serie.route === "chat");
    const api = photo.durees.find((serie) => serie.route === "api");
    expect(chat?.moyenneMs).toBe(200);
    expect(api?.moyenneMs).toBe(20);
  });

  it("plafonne la mémoire : les échantillons ne dépassent jamais 500", () => {
    for (let i = 0; i < 5_000; i += 1) enregistrerRequete("pages", 200, 1);
    const photo = instantane();
    expect(photo.durees[0]?.echantillons).toBe(500);
  });
});

describe("formaterPrometheus — format texte Prometheus", () => {
  it("expose les séries avec le préfixe gen3ia_ et les lignes HELP/TYPE", () => {
    enregistrerRequete("chat", 200, 150);
    enregistrerRequete("api", 503, 40);

    const sortie = formaterPrometheus();

    expect(sortie).toContain("# HELP gen3ia_http_requests_total ");
    expect(sortie).toContain("# TYPE gen3ia_http_requests_total counter");
    expect(sortie).toContain('gen3ia_http_requests_total{route="chat",status="2xx"} 1');
    expect(sortie).toContain('gen3ia_http_requests_total{route="api",status="5xx"} 1');

    expect(sortie).toContain("# TYPE gen3ia_http_request_duration_ms gauge");
    expect(sortie).toContain('gen3ia_http_request_duration_ms{route="chat"} 150');

    expect(sortie).toContain("# TYPE gen3ia_http_request_duration_samples gauge");
    expect(sortie).toContain('gen3ia_http_request_duration_samples{route="chat"} 1');

    expect(sortie).toContain("# TYPE gen3ia_uptime_seconds gauge");
    expect(sortie).toMatch(/gen3ia_uptime_seconds \d/);
    expect(sortie).toContain("# TYPE gen3ia_memory_rss_bytes gauge");
    expect(sortie).toMatch(/gen3ia_memory_rss_bytes \d/);
    expect(sortie).toContain("# TYPE gen3ia_memory_heap_used_bytes gauge");
    expect(sortie).toMatch(/gen3ia_memory_heap_used_bytes \d/);

    // Format d'exposition : se termine par un saut de ligne.
    expect(sortie.endsWith("\n")).toBe(true);
  });

  it("ne contient JAMAIS de chemin brut (fuite de cardinalité interdite)", () => {
    enregistrerRequete("api", 200, 5);
    const sortie = formaterPrometheus();
    expect(sortie).not.toContain("/api/");
    expect(sortie).not.toContain("/chat/");
    expect(sortie).not.toContain("uid-");
  });

  it("produit une sortie DÉTERMINISTE (ordre fixe, diffs et tests stables)", () => {
    enregistrerRequete("pages", 200, 10);
    enregistrerRequete("chat", 200, 20);
    enregistrerRequete("chat", 403, 30);
    const premiere = formaterPrometheus();
    // Le compteur évolue entre les deux captures → on compare la structure
    // (lignes HELP/TYPE) et l'ordre des séries, pas la valeur de l'uptime.
    enregistrerRequete("chat", 403, 30);
    const seconde = formaterPrometheus();

    const lignesStructure = (sortie: string) => sortie.split("\n").filter((ligne) => ligne.startsWith("#"));
    expect(lignesStructure(seconde)).toEqual(lignesStructure(premiere));

    const lignes = seconde.split("\n").filter((ligne) => ligne.startsWith("gen3ia_http_requests_total"));
    expect(lignes).toEqual([
      'gen3ia_http_requests_total{route="chat",status="2xx"} 1',
      'gen3ia_http_requests_total{route="chat",status="4xx"} 2',
      'gen3ia_http_requests_total{route="pages",status="2xx"} 1',
    ]);
  });
});

describe("singleton globalThis — résiste au hot-reload du module", () => {
  it("conserve les compteurs à travers un rechargement du module (vi.resetModules)", async () => {
    enregistrerRequete("api", 200, 42);

    vi.resetModules();
    const moduleFrais = (await import("./metrics-registry")) as typeof import("./metrics-registry");

    // Le nouveau module voit l'état existant (même realm globalThis)…
    moduleFrais.enregistrerRequete("api", 200, 58);
    const photo = moduleFrais.instantane();
    expect(photo.compteurs).toEqual([{ route: "api", statut: "2xx", total: 2 }]);
    expect(photo.durees).toEqual([{ route: "api", moyenneMs: 50, echantillons: 2 }]);
  });

  it("démarre à neuf quand le singleton est explicitement supprimé (tests)", () => {
    enregistrerRequete("chat", 200, 10);
    reinitialiserRegistre();
    const photo = instantane();
    expect(photo.compteurs).toEqual([]);
    expect(photo.durees).toEqual([]);
  });
});
