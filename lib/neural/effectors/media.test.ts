import { describe, expect, it } from "vitest";

import { EspaceFiltreResonant } from "../core/resonant-space";
import { SystemeExploitationOutils } from "./tool-os";
import { EffecteurGenerationAudio } from "./audio";
import { EffecteurGenerationVisuelle } from "./visual";
import { EffecteurGenerationVideo } from "./video";
import { InterfaceVocaleTelephonique } from "./voice-phone";

/**
 * EFFECTEURS MÉDIA & TÉLÉPHONIE — tests du gating honnête :
 *  - résonance < 0.80 → AUCUNE action ;
 *  - résonance 1.0 → action déclenchée avec le statut honnête
 *    MOTEUR_LOCAL_INDISPONIBLE (aucun moteur local n'est injecté : l'effecteur le déclare
 *    déconnecté en mode neuronal — aucune simulation de fichier/score) ;
 *  - les outils média sont bien enregistrés dans le Tool OS et retournent le
 *    même statut honnête en exécution directe.
 */

function monterCorps() {
  const espace = new EspaceFiltreResonant();
  const toolOs = new SystemeExploitationOutils(espace);
  const audio = new EffecteurGenerationAudio(espace, toolOs);
  const visuel = new EffecteurGenerationVisuelle(espace, toolOs);
  const video = new EffecteurGenerationVideo(espace, toolOs);
  const vocale = new InterfaceVocaleTelephonique(espace);
  return { espace, toolOs, audio, visuel, video, vocale };
}

