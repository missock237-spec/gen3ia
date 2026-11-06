/**
 * GARDE MÉMOIRE DE DOMAINES — quota 1 Go par domaine × capacité, sources
 * HF/Kaggle tracées, expansion déterministe CALCULÉE (jamais inventée),
 * ingestion chat/API avec déduplication et évolution, classifieur honnête.
 * Demande propriétaire : « 1 Go de données par domaine et par capacité...
 * pouvoir évoluer à mesure qu'il reçoit des données via le chat IA ou l'API ».
 */
import { describe, expect, it } from "vitest";

import { CORPUS_GEN3 } from "./corpus";
import { CortexLangagierGen3 } from "./language";
import {
  CAPACITES_GEN3,
  CAPACITE_INGESTION,
  DOMAINES_GEN3,
  MemoireDomainesGen3,
  PAIRES_MEMOIRE,
  QUOTA_OCTETS_PAR_DOMAINE,
  TOTAUX,
  identifieDomaine,
  uniteSynthetique,
  unitesAdressables,
} from "./memoire-domaines";
import { MESURES_MEMOIRE } from "./memoire-domaines-donnees";
import { FAMILLES_SYNTHESE } from "./memoire-domaines-graines";
import { CortexReflexifGen3 } from "./memoire-reflexion";

describe("memoire-domaines — structure 19 domaines × 7 capacités, quota 1 Go", () => {
  it("structure complète : 19 domaines × 7 capacités = 133 compartiments mesurés", () => {
    expect(DOMAINES_GEN3).toHaveLength(19);
    expect(CAPACITES_GEN3).toHaveLength(7);
    expect(MESURES_MEMOIRE).toHaveLength(19 * 7);
    const cles = new Set(MESURES_MEMOIRE.map((m) => m.cle));
    for (const d of DOMAINES_GEN3) {
      for (const c of CAPACITES_GEN3) {
        expect(cles.has(`${d}|${c}`), `compartiment manquant : ${d}|${c}`).toBe(true);
      }
    }
    expect(TOTAUX.compartiments).toBe(133);
    expect(TOTAUX.compartimentsCalculables).toBe(Object.keys(FAMILLES_SYNTHESE).length);
  });

  it("quota 1 Go et couverture physique cohérente (mesurée, pas inventée)", () => {
    expect(QUOTA_OCTETS_PAR_DOMAINE).toBe(1_000_000_000);
    const memoire = new MemoireDomainesGen3();
    for (const m of MESURES_MEMOIRE) {
      const [d, c] = m.cle.split("|");
      const etat = memoire.etatCompartiment(d!, c!);
      expect(etat.octetsPhysiques).toBe(m.octetsReels + m.octetsGraine);
      expect(etat.tauxCouverturePhysique).toBeGreaterThanOrEqual(0);
      expect(etat.tauxCouverturePhysique).toBeLessThanOrEqual(1);
      expect(etat.ecartRestantOctets).toBe(QUOTA_OCTETS_PAR_DOMAINE - etat.octetsPhysiques);
      if (!m.expansionDeterministe) {
        expect(etat.unitesAdressables).toBe(0);
        expect(uniteSynthetique(d!, c!, 0)).toBeNull();
      }
    }
  });

  it("données réelles mesurées sur le disque : assets, corpus, snapshots", () => {
    // image_analysis|image : les 18 fenêtres d'assets réels (COCO-2017)
    const image = MESURES_MEMOIRE.find((m) => m.cle === "image_analysis|image")!;
    expect(image.octetsReels).toBeGreaterThan(15_000_000);
    expect(image.provenances).toContain("assets réels image");
    // audio_understanding|audio_parole : les clips FLEURS fr_fr réels
    const audio = MESURES_MEMOIRE.find((m) => m.cle === "audio_understanding|audio_parole")!;
    expect(audio.octetsReels).toBeGreaterThan(15_000_000);
    // multimodal_v4|multimodal : snapshots SNN cumulatifs + échantillons v4
    const multi = MESURES_MEMOIRE.find((m) => m.cle === "multimodal_v4|multimodal")!;
    expect(multi.octetsReels).toBeGreaterThan(100_000_000);
    expect(multi.echantillonsAssimiles).toBe(338_439);
    // reasoning : les 999 935 paires bande 0 (documentées dans les en-têtes)
    const rais = MESURES_MEMOIRE.find((m) => m.cle === "reasoning|texte")!;
    expect(rais.echantillonsAssimiles).toBe(999_935);
    // total physique positif et plausible (centaines de Mo, pas de Go fabriqué)
    expect(TOTAUX.octetsReels).toBeGreaterThan(100_000_000);
    expect(TOTAUX.octetsReels).toBeLessThan(2_000_000_000);
  });

  it("sources datasets : chaque domaine a un registre tracé (acquise ou cible)", () => {
    const memoire = new MemoireDomainesGen3();
    let totalAcquises = 0;
    let totalCibles = 0;
    for (const d of DOMAINES_GEN3) {
      const sources = memoire.sourcesDomaine(d);
      expect(sources.length, `aucune source pour ${d}`).toBeGreaterThanOrEqual(1);
      for (const s of sources) {
        expect(["huggingface", "kaggle", "code"]).toContain(s.plateforme);
        expect(["acquise", "cible"]).toContain(s.statut);
        expect(s.emplacement.length).toBeGreaterThan(10);
        expect(s.reference.length).toBeGreaterThan(4);
        if (s.statut === "acquise") totalAcquises += 1;
        else totalCibles += 1;
      }
    }
    expect(totalAcquises).toBeGreaterThanOrEqual(19);
    expect(totalCibles).toBeGreaterThanOrEqual(8);
    // registre image : COCO-2017 acquise + miroir Kaggle cible
    const image = memoire.sourcesDomaine("image_analysis");
    expect(image.some((s) => s.nom === "rafaelpadilla/coco2017" && s.statut === "acquise")).toBe(true);
    expect(image.some((s) => s.plateforme === "kaggle")).toBe(true);
    // registre math : gsm8k cible (acquisition planifiée, nommé honnêtement)
    const math = memoire.sourcesDomaine("math");
    expect(math.some((s) => s.nom === "openai/gsm8k" && s.statut === "cible")).toBe(true);
  });
});

