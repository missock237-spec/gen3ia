import { describe, expect, it } from "vitest";

import { CONFIG_VAD_DEFAUT, Vad, wavSynthetique } from "./vad";
import { creerConversationVocale, type AdaptateurAsr, type AdaptateurTts, type CerveauVocal } from "./conversation-vocale";

/**
 * TESTS LOT 4 — vocal bidirectionnel interne (partie validable en sandbox).
 * WAV PCM16 mono RÉELS générés par wavSynthetique (sinusoïde/silence) :
 * hystérésis VAD, conversation complète avec adaptateurs injectés, barge-in,
 * repli texte explicite. Les adaptateurs Web Speech (navigateur) et la
 * conversation réelle micro→haut-parleur restent NON VALIDÉS en sandbox
 * (règle 12) — la logique d'orchestration, elle, est prouvée.
 */

describe("VAD : hystérésis réelle sur WAV PCM16 (début/fin de parole)", () => {
  it("claquement isolé ignoré (minParoleMs) ; parole continue → début ; silence continu → fin", () => {
    const vad = new Vad(CONFIG_VAD_DEFAUT); // minParole 180 ms, minSilence 700 ms, segment 120 ms
    expect(vad.traiter(wavSynthetique(120, 0.5)).evenement).toBeNull(); // 1 segment : pas encore 180 ms
    const r2 = vad.traiter(wavSynthetique(120, 0.5));
    expect(r2.evenement).toBe("parole.debut"); // 240 ms ≥ 180 ms
    // Silence court : hystérésis — toujours « encours » tant que < 700 ms.
    for (let i = 0; i < 5; i++) {
      expect(vad.traiter(wavSynthetique(120, 0.0001)).evenement).toBe("parole.encours");
    }
    expect(vad.traiter(wavSynthetique(120, 0.0001)).evenement).toBe("parole.fin"); // 720 ms ≥ 700 ms
    expect(vad.actif()).toBe(false);
  });

  it("silence pur ne déclenche rien ; RMS mesuré réel (classe du module multimodal)", () => {
    const vad = new Vad(CONFIG_VAD_DEFAUT);
    const r = vad.traiter(wavSynthetique(120, 0));
    expect(r.evenement).toBeNull();
    expect(r.rms).toBe(0);
    expect(r.classe).toBe("silence");
  });
});