describe("Effecteurs média — gating par résonance", () => {
  it("résonance 0.5 (un neurone sur deux) : aucune action", () => {
    const { audio, visuel, video } = monterCorps();

    expect(audio.evaluerEtExecuter([42])).toEqual([]);
    expect(visuel.evaluerEtExecuter([46])).toEqual([]);
    expect(video.evaluerEtExecuter([44])).toEqual([]);
  });

  it("aucun spike : aucune action", () => {
    const { audio, visuel, video, vocale } = monterCorps();

    expect(audio.evaluerEtExecuter([])).toEqual([]);
    expect(visuel.evaluerEtExecuter([])).toEqual([]);
    expect(video.evaluerEtExecuter([])).toEqual([]);
    expect(vocale.evaluerEtExecuter([])).toEqual([]);
  });

  it("audio : résonance 1.0 → action honnête MOTEUR_LOCAL_INDISPONIBLE", () => {
    const { espace, toolOs, audio } = monterCorps();

    const actions = audio.evaluerEtExecuter([42, 43], {
      prompt: "ambiance de forêt",
      duree_secondes: 7,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("GENERER_AUDIO");
    expect(actions[0].status).toBe("MOTEUR_LOCAL_INDISPONIBLE");
    // Le résultat interne déclare honnêtement l'absence du moteur de rendu.
    const resultat = actions[0]["resultat"] as Record<string, unknown>;
    expect(resultat["statut_rendu"]).toBe("MOTEUR_LOCAL_INDISPONIBLE");
    expect(resultat["prompt"]).toBe("ambiance de forêt");
    expect(resultat["duree"]).toBe(7);
    // Aucun fichier fabriqué, aucun score de fidélité inventé.
    expect(resultat["chemin_audio"]).toBeUndefined();
    expect(resultat["score_fidelite_acoustique"]).toBeUndefined();

    // L'exécution sandbox a réellement eu lieu (métriques d'usage réelles).
    const outil = toolOs.registreOutils.get("generer_signal_audio");
    expect(outil?.utilisations).toBe(1);
    expect(outil?.succesHistorique).toBe(1);
    // Le pool de sortie est bien enregistré dans l'espace résonant.
    expect(espace.outputPools.get("GENERER_AUDIO")).toEqual([42, 43]);
  });

  it("visuel : résonance 1.0 → action honnête MOTEUR_LOCAL_INDISPONIBLE", () => {
    const { espace, visuel } = monterCorps();

    const actions = visuel.evaluerEtExecuter([46, 47], {
      prompt: "montagne au crépuscule",
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("GENERER_IMAGE");
    expect(actions[0].status).toBe("MOTEUR_LOCAL_INDISPONIBLE");
    const resultat = actions[0]["resultat"] as Record<string, unknown>;
    expect(resultat["statut_rendu"]).toBe("MOTEUR_LOCAL_INDISPONIBLE");
    expect(resultat["prompt"]).toBe("montagne au crépuscule");
    expect(resultat["chemin_fichier"]).toBeUndefined();
    expect(espace.outputPools.get("GENERER_IMAGE")).toEqual([46, 47]);
  });

  it("vidéo : résonance 1.0 → action honnête MOTEUR_LOCAL_INDISPONIBLE", () => {
    const { video } = monterCorps();

    const actions = video.evaluerEtExecuter([44, 45], {
      prompt: "clip de lancement",
      duree_secondes: 12,
      fps: 30,
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("GENERER_VIDEO");
    expect(actions[0].status).toBe("MOTEUR_LOCAL_INDISPONIBLE");
    const resultat = actions[0]["resultat"] as Record<string, unknown>;
    expect(resultat["duree"]).toBe(12);
    expect(resultat["fps"]).toBe(30);
    expect(resultat["chemin_video"]).toBeUndefined();
  });

  it("exécution directe des outils média dans le sandbox : statut honnête", () => {
    const { toolOs } = monterCorps();

    const resultatAudio = toolOs.executerEnSandbox("generer_signal_audio", {
      prompt: "battements de cœur",
    });
    expect(resultatAudio[0].status).toBe("SUCCES");
    expect(
      (resultatAudio[0]["resultat"] as Record<string, unknown>)[
        "statut_rendu"
      ],
    ).toBe("MOTEUR_LOCAL_INDISPONIBLE");

    const resultatImage = toolOs.executerEnSandbox(
      "generer_image_visuelle",
      {},
    );
    expect(
      (resultatImage[0]["resultat"] as Record<string, unknown>)[
        "statut_rendu"
      ],
    ).toBe("MOTEUR_LOCAL_INDISPONIBLE");

    const resultatVideo = toolOs.executerEnSandbox("generer_sequence_video", {
      prompt: "voyage",
    });
    expect(
      (resultatVideo[0]["resultat"] as Record<string, unknown>)[
        "statut_rendu"
      ],
    ).toBe("MOTEUR_LOCAL_INDISPONIBLE");
  });
});

describe("Interface vocale & téléphonique — honnêteté stricte", () => {
  it("INITIALISER_APPEL : résonance 1.0 → MOTEUR_EXTERNE_DESACTIVE, jamais de faux numéro", () => {
    const { vocale } = monterCorps();

    const actions = vocale.evaluerEtExecuter([60, 61], {
      numero: "+33612345678",
    });

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("INITIALISER_APPEL");
    expect(actions[0].status).toBe("MOTEUR_EXTERNE_DESACTIVE");
    expect(actions[0].details).toContain("non connecté");
    // JAMAIS de numéro fictif « +237XXXXXXX » ni de faux appel établi.
    expect(JSON.stringify(actions)).not.toContain("+237");
    expect(JSON.stringify(actions)).not.toContain("XXXX");
  });

  it("ECOUTER_AUDIO : aucune transcription inventée (STT externe désactivé)", () => {
    const { vocale } = monterCorps();

    const actions = vocale.evaluerEtExecuter([62, 63]);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("ECOUTER_AUDIO");
    expect(actions[0].status).toBe("MOTEUR_EXTERNE_DESACTIVE");
    expect(JSON.stringify(actions)).not.toContain(
      "je souhaite des informations",
    );
    expect(JSON.stringify(actions)).not.toContain("confiance");
  });

  it("EMETTRE_REPONSE_VOCALE et TERMINER_APPEL : moteurs externes désactivés", () => {
    const { vocale } = monterCorps();

    const actions = vocale.evaluerEtExecuter([64, 65, 66, 67]);

    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe("EMETTRE_REPONSE_VOCALE");
    expect(actions[0].status).toBe("MOTEUR_EXTERNE_DESACTIVE");
    expect(actions[1].type).toBe("TERMINER_APPEL");
    expect(actions[1].status).toBe("MOTEUR_EXTERNE_DESACTIVE");
  });

  it("résonance partielle (0.5) : aucune action télécom", () => {
    const { vocale } = monterCorps();

    expect(vocale.evaluerEtExecuter([60])).toEqual([]);
    expect(vocale.evaluerEtExecuter([63, 65])).toEqual([]);
  });
});
