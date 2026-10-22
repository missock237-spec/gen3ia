import { describe, expect, it } from "vitest";

import {
  creerReconnaissance,
  detecterSupportReconnaissance,
  extraireTranscriptFinal,
  messageErreurVoix,
  type ConstructeurReconnaissance,
  type ReconnaissanceLike,
} from "./use-voice-input";

/**
 * Tests de la brique de SAISIE VOCALE native (chat voix — envoi sans
 * prompt écrit). Le dépôt n'a PAS d'environnement jsdom (vitest
 * environment=node) : la machine à états du hook est donc testée via les
 * fonctions pures EXPORTÉES (détection de support, extraction du
 * transcript, mapping d'erreurs, branchement d'une instance) — le hook
 * lui-même est un fin wrapper navigateur sans logique propre.
 */

/** Instance factice de SpeechRecognition (enregistre les handlers posés). */
function fauxConstructeur(): {
  constructeur: ConstructeurReconnaissance;
  instances: ReconnaissanceLike[];
} {
  const instances: ReconnaissanceLike[] = [];
  class FausseReconnaissance implements ReconnaissanceLike {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 0;
    demarree = false;
    arrete = false;
    onresult: ReconnaissanceLike["onresult"] = null;
    onerror: ReconnaissanceLike["onerror"] = null;
    onend: ReconnaissanceLike["onend"] = null;
    start() {
      this.demarree = true;
    }
    stop() {
      this.arrete = true;
    }
    abort() {
      this.arrete = true;
    }
    constructor() {
      instances.push(this);
    }
  }
  return { constructeur: FausseReconnaissance as unknown as ConstructeurReconnaissance, instances };
}

describe("use-voice-input — logique pure (machine à états exportée)", () => {
  it("detecterSupportReconnaissance() = false hors navigateur (garde SSR honnête)", () => {
    expect(detecterSupportReconnaissance()).toBe(false);
  });

  it("messageErreurVoix : micro refusé → message honnête explicite", () => {
    expect(messageErreurVoix("not-allowed")).toContain("Microphone refusé");
    expect(messageErreurVoix("service-not-allowed")).toContain("Microphone refusé");
  });

  it("messageErreurVoix : no-speech / network / audio-capture → messages réutilisables", () => {
    expect(messageErreurVoix("no-speech")).toContain("Aucune voix détectée");
    expect(messageErreurVoix("network")).toContain("réseau");
    expect(messageErreurVoix("audio-capture")).toContain("microphone");
  });

  it("messageErreurVoix : annulation volontaire (aborted) = silencieuse ; inconnu = message générique", () => {
    expect(messageErreurVoix("aborted")).toBe("");
    expect(messageErreurVoix("code-inconnu")).toContain("problème");
  });

  it("extraireTranscriptFinal sépare le final de l'interim", () => {
    const extrait = extraireTranscriptFinal({
      resultIndex: 0,
      results: {
        length: 2,
        0: { isFinal: true, length: 1, 0: { transcript: "Bonjour la " } },
        1: { isFinal: false, length: 1, 0: { transcript: "maison" } },
      },
    });
    expect(extrait.final).toBe("Bonjour la");
    expect(extrait.interim).toBe("maison");
  });

  it("extraireTranscriptFinal : résultats vides → chaînes vides", () => {
    const extrait = extraireTranscriptFinal({ resultIndex: 0, results: { length: 0 } });
    expect(extrait.final).toBe("");
    expect(extrait.interim).toBe("");
  });

  it("creerReconnaissance : config fr-FR single-shot + branchement des callbacks", () => {
    const { constructeur, instances } = fauxConstructeur();
    const reconnaissance = creerReconnaissance(
      constructeur,
      { surTranscriptFinal: () => undefined, surInterim: () => undefined, surErreur: () => undefined, surFin: () => undefined },
    );
    expect(instances).toHaveLength(1);
    expect(reconnaissance.lang).toBe("fr-FR");
    expect(reconnaissance.continuous).toBe(false);
    expect(reconnaissance.interimResults).toBe(true);
    expect(typeof reconnaissance.onresult).toBe("function");
    expect(typeof reconnaissance.onerror).toBe("function");
    expect(typeof reconnaissance.onend).toBe("function");
  });

  it("creerReconnaissance : le onend délivre le transcript final accumulé", () => {
    const { constructeur } = fauxConstructeur();
    let recu = "";
    const reconnaissance = creerReconnaissance(
      constructeur,
      {
        surTranscriptFinal: () => undefined,
        surInterim: () => undefined,
        surErreur: () => undefined,
        surFin: (final) => {
          recu = final;
        },
      },
    );
    reconnaissance.onresult?.({
      resultIndex: 0,
      results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: " Envoie ce message " } } },
    });
    reconnaissance.onend?.();
    expect(recu).toBe("Envoie ce message");
  });

  it("creerReconnaissance : onerror traduit le code Web Speech en message humain", () => {
    const { constructeur } = fauxConstructeur();
    let erreur = "";
    const reconnaissance = creerReconnaissance(
      constructeur,
      {
        surTranscriptFinal: () => undefined,
        surInterim: () => undefined,
        surErreur: (message) => {
          erreur = message;
        },
        surFin: () => undefined,
      },
    );
    reconnaissance.onerror?.({ error: "not-allowed" });
    expect(erreur).toContain("Microphone refusé");
  });

  it("creerReconnaissance : erreur « aborted » silencieuse (annulation volontaire)", () => {
    const { constructeur } = fauxConstructeur();
    let erreur = "non-vide";
    const reconnaissance = creerReconnaissance(
      constructeur,
      {
        surTranscriptFinal: () => undefined,
        surInterim: () => undefined,
        surErreur: (message) => {
          erreur = message;
        },
        surFin: () => undefined,
      },
    );
    reconnaissance.onerror?.({ error: "aborted" });
    expect(erreur).toBe("non-vide"); // surErreur jamais appelé
  });
});