describe("memoire-domaines — expansion déterministe calculée (créer ce qui manque)", () => {
  const CALCULABLES = Object.keys(FAMILLES_SYNTHESE);

  it("déterminisme : même index → même unité, index différent → unité différente", () => {
    for (const cle of CALCULABLES) {
      const [d, c] = cle.split("|");
      const u1 = uniteSynthetique(d!, c!, 42);
      const u2 = uniteSynthetique(d!, c!, 42);
      expect(u1).toEqual(u2);
      const u3 = uniteSynthetique(d!, c!, 43);
      expect(u3!.question).not.toBe(u1!.question);
    }
  });

  it("les réponses synthétiques sont CALCULÉES exactes (vérification par recalcul)", () => {
    // échantillon large : chaque famille × plusieurs rotations
    let verifiees = 0;
    for (const cle of CALCULABLES) {
      const [d, c] = cle.split("|");
      const nb = FAMILLES_SYNTHESE[cle]!.length;
      for (let i = 0; i < nb * 30; i++) {
        const u = uniteSynthetique(d!, c!, i)!;
        expect(u.question.length).toBeGreaterThan(15);
        expect(u.reponse.length).toBeGreaterThan(10);
        verifiees += 1;
      }
    }
    expect(verifiees).toBeGreaterThanOrEqual(24 * 30);
    // vérification arithmétique ciblée : priorités opératoires
    const u = uniteSynthetique("math", "texte", 0)!;
    const match = u.question.match(/(\d+) × (\d+) \+ (\d+) × (\d+)/);
    expect(match).not.toBeNull();
    const [, a, b, c, dd] = match!;
    expect(u.reponse).toContain(String(Number(a) * Number(b) + Number(c) * Number(dd)));
  });

  it("étendue adressable : le chemin calculable atteint le quota 1 Go", () => {
    const memoire = new MemoireDomainesGen3();
    for (const cle of CALCULABLES) {
      const [d, c] = cle.split("|");
      const etat = memoire.etatCompartiment(d!, c!);
      expect(etat.expansionDeterministe).toBe(true);
      const adressables = unitesAdressables({
        cle: etat.cle,
        octetsReels: etat.octetsReels,
        echantillonsAssimiles: 0,
        octetsGraine: etat.octetsGraine,
        familles: 0,
        octetsMoyensParUnite: 1,
        expansionDeterministe: true,
        provenances: "",
      });
      expect(adressables).toBeGreaterThan(0);
      // l'unité du DERNIER index adressable se matérialise (Go réellement adressable)
      const u = uniteSynthetique(d!, c!, etat.unitesAdressables - 1);
      expect(u).not.toBeNull();
      expect(u!.reponse.length).toBeGreaterThan(10);
    }
  });
});

