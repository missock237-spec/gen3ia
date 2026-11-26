import { describe, expect, it } from "vitest";

import { listeIceServers, lireConfigIce } from "./ice-config";
import { NumeroteurEvenements, RecepteurEvenements } from "./event-ordering";
import { deciderAdaptation, parametresProfil, SurveillantQualite, type MetriquesFlux } from "./quality-adaptive";

/**
 * TESTS LOT 2 — transport temps réel définitif (partie validable en
 * sandbox : config ICE, ordre des événements, adaptation de qualité).
 * Les critères MATÉRIELS (2 appareils, réseaux réels, audio+vidéo
 * simultanés après coupure) restent NON VALIDÉS en sandbox — règle 12.
 */

describe("config ICE/STUN/TURN via environnement (aucun service inventé)", () => {
  it("sans variables : TURN absent, avertissement explicite, aucun faux serveur", () => {
    const c = lireConfigIce({});
    expect(c.turnPret).toBe(false);
    expect(c.turnUrls).toHaveLength(0);
    expect(c.avertissement).toContain("NAT symétrique");
    expect(listeIceServers({})).toHaveLength(0); // pas de STUN fantôme
  });

  it("TURN complet : urls + identifiants → serveur injecté dans RTCPeerConnection", () => {
    const env = {
      GEN3IA_LIVE_STUN_URL: "stun:stun1.local:3478,stun:stun2.local:3478",
      GEN3IA_LIVE_TURN_URL: "turn:turn.local:3478",
      GEN3IA_LIVE_TURN_USERNAME: "u-live",
      GEN3IA_LIVE_TURN_PASSWORD: "p-live",
    };
    const serveurs = listeIceServers(env);
    expect(serveurs).toHaveLength(3); // 2 STUN + 1 TURN
    expect(serveurs[2]).toMatchObject({ username: "u-live", credential: "p-live" });
    expect(lireConfigIce(env).turnPret).toBe(true);
  });

  it("TURN sans identifiants : refuse silencieusement et prévient (jamais de faux TURN)", () => {
    const c = lireConfigIce({ GEN3IA_LIVE_TURN_URL: "turn:turn.local:3478" });
    expect(c.turnPret).toBe(false);
    expect(listeIceServers({ GEN3IA_LIVE_TURN_URL: "turn:turn.local:3478" })).toHaveLength(0);
  });
});

describe("ordre des événements garanti (critère LOT 2)", () => {
  it("numérotation monotone par session, sessions indépendantes", () => {
    const n = new NumeroteurEvenements();
    expect(n.numeroter("s1", "a").sequence).toBe(1);
    expect(n.numeroter("s1", "b").sequence).toBe(2);
    expect(n.numeroter("s2", "a").sequence).toBe(1); // compteur séparé
    expect(n.dernier("s1")).toBe(2);
  });

  it("récepteur : en-ordre, doublon ignoré, trou détecté avec liste exacte des manquants", () => {
    const r = new RecepteurEvenements();
    expect(r.recevoir({ sequence: 1, sessionId: "s1", type: "a", horodatage: 1 }).etat).toBe("en-ordre");
    expect(r.recevoir({ sequence: 3, sessionId: "s1", type: "c", horodatage: 3 })).toMatchObject({
      etat: "trou-detected",
      manquants: [2],
    });
    expect(r.recevoir({ sequence: 2, sessionId: "s1", type: "b", horodatage: 2 }).etat).toBe("doublon"); // déjà accepté au rattrapage
    expect(r.recevoir({ sequence: 4, sessionId: "s1", type: "d", horodatage: 4 }).etat).toBe("en-ordre");
  });
});

describe("adaptation automatique de qualité (règles déterministes, seuils documentés)", () => {
  const metriques = (rttMs: number, pertePct: number): MetriquesFlux => ({ rttMs, pertePct });

  it("profils ECO/BALANCED/PERFORMANCE/MOBILE avec paramètres réels", () => {
    expect(parametresProfil("ECO")).toMatchObject({ bitrateVideoBps: 300_000, ips: 12 });
    expect(parametresProfil("MOBILE")).toMatchObject({ bitrateVideoBps: 500_000, echelleResolution: 0.5 });
    expect(parametresProfil("PERFORMANCE")).toMatchObject({ bitrateVideoBps: 2_500_000, ips: 30 });
  });

  it("survival au-delà de 800 ms RTT ou 15 % perte — plancher minimal", () => {
    const d = deciderAdaptation(metriques(900, 2));
    expect(d.niveau).toBe("survival");
    expect(d.parametres?.bitrateVideoBps).toBe(120_000);
    const d2 = deciderAdaptation(metriques(200, 18));
    expect(d2.niveau).toBe("survival");
  });

  it("réduction 50 % sur dégradation modérée ; stable dans le profil ; monte si réseau sain", () => {
    expect(deciderAdaptation(metriques(350, 3), "BALANCED").niveau).toBe("reduit");
    expect(deciderAdaptation(metriques(150, 2), "BALANCED").niveau).toBe("stable");
    expect(deciderAdaptation(metriques(50, 0.5), "BALANCED").niveau).toBe("monte");
  });

  it("surveillant : cycle réel via sonde injectée, application bornée aux changements", async () => {
    let i = 0;
    const sondes: MetriquesFlux[] = [metriques(900, 20), metriques(900, 20), metriques(150, 2), metriques(150, 2)];
    const appliques: string[] = [];
    const s = new SurveillantQualite(async () => sondes[Math.min(i++, sondes.length - 1)], "BALANCED");
    await s.cycle(async (d) => appliques.push(d.niveau));
    await s.cycle(async (d) => appliques.push(d.niveau));
    expect(appliques).toEqual(["survival"]); // même niveau → pas de ré-application
    const d3 = await s.cycle(async (d) => appliques.push(d.niveau));
    expect(d3.niveau).toBe("stable"); // réseau redevenu normal
  });
});