describe("conversation vocale : cycle complet avec adaptateurs injectés (règle 11)", () => {
  const asrFaux: AdaptateurAsr = { nom: "asr-test", transcrire: async () => "regarde le problème sur mon écran" };
  const lecturesArretes: string[] = [];
  const ttsFaux: AdaptateurTts = {
    nom: "tts-test",
    lire: async (texte) => ({ lectureId: `lec-${texte.slice(0, 8)}` }),
    arreter: async (id) => { lecturesArretes.push(id); },
  };
  const cerveauFaux: CerveauVocal = {
    repondre: async (texte, contexte) =>
      contexte ? `J'ai vu le contexte (${contexte.slice(0, 20)}…) et compris : « ${texte} ».` : `Compris : « ${texte} ».`,
  };

  const configCourte = { ...CONFIG_VAD_DEFAUT, minSilenceMs: 480 };

  it("parole → transcription → cerveau → réponse parlée ; la conversation ne recharge rien", async () => {
    const conv = creerConversationVocale({ configVad: configCourte, asr: asrFaux, tts: ttsFaux, cerveau: cerveauFaux, contexteVisuel: () => "écran: fenêtre terminal, 12×32" });
    const ev0 = await conv.segment(wavSynthetique(120, 0.5)); // 120 ms : hystérésis, pas encore de début
    expect(ev0.some((e) => e.type === "vocal.debut")).toBe(false);
    const ev1 = await conv.segment(wavSynthetique(120, 0.5)); // 240 ms ≥ 180 ms → début
    expect(ev1.some((e) => e.type === "vocal.debut")).toBe(true);
    const ev2 = await conv.segment(wavSynthetique(120, 0.0001));
    const ev3 = await conv.segment(wavSynthetique(120, 0.0001));
    const ev4 = await conv.segment(wavSynthetique(120, 0.0001));
    const ev5 = await conv.segment(wavSynthetique(120, 0.0001));
    const tous = [...ev1, ...ev2, ...ev3, ...ev4, ...ev5];
    expect(tous.some((e) => e.type === "transcription" && e.texte === "regarde le problème sur mon écran")).toBe(true);
    const reponse = tous.find((e) => e.type === "reponse");
    expect(reponse?.texte).toContain("contexte");
    expect(tous.some((e) => e.etat === "parole")).toBe(true);
    expect(conv.etat()).toBe("parole"); // lecture en cours, écoute toujours active
    conv.fermer();
  });

  it("BARGE-IN : la parole de l'utilisateur pendant la réponse interrompt proprement", async () => {
    const conv = creerConversationVocale({ configVad: configCourte, asr: asrFaux, tts: ttsFaux, cerveau: cerveauFaux });
    await conv.segment(wavSynthetique(120, 0.5));
    await conv.segment(wavSynthetique(120, 0.5)); // début réel (240 ms)
    for (let i = 0; i < 4; i++) await conv.segment(wavSynthetique(120, 0.0001));
    expect(conv.etat()).toBe("parole");
    // L'utilisateur re-parle : 2 segments (240 ms ≥ hystérésis 180 ms) → interruption
    await conv.segment(wavSynthetique(120, 0.5));
    const ev = await conv.segment(wavSynthetique(120, 0.5));
    expect(ev.some((e) => e.type === "interruption")).toBe(true);
    expect(lecturesArretes).toHaveLength(1); // TTS stoppé
    expect(conv.etat()).toBe("ecoute"); // retour écoute immédiat
    conv.fermer();
  });

  it("REPLI explicite : sans ASR ni TTS → repli-texte, jamais de fausse voix", async () => {
    const conv = creerConversationVocale({ asr: null, tts: null, cerveau: cerveauFaux });
    expect(conv.etat()).toBe("repli-texte");
    const evs = await conv.messageTexte("ouvre le dossier projets");
    expect(evs.some((e) => e.type === "reponse")).toBe(true);
    expect(evs.some((e) => e.type === "vocal.repli-texte" && e.raison?.includes("aucun TTS branché"))).toBe(true);
    expect(conv.etat()).toBe("repli-texte");
    conv.fermer();
  });

  it("ASR branché mais TTS absent : réponse en texte avec raison ; erreur cerveau → écoute, pas de crash", async () => {
    const convTexte = creerConversationVocale({ configVad: configCourte, asr: asrFaux, tts: null, cerveau: cerveauFaux });
    await convTexte.segment(wavSynthetique(120, 0.5));
    await convTexte.segment(wavSynthetique(120, 0.5));
    let evs: Awaited<ReturnType<typeof convTexte.segment>> = [];
    for (let i = 0; i < 4; i++) evs = await convTexte.segment(wavSynthetique(120, 0.0001)); // 480 ms ≥ 480 → fin
    expect(evs.some((e) => e.type === "vocal.repli-texte")).toBe(true);
    convTexte.fermer();

    const cerveauCasse: CerveauVocal = { repondre: async () => { throw new Error("moteur indisponible"); } };
    const convCasse = creerConversationVocale({ configVad: configCourte, asr: asrFaux, tts: ttsFaux, cerveau: cerveauCasse });
    await convCasse.segment(wavSynthetique(120, 0.5));
    await convCasse.segment(wavSynthetique(120, 0.5));
    let evs2: Awaited<ReturnType<typeof convCasse.segment>> = [];
    for (let i = 0; i < 4; i++) evs2 = await convCasse.segment(wavSynthetique(120, 0.0001));
    expect(evs2.some((e) => e.type === "erreur" && e.raison?.includes("moteur indisponible"))).toBe(true);
    expect(convCasse.etat()).toBe("ecoute"); // conversation continuera (mission : gérer les erreurs)
    convCasse.fermer();
  });
});
