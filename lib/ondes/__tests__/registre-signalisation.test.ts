import { describe, expect, it } from "vitest";

import { RegistreSalles } from "@/lib/ondes/registre-signalisation";
import { bandePassanteEconomisee, formaterOctets } from "@/lib/ondes/types";

describe("registre des salles — signalisation P2P", () => {
  const horloge = { valeur: 1_000_000 };
  const fabrique = () =>
    new RegistreSalles({ maxSalles: 4, maxPairsParSalle: 3, maxFileParPair: 2, ttlPairMs: 10_000, maintenant: () => horloge.valeur });

  const message = (de: string, extra: Record<string, unknown> = {}) => ({
    de,
    type: "bonjour",
    ts: horloge.valeur,
    mid: `m-${de}-${Math.random().toString(36).slice(2, 7)}`,
    ...extra,
  });

  it("diffuse aux autres membres, jamais à l'émetteur", () => {
    const registre = fabrique();
    registre.rejoindre("salle", "a");
    registre.rejoindre("salle", "b");
    registre.rejoindre("salle", "c");

    const livraisons = registre.publier("salle", message("a"));
    expect(livraisons).toBe(2); // b et c
    expect(registre.drainer("salle", "a")).toHaveLength(0);
    expect(registre.drainer("salle", "b")).toHaveLength(1);
    expect(registre.drainer("salle", "c")).toHaveLength(1);
  });

  it("livre les messages ciblés au seul destinataire", () => {
    const registre = fabrique();
    registre.rejoindre("salle", "a");
    registre.rejoindre("salle", "b");
    registre.rejoindre("salle", "c");

    const livraisons = registre.publier("salle", message("a", { vers: "c", type: "offre" }));
    expect(livraisons).toBe(1);
    expect(registre.drainer("salle", "b")).toHaveLength(0);
    const recus = registre.drainer("salle", "c");
    expect(recus).toHaveLength(1);
    expect(recus[0].type).toBe("offre");
  });

  it("draine une fois : la file se vide après lecture", () => {
    const registre = fabrique();
    registre.rejoindre("salle", "a");
    registre.rejoindre("salle", "b");
    registre.publier("salle", message("a"));
    expect(registre.drainer("salle", "b")).toHaveLength(1);
    expect(registre.drainer("salle", "b")).toHaveLength(0);
  });

  it("purge les pairs silencieux (ttl) et les salles vides", () => {
    const registre = fabrique();
    registre.rejoindre("salle", "a");
    registre.rejoindre("salle", "b");
    expect(registre.nbPairs("salle")).toBe(2);

    horloge.valeur += 20_000; // au-delà du ttlPairMs
    registre.purger();
    expect(registre.nbPairs("salle")).toBe(0);
    expect(registre.nbSalles).toBe(0);
  });

  it("le drain et la publication rafraîchissent le signe de vie", () => {
    const registre = fabrique();
    registre.rejoindre("salle", "a");
    registre.rejoindre("salle", "b");

    horloge.valeur += 9_000;
    registre.toucher("salle", "a"); // a publie régulièrement
    horloge.valeur += 2_000; // b est désormais silencieux > 10 s
    registre.purger();
    expect(registre.nbPairs("salle")).toBe(1);
  });

  it("les files sont bornées (le plus ancien est abandonné)", () => {
    const registre = fabrique();
    registre.rejoindre("salle", "a");
    registre.rejoindre("salle", "b");
    for (let i = 0; i < 5; i++) {
      registre.publier("salle", message("a", { mid: `m${i}` }));
    }
    const recus = registre.drainer("salle", "b");
    expect(recus).toHaveLength(2); // maxFileParPair
    expect(recus[0].mid).toBe("m3"); // les deux plus récents
  });

  it("les capacités maximales sont respectées (pairs par salle)", () => {
    const registre = fabrique();
    expect(registre.rejoindre("salle", "a")).toBe(true);
    expect(registre.rejoindre("salle", "b")).toBe(true);
    expect(registre.rejoindre("salle", "c")).toBe(true);
    expect(registre.rejoindre("salle", "d")).toBe(false); // maxPairsParSalle = 3
  });

  it("quitter retire le pair, la salle vide disparaît", () => {
    const registre = fabrique();
    registre.rejoindre("salle", "a");
    registre.rejoindre("salle", "b");
    registre.quitter("salle", "b");
    expect(registre.nbPairs("salle")).toBe(1);
    registre.quitter("salle", "a");
    expect(registre.nbSalles).toBe(0);
  });

  it("publier dans une salle inexistante ne livre rien", () => {
    const registre = fabrique();
    expect(registre.publier("fantome", message("a"))).toBe(0);
    expect(registre.drainer("fantome", "a")).toEqual([]);
  });
});

describe("métriques d'essaim — bande passante économisée", () => {
  it("compare les micro-paquets à des tranches de tenseurs de 64 Ko", () => {
    const economie = bandePassanteEconomisee({
      pairs: 2,
      paquetsEnvoyes: 10,
      paquetsRecus: 10,
      octetsEnvoyes: 400,
      octetsRecus: 400,
    });
    // 20 paquets × 65 536 octets hypothétiques − 800 octets réels.
    expect(economie).toBe(20 * 65_536 - 800);
  });

  it("jamais négative, formatage lisible", () => {
    expect(bandePassanteEconomisee({ pairs: 0, paquetsEnvoyes: 0, paquetsRecus: 0, octetsEnvoyes: 999, octetsRecus: 999 })).toBe(0);
    expect(formaterOctets(500)).toBe("500 o");
    expect(formaterOctets(2048)).toBe("2.0 Ko");
    expect(formaterOctets(3 * 1024 * 1024)).toBe("3.0 Mo");
  });
});
