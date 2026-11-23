import { describe, expect, it, vi } from "vitest";

import {
  creerCycleVoixContinue,
  rearmementDemande,
  transitionVoixContinue,
  type EvenementVoixContinue,
  type OptionsVoixContinue,
} from "./use-voice-mode";

/**
 * MODE VOIX CONTINU — machine à états PURE + contrôleur PUR testés hors DOM
 * (vitest environment=node, convention du dépôt : la logique est testée,
 * le hook React est un fin wrapper). La fluidité et la synchronisation
 * sont VÉRIFIÉES : jamais d'écoute pendant la lecture, réarmement seulement
 * à la FIN réelle de la synthèse.
 */
describe("machine à états voix continue — le cycle fluide et synchronisé", () => {
  const activer = (supported = true): EvenementVoixContinue => ({ type: "ACTIVER", supported });

  it("activation supportée → silence (prêt à écouter) ; non supportée → message honnête", () => {
    expect(transitionVoixContinue({ etat: "inactif" }, activer(true)).etat).toBe("silence");
    const refuse = transitionVoixContinue({ etat: "inactif" }, activer(false));
    expect(refuse.etat).toBe("inactif");
    expect(refuse.messageErreur).toMatch(/non supportée/);
  });

  it("cycle complet : silence → écoute → attente → lecture → silence (réarmement)", () => {
    let etat = transitionVoixContinue({ etat: "inactif" }, activer());
    etat = transitionVoixContinue(etat, { type: "DEBUT_ECOUTE" });
    expect(etat.etat).toBe("ecoute");
    etat = transitionVoixContinue(etat, { type: "TRANSCRIPT_ENVOYE" });
    expect(etat.etat).toBe("attente-reponse");
    // Pendant l'attente et la lecture : PAS de réarmement (gen3 parle).
    expect(rearmementDemande(etat, { etat: "ecoute" })).toBe(false);
    etat = transitionVoixContinue(etat, { type: "REPONSE_RECU" });
    expect(etat.etat).toBe("lecture");
    etat = transitionVoixContinue(etat, { type: "LECTURE_TERMINEE" });
    expect(etat.etat).toBe("silence");
    // SEUL le retour au silence après lecture réarme le micro.
    expect(rearmementDemande(etat, { etat: "lecture" })).toBe(true);
  });

  it("le micro n'est JAMAIS armé pendant que gen3 parle (synchronisation)", () => {
    const attente = transitionVoixContinue({ etat: "ecoute" }, { type: "TRANSCRIPT_ENVOYE" });
    const lecture = transitionVoixContinue(attente, { type: "REPONSE_RECU" });
    expect(rearmementDemande(attente, { etat: "ecoute" })).toBe(false);
    expect(rearmementDemande(lecture, { etat: "attente-reponse" })).toBe(false);
    expect(rearmementDemande(lecture, { etat: "ecoute" })).toBe(false);
  });

  it("une erreur de micro/synthèse NE COUPE PAS le mode (retour au silence, message)", () => {
    const apresErreur = transitionVoixContinue({ etat: "lecture" }, { type: "ERREUR", message: "lecture ratée" });
    expect(apresErreur.etat).toBe("silence");
    expect(apresErreur.messageErreur).toBe("lecture ratée");
    // mais l'inactif reste inactif (désactivation = seul arrêt définitif)
    expect(transitionVoixContinue({ etat: "inactif" }, { type: "ERREUR" }).etat).toBe("inactif");
  });

  it("désactivation depuis n'importe quel état → inactif ; transitions illégales ignorées", () => {
    for (const depart of ["silence", "ecoute", "attente-reponse", "lecture", "erreur"] as const) {
      expect(transitionVoixContinue({ etat: depart }, { type: "DESACTIVER" }).etat).toBe("inactif");
    }
    expect(transitionVoixContinue({ etat: "inactif" }, { type: "DEBUT_ECOUTE" }).etat).toBe("inactif");
    expect(transitionVoixContinue({ etat: "silence" }, { type: "REPONSE_RECU" }).etat).toBe("silence");
    expect(transitionVoixContinue({ etat: "silence" }, { type: "LECTURE_TERMINEE" }).etat).toBe("silence");
  });
});

