import { describe, it, expect, afterAll } from "vitest";

import { getNeuralRuntime, resetBrain } from "./runtime";
import { DOMAINES_GEN3 } from "./training/domaines";

/**
 * MISSION ⑤ — INTERROGATOIRE COMPLET DE GEN3 PAR DOMAINE ENTRAÎNÉ.
 *
 * Un tour par domaine (les 18 pools, qui couvrent les 12 phases du
 * curriculum) : on vérifie HONNÊTEMENT que
 *   1. gen3 répond (contenu non vide, provider gen3-snn) ;
 *   2. le domaine est reconnu (detection lexicale primaire) ;
 *   3. la réponse est DÉTAILLÉE (longueur minimale réelle, pas un
 *      refus générique déguisé).
 *
 * Toute case rouge est une rectification à faire — jamais décorée.
 */

/** Question réaliste par domaine (mots-clés du domaine présents). */
const QUESTIONS: Record<string, string> = {
  DOM_GENERATION_IMAGES:
    "Donne-moi un prompt d'image photoréaliste : un atelier au coucher du soleil, style cinématographique.",
  DOM_VIDEO: "Prépare le storyboard de ma vidéo produit en trois plans avec les paramètres de rendu.",
  DOM_SON: "Crée une ambiance sonore avec une voix off claire pour la bande audio de mon clip.",
  DOM_CLIPS_MUSICAUX: "Compose un clip musical de 30 secondes, ambiance électro progressive.",
  DOM_DEVELOPPEMENT_WEB: "Code une page web responsive avec un formulaire de connexion en HTML et CSS.",
  DOM_TEST: "Écris un test unitaire pour une fonction de tri, avec cas limites.",
  DOM_REDACTION_DOCUMENTS: "Rédige un document professionnel : une lettre de mission claire et structurée.",
  DOM_SCIENCES_HUMAINES: "Explique la sociolinguistique et ses courants principaux à un étudiant.",
  DOM_RECHERCHE_SCIENTIFIQUE: "Résume la méthode scientifique pour une expérience de physique contrôlée.",
  DOM_CYBERSECURITE: "Comment sécuriser un serveur contre les attaques par force brute ?",
  DOM_RECHERCHE_WEB: "Fais une recherche web sur les dernières avancées de l'IA générative.",
  DOM_MULTIMODAL: "Analyse multimodale : combine l'image, le son et le texte de ma vidéo d'atelier.",
  DOM_HACKER: "En pentest éthique, comment un hacker éthique cartographie-t-il un réseau autorisé ?",
  DOM_CONSTRUCTION_MACHINES: "Conçois la construction d'une machine simple : un bras robotique à 3 axes.",
  DOM_VENTE: "Rédige un argumentaire de vente pour mon produit, cible PME.",
  DOM_SANTE_MEDICAL: "Quelles mesures de prévention santé médicale contre la grippe saisonnière ?",
  DOM_ANALYSE_DONNEES: "Analyse mes données de vente mensuelles et propose un tableau de bord.",
  DOM_CONSEILLER_COMMERCIAL: "En tant que conseiller commercial, recommande une offre adaptée à ce client.",
};

interface RawDomaine {
  domaine?: { label: string; nom: string; score: number; source: string };
}

describe("MISSION ⑤ — gen3 interrogé dans chaque domaine entraîné", () => {
  for (const label of Object.keys(QUESTIONS)) {
    it(`${label} : détection + réponse détaillée`, async () => {
      const runtime = getNeuralRuntime();
      const reponse = await runtime.engine.generate({
        task: "chat",
        messages: [{ role: "user", content: QUESTIONS[label] }],
      });

      // 1. gen3 répond (AIResponse expose le texte dans `text`).
      expect(reponse.provider).toBe("gen3-snn");
      const contenu = (reponse.text ?? "").trim();
      expect(contenu.length).toBeGreaterThan(0);

      // 2. Le domaine est reconnu (le bon pool, pas un autre).
      const raw = reponse.raw as RawDomaine;
      expect(raw.domaine, `domaine non détecté pour ${label}`).toBeDefined();
      expect(raw.domaine!.label).toBe(label);

      // 3. Détail : la réponse n'est ni vide ni une esquive d'une ligne,
      //    ni une réponse HORS SUJET (pas de routage aléatoire d'action).
      expect(contenu.length, `réponse trop courte pour ${label} : « ${contenu} »`).toBeGreaterThan(60);
      expect(contenu, `hors sujet pour ${label} : « ${contenu} »`).not.toMatch(/Tool OS n'a rien exécuté/);
    });
  }

  it("les 18 domaines sont couverts par l'interrogatoire", () => {
    expect(Object.keys(QUESTIONS)).toHaveLength(DOMAINES_GEN3.length);
  });

  afterAll(() => {
    resetBrain();
  });
});
