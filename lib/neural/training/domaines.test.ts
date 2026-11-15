import { describe, it, expect } from "vitest";

import {
  DOMAINES_GEN3,
  DOMAIN_POOLS,
  LABEL_PAR_ID,
  DOMAINE_PAR_LABEL,
  predireDomaineLexical,
  texteEntrainement,
  construireSignaturesDomaines,
  chargerEchantillonsDomaines,
  construirePairesDomaines,
  lireDatasetDomaine,
  statsDatasets,
  MAX_PAIRES_CORTEX_DOMAINES,
} from "./domaines";
import { ZONE_DOMAINES, TAILLE_RESEAU_GEN3 } from "../core/types";

/**
 * LES 18 DOMAINES DE GEN3 — tests de la couche d'expertise :
 *  - définition complète (18 domaines, pools disjoints dans la couche
 *    100-135, labels cohérents) ;
 *  - détection lexicale (primaire, pattern labelText) ;
 *  - chargement des échantillons réels (datasets commis du dépôt) ;
 *  - signatures / ancres (cap anti-saturation du hachage).
 */
describe("Les 18 domaines de gen3", () => {
  it("18 domaines définis, ids uniques, pools disjoints dans la couche 100-135", () => {
    expect(DOMAINES_GEN3).toHaveLength(18);

    const ids = DOMAINES_GEN3.map((d) => d.id);
    expect(new Set(ids).size).toBe(18);

    const tousNeurones: number[] = [];
    for (const [label, pool] of Object.entries(DOMAIN_POOLS)) {
      expect(pool).toHaveLength(2);
      for (const neurone of pool) {
        expect(neurone).toBeGreaterThanOrEqual(ZONE_DOMAINES.debut);
        expect(neurone).toBeLessThanOrEqual(ZONE_DOMAINES.fin);
        tousNeurones.push(neurone);
      }
      expect(label).toMatch(/^DOM_/);
    }
    // Pools disjoints : 18 × 2 = 36 neurones uniques (100-135).
    expect(new Set(tousNeurones).size).toBe(36);

    // Maps cohérentes.
    expect(Object.keys(LABEL_PAR_ID)).toHaveLength(18);
    expect(Object.keys(DOMAINE_PAR_LABEL)).toHaveLength(18);
    expect(TAILLE_RESEAU_GEN3).toBe(140);
  });

  it("predireDomaineLexical : détection correcte sur des prompts réels FR/EN", () => {
    const cas: Array<[string, string]> = [
      ["Génère une image de montagne enneigée", "DOM_GENERATION_IMAGES"],
      ["Create a photorealistic picture of a market", "DOM_GENERATION_IMAGES"],
      ["Prépare un storyboard de 30 secondes pour ma vidéo", "DOM_VIDEO"],
      ["Write a storyboard for my video clip", "DOM_VIDEO"],
      ["Génère un son d'ambiance pour dormir", "DOM_SON"],
      ["I need a voice-over audio for my podcast", "DOM_SON"],
      ["Écris le refrain d'un morceau à 110 bpm", "DOM_CLIPS_MUSICAUX"],
      ["Développe une page de contact en React", "DOM_DEVELOPPEMENT_WEB"],
      ["Établis un plan de test avec couverture", "DOM_TEST"],
      ["Rédige le plan de mon rapport annuel", "DOM_REDACTION_DOCUMENTS"],
      ["L'histoire des indépendances vue par la sociologie", "DOM_SCIENCES_HUMAINES"],
      ["Structure mon protocole de recherche scientifique", "DOM_RECHERCHE_SCIENTIFIQUE"],
      ["Réaction défensive : tentative de connexion suspecte détectée", "DOM_CYBERSECURITE"],
      ["Comment vérifier une information virale sur le web ?", "DOM_RECHERCHE_WEB"],
      ["Aligne l'OCR de mes factures scannées", "DOM_MULTIMODAL"],
      ["Méthode de résolution d'un challenge CTF", "DOM_HACKER"],
      ["Conçois un bras robotisé avec capteur", "DOM_CONSTRUCTION_MACHINES"],
      ["Le client dit que c'est trop cher : traite l'objection", "DOM_VENTE"],
      ["Explique l'hydratation en information médicale générale", "DOM_SANTE_MEDICAL"],
      ["Nettoie mon dataset et montre le graphique des ventes", "DOM_ANALYSE_DONNEES"],
      ["Recommande une priorité à mon client et structure le suivi", "DOM_CONSEILLER_COMMERCIAL"],
      ["Comment vas-tu aujourd'hui ?", null as unknown as string],
    ];
    for (const [prompt, attendu] of cas) {
      const detection = predireDomaineLexical(prompt);
      if (attendu === null) {
        expect(detection).toBeNull();
      } else {
        expect(detection).not.toBeNull();
        expect(detection!.label).toBe(attendu);
        expect(detection!.matched.length).toBeGreaterThan(0);
      }
    }
  });

  it("texteEntrainement : ne garde que les ancres, cap 6 tokens", () => {
    const ancres = new Set(["storyboard", "video", "montage", "rendu", "codec", "plan", "fps"]);
    const texte = texteEntrainement(
      "Prépare un storyboard de 30 s avec plan de montage, rendu codec h264 pour la video",
      ancres,
    );
    const tokens = texte.split(" ");
    expect(tokens.length).toBeLessThanOrEqual(6);
    for (const token of tokens) {
      expect(ancres.has(token)).toBe(true);
    }
    // Aucune ancre → texte vide (échantillon sauté honnêtement).
    expect(texteEntrainement("rien de pertinent ici", ancres)).toBe("");
  });

  it("chargerEchantillonsDomaines : les échantillons commis des 18 domaines se chargent", async () => {
    const chargement = await chargerEchantillonsDomaines({ maxParDomaine: 20 });
    expect(chargement.fichiersAbsents).toEqual([]);
    // 18 domaines × (≥ 6 mots-clés d'amorçage + ≤ 20 échantillons).
    expect(chargement.samples.length).toBeGreaterThanOrEqual(18 * 6);
    const domainesCouverts = Object.keys(chargement.parDomaine);
    expect(domainesCouverts).toHaveLength(18);
    // Toutes les langues réelles des datasets.
    expect(Object.keys(chargement.parLangue).sort()).toEqual(["en", "fr"]);
    // Tous les labels sont des labels de domaine.
    for (const sample of chargement.samples) {
      expect(sample.label).toMatch(/^DOM_/);
      expect(DOMAINE_PAR_LABEL[sample.label]).toBeDefined();
    }
  }, 30_000);

  it("construireSignaturesDomaines : ancres plafonnées (anti-saturation du hachage)", async () => {
    const signatures = await construireSignaturesDomaines({ maxParDomaine: 300 });
    expect(Object.keys(signatures.parLabel)).toHaveLength(18);
    for (const [label, ancres] of Object.entries(signatures.parLabel)) {
      expect(ancres.length).toBeGreaterThan(0);
      expect(ancres.length).toBeLessThanOrEqual(24);
      // Les mots-clés noyau sont toujours inclus.
      const id = label.replace(/^DOM_/, "").toLowerCase();
      const domaine = DOMAINES_GEN3.find((d) => d.id === id)!;
      for (const motCle of domaine.motsCles) {
        expect(ancres).toContain(motCle);
      }
    }
  }, 30_000);

  it("construirePairesDomaines : paires cortex plafonnées, thèmes tracés", async () => {
    const paires = await construirePairesDomaines();
    expect(paires.length).toBeGreaterThan(0);
    expect(paires.length).toBeLessThanOrEqual(MAX_PAIRES_CORTEX_DOMAINES);
    for (const paire of paires) {
      expect(paire.theme).toMatch(/^domaine:/);
      expect(paire.motif.length).toBeGreaterThan(0);
      expect(paire.reponse.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("statsDatasets : inventaire honnête des fichiers du dépôt", async () => {
    const stats = await statsDatasets();
    expect(stats).toHaveLength(18);
    for (const entree of stats) {
      expect(entree.echantillonsCommis).toBe(true);
      expect(entree.lignesDisponibles).toBeGreaterThan(0);
    }
  }, 30_000);

  it("lireDatasetDomaine : schéma du générateur respecté (bilingue, méta complètes)", async () => {
    const echantillons = await lireDatasetDomaine("video");
    expect(echantillons.length).toBeGreaterThan(0);
    const langues = new Set(echantillons.map((e) => e.language));
    expect(langues.has("fr")).toBe(true);
    expect(langues.has("en")).toBe(true);
    for (const echantillon of echantillons.slice(0, 10)) {
      expect(echantillon.metadata.bilingual_pair_id).toMatch(/^bp-video-/);
      expect(echantillon.metadata.dedup_hash).toMatch(/^sha1:/);
      expect(echantillon.metadata.quality_score).toBeGreaterThan(0.5);
      expect(echantillon.metadata.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  }, 30_000);
});