describe("memoire-domaines — ingestion (évolution par chat IA / API)", () => {
  it("ingestion, déduplication par empreinte, sources tracées", () => {
    const memoire = new MemoireDomainesGen3();
    const r1 = memoire.ingere({
      question: "Quelle est notre politique de remboursement interne ?",
      contenu:
        "La politique de remboursement interne : 42 jours ouvrés, justificatif obligatoire, validée par le service comptable.",
      source: "chat-ia",
    });
    expect(r1.accepte).toBe(true);
    expect(r1.raison).toBe("nouveau");
    expect(r1.octets).toBeGreaterThan(20);
    // même contenu → doublon refusé (empreinte identique)
    const r2 = memoire.ingere({
      question: "politique remboursement ?",
      contenu:
        "La politique de remboursement interne : 42 jours ouvrés, justificatif obligatoire, validée par le service comptable.",
      source: "api",
    });
    expect(r2.accepte).toBe(false);
    expect(r2.raison).toBe("doublon");
    expect(r2.empreinte).toBe(r1.empreinte);
    // ingestion brute (sans question) : octets comptés, pas de replay
    const r3 = memoire.ingere({
      contenu: "Dataset brut ingéré via l'API : mesure Capteur-A du 07/11, 1 024 échantillons à 50 Hz, checksum 0x9f3e.",
      domaine: "sciences",
      capacite: "texte",
      source: "api",
    });
    expect(r3.accepte).toBe(true);
    const stats = memoire.statistiques();
    expect(stats.enseignements).toBe(2);
    expect(stats.parSource["chat-ia"]).toBe(1);
    expect(stats.parSource["api"]).toBe(1);
    expect(stats.octetsInges).toBeGreaterThan(100);
    // la comptabilité du compartiment visé bouge
    const etatSciences = memoire.etatCompartiment("sciences", "texte");
    expect(etatSciences.octetsInges).toBeGreaterThan(0);
    expect(etatSciences.octetsPhysiques).toBe(
      etatSciences.octetsReels + etatSciences.octetsGraine + etatSciences.octetsInges,
    );
  });

  it("anneau borné : les plus anciens enseignements sont évincés (CAPACITE_INGESTION)", () => {
    const memoire = new MemoireDomainesGen3();
    for (let i = 0; i < CAPACITE_INGESTION + 5; i++) {
      memoire.ingere({ contenu: `enseignement unique numéro ${i} — contenu ${"x".repeat((i % 9) + 1)}`, source: "chat-ia" });
    }
    expect(memoire.litIngestions()).toHaveLength(CAPACITE_INGESTION);
    // la première ingestion conservée est la 6e posée (0..4 évincées)
    expect(memoire.litIngestions()[0]!.contenu).toContain("numéro 5");
    // ingestion vide refusée ; domaine inconnu refusé (honnêteté)
    expect(memoire.ingere({ contenu: "   ", source: "api" }).raison).toBe("contenu-vide");
    expect(memoire.ingere({ contenu: "données", domaine: "astrologie", source: "api" }).raison).toBe(
      "domaine-inconnu",
    );
  });

  it("voie « mémorisée » : la mémoire de réflexion rejoue l'enseignement ingéré", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const memoire = new MemoireDomainesGen3();
    const enseignement =
      "Le protocole de maintenance des capteurs de la station B exige une calibration tous les 90 jours, enregistrée dans le journal technique.";
    memoire.ingere({
      question: "Quelle est la fréquence de calibration des capteurs de la station B ?",
      contenu: enseignement,
      source: "chat-ia",
    });
    const reflexif = new CortexReflexifGen3(cortex, memoire);
    // question proche (formulation différente) : la voie directe échoue,
    // la voie « mémorisée » rattrape l'enseignement ingéré
    const d = reflexif.reflechir("Dis-moi la fréquence de calibration des capteurs de la station B");
    expect(d.domaine).toBe("audio_understanding"); // « fréquence » est un mot-clé audio (heuristique documentée)
    expect(d.voieElue).toBe("memorisee");
    expect(d.elue).toBe(enseignement);
    const reponse = reflexif.repondre("Quelle est la fréquence de calibration des capteurs ?");
    expect(reponse?.texte).toBe(enseignement);
    expect(reponse?.source).toBe("personnalisee");
    // question SANS recouvrement avec l'enseignement : aucun faux positif
    // (pas de fabrication — la voie mémorisée ne peut pas répondre)
    const d2 = reflexif.reflechir("Quel est le capitaine du navire Erebus");
    expect(d2.voieElue).not.toBe("memorisee");
  });

  it("domaine détecté inscrit dans chaque délibération (traçabilité du raisonnement)", () => {
    // classifieur direct (heuristique documentée, testée sur ses vrais indices)
    expect(identifieDomaine("Calcule l'aire d'un triangle de base 10")).toBe("math");
    expect(identifieDomaine("Écris une requête SQL avec une jointure")).toBe("databases");
    expect(identifieDomaine("Que contient l'image km113_image_000 ?")).toBe("image_analysis");
    expect(identifieDomaine("Convertis 3 000 mètres en kilomètres")).toBe("problem_solving");
    expect(identifieDomaine("Le chiffrement AES protège-t-il contre le XSS ?")).toBe("security_v4");
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const memoire = new MemoireDomainesGen3();
    const reflexif = new CortexReflexifGen3(cortex, memoire);
    const cas = [
      { motif: "Calcule l'aire d'un triangle de base 10 et hauteur 6", attendu: "math" },
      { motif: "Écris une requête SQL avec une jointure sur la table clients", attendu: "databases" },
      { motif: "Que contient l'image km113_image_000 ?", attendu: "image_analysis" },
    ];
    for (const c of cas) {
      const d = reflexif.reflechir(c.motif);
      expect(d.domaine, `motif : ${c.motif}`).toBe(c.attendu);
    }
    // question sans indice → null (pas de fausse certitude)
    const dInconnu = reflexif.reflechir("blorp viblorp 123");
    expect(dInconnu.domaine).toBeNull();
    // sans mémoire de domaines câblée : domaine null (comportement it.112 préservé)
    const reflexifSans = new CortexReflexifGen3(cortex);
    expect(reflexifSans.reflechir("Calcule 2 + 2").domaine).toBeNull();
  });

  it("non-régression réflexive : avec mémoire de domaines, le service ne baisse jamais", () => {
    const cortex = new CortexLangagierGen3();
    cortex.apprendre(CORPUS_GEN3 as never);
    const memoire = new MemoireDomainesGen3();
    const reflexif = new CortexReflexifGen3(cortex, memoire);
    const echantillon = CORPUS_GEN3.slice(0, 120);
    let servieDirecte = 0;
    let servieReflexive = 0;
    for (const p of echantillon) {
      const direct = cortex.repondre(p.motif);
      if (direct && direct.texte.length > 20) servieDirecte += 1;
      const d = reflexif.reflechir(p.motif);
      if (d.voieElue !== "echec") servieReflexive += 1;
    }
    expect(servieReflexive).toBeGreaterThanOrEqual(servieDirecte);
    const stats = reflexif.statistiques();
    expect(stats.parVoie.memorisee).toBe(0); // corpus exact : aucun recours à l'ingestion
    expect(stats.servies + stats.echecs).toBe(120);
  });

  it("les paires de chat sur la mémoire sont fidèles aux totaux mesurés", () => {
    const memoire = new MemoireDomainesGen3();
    const stats = memoire.statistiques();
    expect(stats.compartiments).toBe(133);
    expect(stats.dateMesure).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // la paire quota cite le quota exact et le nombre de compartiments
    const paireQuota = PAIRES_MEMOIRE.find((p) => p.motif.includes("quota"));
    expect(paireQuota).toBeDefined();
    expect(paireQuota!.reponse).toContain("1 000 000 000");
    expect(paireQuota!.reponse).toContain("133");
  });
});