describe("contrôleur voix continue — le cycle réel avec fakes injectés", () => {
  interface Montage {
    cycle: ReturnType<typeof creerCycleVoixContinue>;
    ecouter: ReturnType<typeof vi.fn>;
    arreterEcoute: ReturnType<typeof vi.fn>;
    finLecture: () => void;
  }

  /** Contrôleur réel + « lecture » factice : la promesse est résolue
   *  manuellement par le test — comme un vrai callback de fin de synthèse. */
  function monter(surcharge: Partial<OptionsVoixContinue> = {}): Montage {
    let finir = () => {};
    const ecouter = vi.fn();
    const arreterEcoute = vi.fn();
    const cycle = creerCycleVoixContinue({
      supported: true,
      ecouter,
      arreterEcoute,
      lire: () => new Promise<void>((resoudre) => (finir = resoudre)),
      ...surcharge,
    });
    return { cycle, ecouter, arreterEcoute, finLecture: () => finir() };
  }

  it("activer → premier cycle armé au retour au silence ; désactiver → micro coupé", () => {
    const { cycle, ecouter, arreterEcoute } = monter();
    cycle.activer();
    expect(cycle.actif()).toBe(true);
    expect(cycle.etat().etat).toBe("silence");
    expect(ecouter).toHaveBeenCalledTimes(1); // le premier cycle démarre seul
    cycle.desactiver();
    expect(cycle.actif()).toBe(false);
    expect(cycle.etat().etat).toBe("inactif");
    expect(arreterEcoute).toHaveBeenCalled();
    expect(ecouter).toHaveBeenCalledTimes(1); // jamais re-armé après désactivation
  });

  it("activer sans support → refuse avec message honnête (pas de faux mode)", () => {
    const onErreur = vi.fn();
    const { cycle, ecouter } = monter({ supported: false, onErreur });
    cycle.activer();
    expect(cycle.actif()).toBe(true); // l'utilisateur a demandé — mais…
    expect(cycle.etat().etat).toBe("inactif"); // …la machine refuse le cycle
    expect(cycle.etat().messageErreur).toMatch(/non supportée/);
    expect(onErreur).toHaveBeenCalledWith(expect.stringMatching(/non supportée/));
    expect(ecouter).not.toHaveBeenCalled();
  });

  it("réarmement AUTOMATIQUE après la fin réelle de la lecture (mains libres)", async () => {
    const { cycle, ecouter, finLecture } = monter();
    cycle.activer();
    cycle.notifierDebutEcoute();
    cycle.notifierTranscriptEnvoye("bonjour gen3");
    expect(cycle.etat().etat).toBe("attente-reponse");
    cycle.notifierReponse("Bonjour ! Comment puis-je vous aider ?");
    expect(cycle.etat().etat).toBe("lecture"); // gen3 parle : pas d'écoute
    expect(ecouter).toHaveBeenCalledTimes(1); // seulement le premier cycle
    finLecture(); // la synthèse annonce sa fin RÉELLE
    await Promise.resolve(); // le .then de fin de lecture est un microtask
    await Promise.resolve();
    expect(cycle.etat().etat).toBe("silence");
    expect(ecouter).toHaveBeenCalledTimes(2); // le micro se réarme seul — fluidité
  });

  it("échec de lecture → retour à l'écoute (le cycle continue, message affiché)", async () => {
    const onErreur = vi.fn();
    const ecouter = vi.fn();
    const cycle = creerCycleVoixContinue({
      supported: true,
      ecouter,
      arreterEcoute: () => {},
      lire: () => Promise.reject(new Error("boom")),
      onErreur,
    });
    cycle.activer();
    cycle.notifierDebutEcoute();
    cycle.notifierTranscriptEnvoye("test");
    cycle.notifierReponse("réponse");
    await Promise.resolve(); // le .catch d'échec est un microtask
    await Promise.resolve();
    expect(cycle.etat().etat).toBe("silence"); // après l'échec : reprise d'écoute
    expect(onErreur).toHaveBeenCalledWith(expect.stringMatching(/échoué/));
    expect(ecouter).toHaveBeenCalledTimes(2);
  });

  it("le transcript envoyé est relayé (le tour part réellement vers gen3)", () => {
    const onTranscriptEnvoye = vi.fn();
    const { cycle } = monter({ onTranscriptEnvoye });
    cycle.activer();
    cycle.notifierDebutEcoute();
    cycle.notifierTranscriptEnvoye("quel temps fait-il ?");
    expect(onTranscriptEnvoye).toHaveBeenCalledWith("quel temps fait-il ?");
    expect(cycle.etat().etat).toBe("attente-reponse");
  });
});
