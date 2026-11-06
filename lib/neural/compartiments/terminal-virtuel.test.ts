/**
 * GARDE COMPARTIMENT CODE (TERMINAL VIRTUEL) — le terminal intégré à Gen3
 * doit exécuter du code SANS JAMAIS toucher à l'hôte (sandbox vm : globaux
 * gelés, pas de require/process, timeout, sortie bornée) et répondre aux
 * commandes de consultation (memoire, sources, etat, historique).
 */
import { describe, expect, it } from "vitest";

import { resoudreProbleme } from "./moteur-math";
import { CompartimentMondeGen3 } from "./monde-virtuel";
import { CAPACITE_HISTORIQUE_TERMINAL, TerminalVirtuelGen3 } from "./terminal-virtuel";

const memoireFactice = {
  etatCompartiment: (domaine: string, capacite: string) => ({
    cle: `${domaine}|${capacite}`,
    quotaOctets: 1_000_000_000,
    octetsPhysiques: 12_500_000,
    octetsReels: 8_000_000,
    octetsGraine: 3_000_000,
    octetsInges: 1_500_000,
    expansionDeterministe: true,
    unitesAdressables: 4321,
    tauxCouverturePhysique: 0.0125,
    ecartRestantOctets: 987_500_000,
  }),
  sourcesDomaine: (domaine: string) =>
    domaine === "math"
      ? [{ nom: "coco2017", plateforme: "hf", reference: "coco-2017", statut: "acquise", emplacement: `public/multimodal-it101/ (${domaine})` }]
      : [],
  statistiques: () => ({ compartiments: 133, octetsReels: 300_000_000, octetsInges: 5_000, enseignements: 12 }),
};

function terminalNeuf() {
  return new TerminalVirtuelGen3({
    math: { resoudreProbleme },
    monde: new CompartimentMondeGen3(),
    memoireDomaines: memoireFactice,
  });
}

describe("compartiment code — exécution sandbox", () => {
  it("calc une expression avec priorités et familles", () => {
    const t = terminalNeuf();
    const r = t.executerCommande("calc 17*23");
    expect(r.exitCode).toBe(0);
    expect(r.sortie).toContain("391");
    const pct = t.executerCommande("calc 15 % de 240");
    expect(pct.exitCode).toBe(0);
    expect(pct.sortie).toContain("36");
    expect(t.executerCommande("calc").exitCode).toBe(1);
  });

  it("js exécute du code JavaScript pur et renvoie la valeur", () => {
    const t = terminalNeuf();
    const r = t.executerCommande("js 2**10");
    expect(r.exitCode).toBe(0);
    expect(r.sortie).toBe("1024");
    expect(t.executerCommande("js Math.sqrt(144)").sortie).toBe("12");
    const multi = t.executerCommande("js (() => { let s = 0; for (let i = 1; i <= 10; i++) s += i; return s; })()");
    expect(multi.sortie).toBe("55");
  });

  it("js capture console.log et borne la sortie", () => {
    const t = terminalNeuf();
    const r = t.executerCommande("js (() => { console.log('salut'); console.log({a: 1}); return 7; })()");
    expect(r.exitCode).toBe(0);
    expect(r.sortie).toContain("salut");
    expect(r.sortie).toContain("7");
  });

  it("js NE PEUT PAS atteindre l'hôte (process, require, globalThis env)", () => {
    const t = terminalNeuf();
    const proc = t.executerCommande("js process.exit(1)");
    expect(proc.exitCode).toBe(1);
    const req = t.executerCommande("js require('node:fs')");
    expect(req.exitCode).toBe(1);
    const g = t.executerCommande("js globalThis");
    // Le contexte est neuf : globalThis du sandbox n'expose ni process ni require
    expect(g.sortie).not.toContain("process");
    expect(g.sortie).not.toContain("require");
  });

  it("js tue une boucle infinie (timeout vm)", () => {
    const t = terminalNeuf();
    const debut = Date.now();
    const r = t.executerCommande("js while(true) {}");
    const duree = Date.now() - debut;
    expect(r.exitCode).toBe(1);
    expect(r.sortie.toLowerCase()).toMatch(/timed out|timeout|interrompu/);
    expect(duree).toBeLessThan(5000); // pas un blocage du processus
  });
});

describe("compartiment code — commandes de consultation", () => {
  it("memoire rend la comptabilité 1 Go du compartiment demandé", () => {
    const t = terminalNeuf();
    const r = t.executerCommande("memoire math texte");
    expect(r.exitCode).toBe(0);
    expect(r.sortie).toContain("math|texte");
    expect(r.sortie).toContain("Go");
    expect(t.executerCommande("memoire").exitCode).toBe(1);
  });

  it("sources rend le registre HF/Kaggle du domaine", () => {
    const t = terminalNeuf();
    const r = t.executerCommande("sources math");
    expect(r.exitCode).toBe(0);
    expect(r.sortie).toContain("coco2017");
    expect(t.executerCommande("sources domaine-inexistant").exitCode).toBe(1);
  });

  it("etat et historique rendent un état lisible", () => {
    const t = terminalNeuf();
    t.executerCommande("calc 1+1");
    t.executerCommande("aide");
    const etat = t.executerCommande("etat");
    expect(etat.sortie).toContain("133");
    const hist = t.executerCommande("historique");
    expect(hist.sortie).toContain("calc 1+1");
    expect(t.executerCommande("historique-vider").exitCode).toBe(0);
    expect(t.executerCommande("historique").sortie).toContain("vide");
  });

  it("monde simule depuis le terminal", () => {
    const t = terminalNeuf();
    const r = t.executerCommande("monde projectile lancé à 20 m/s avec un angle de 45 degrés");
    expect(r.exitCode).toBe(0);
    expect(r.sortie).toContain("Compartiment sciences");
  });

  it("commande inconnue → exit 127, aide lisible, commande vide guidée", () => {
    const t = terminalNeuf();
    expect(t.executerCommande("rm -rf /").exitCode).toBe(127);
    expect(t.executerCommande("aide").sortie).toContain("compartiment code");
    expect(t.executerCommande("").sortie).toContain("aide");
  });
});

describe("compartiment code — historique borné et statistiques", () => {
  it("borne l'historique et compte les échecs honnêtement", () => {
    const t = terminalNeuf();
    for (let i = 0; i < CAPACITE_HISTORIQUE_TERMINAL + 20; i++) {
      t.executerCommande("calc 1+1");
    }
    expect(t.litHistorique().length).toBe(CAPACITE_HISTORIQUE_TERMINAL);
    const stats = t.statistiques();
    expect(stats.commandes).toBe(CAPACITE_HISTORIQUE_TERMINAL);
    expect(stats.parCommande["calc"]).toBe(CAPACITE_HISTORIQUE_TERMINAL + 20);
    expect(stats.echecs).toBe(0);
  });

  it("fonctionne sans environnement câblé (échecs honnêtes, jamais de panne)", () => {
    const t = new TerminalVirtuelGen3();
    expect(t.executerCommande("memoire math").exitCode).toBe(1);
    expect(t.executerCommande("monde projectile 20 m/s 45 degres").exitCode).toBe(1);
    expect(t.executerCommande("calc 2+2").sortie).toContain("4");
  });
});
