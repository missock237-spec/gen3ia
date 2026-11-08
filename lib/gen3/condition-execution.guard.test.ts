import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONDITION_EXECUTION_GEN3,
  IDS_MODALITES_EXECUTION,
  MODALITES_EXECUTION,
  NB_MODALITES_EXECUTION,
  detecterModaliteExecution,
  sectionConditionExecution,
} from "./condition-execution";
import { RESPONSE_QUALITY_SYSTEM } from "@/lib/ai/response-quality";
import { GEN3IA_TOOLS } from "@/lib/tools/registry";

/**
 * VERROU BIDIRECTIONNEL it.139 (garde) — LA CONDITION PERMANENTE
 * D'EXÉCUTION DE GEN3.
 *
 * Demande propriétaire (2026-11-09) : « gen3 doit utiliser toutes les
 * ressources qu'il détient et doit déployer en permanence sans que
 * l'utilisateur ne lui demande ; si c'est du texte il doit utiliser ses
 * connaissances plus sa réflexion pour répondre ; si c'est de l'image il
 * doit toujours générer des images photoréalistes ; si c'est de la vidéo
 * il doit générer des vidéos réalistes ; si c'est de l'audio il doit
 * toujours réaliser un audio réaliste et optimal ; si c'est l'exécution
 * d'une tâche en externe il doit utiliser les ressources qu'il possède et
 * réfléchir pour atteindre l'objectif que l'utilisateur lui a donné. Pour
 * toute requête d'un utilisateur, gen3 doit réfléchir de lui-même avant
 * de la résoudre. »
 *
 * Ce garde verrouille les DEUX directions :
 *  1. La charte (condition-execution.ts) : EXACTEMENT les 5 modalités
 *     énoncées dans l'ordre du propriétaire, exigences impératives,
 *     ressources RÉELLES (zéro fantôme — règle it.58) ;
 *  2. Le CÂBLAGE : gen3 l'APPLIQUE — la section est injectée dans le
 *     prompt système du moteur de conversation (engine-chat.ts, chaque
 *     tour) ET dans le prompt système de qualité (response-quality.ts).
 */

const NOMS_OUTILS_REELS = new Set(GEN3IA_TOOLS.map((outil) => outil.name));

/** Les 5 libellés, dans l'ordre énoncé par le propriétaire. */
const LIBELLES_PROPRIETAIRE = ["Texte", "Image", "Vidéo", "Audio", "Tâche externe"];

describe("it.139 — la charte de la condition permanente (source de vérité)", () => {
  it("déclare EXACTEMENT les 5 modalités énoncées, dans l'ordre du propriétaire", () => {
    expect(NB_MODALITES_EXECUTION).toBe(5);
    expect(MODALITES_EXECUTION).toHaveLength(5);
    expect(MODALITES_EXECUTION.map((m) => m.label)).toEqual(LIBELLES_PROPRIETAIRE);
    expect(IDS_MODALITES_EXECUTION).toEqual(["texte", "image", "video", "audio", "tache-externe"]);
  });

  it("utilise des identifiants canoniques uniques (kebab-case)", () => {
    const ids = MODALITES_EXECUTION.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("chaque modalité porte une exigence impérative et au moins 3 ressources réelles", () => {
    for (const modalite of MODALITES_EXECUTION) {
      expect(modalite.exigence.length).toBeGreaterThanOrEqual(120);
      expect(modalite.ressources.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("chaque exigence porte le mot du propriétaire pour sa modalité", () => {
    const phrases: Record<string, string[]> = {
      texte: ["CONNAISSANCES PLUS TA RÉFLEXION"],
      image: ["TOUJOURS", "PHOTORÉALISTE"],
      video: ["TOUJOURS", "RÉALISTE"],
      audio: ["TOUJOURS", "RÉALISTE ET OPTIMAL"],
      "tache-externe": ["RESSOURCES QUE TU POSSÈDES", "atteindre l'objectif"],
    };
    for (const modalite of MODALITES_EXECUTION) {
      for (const phrase of phrases[modalite.id] ?? []) {
        expect(modalite.exigence, `modalité ${modalite.id}`).toContain(phrase);
      }
    }
  });

  it("ZÉRO OUTIL FANTÔME : chaque ressource référencée existe au registre GEN3IA_TOOLS", () => {
    expect(NOMS_OUTILS_REELS.size).toBeGreaterThan(40);
    for (const modalite of MODALITES_EXECUTION) {
      for (const ressource of modalite.ressources) {
        expect(NOMS_OUTILS_REELS.has(ressource)).toBe(true);
      }
    }
  });

  it("la condition maîtresse porte les mots du propriétaire (toutes ressources, permanence, réflexion)", () => {
    expect(CONDITION_EXECUTION_GEN3).toContain("TOUTES les ressources");
    expect(CONDITION_EXECUTION_GEN3).toContain("en PERMANENCE");
    expect(CONDITION_EXECUTION_GEN3).toContain("réfléchit D'ABORD par lui-même");
    expect(CONDITION_EXECUTION_GEN3).toContain("image photoréaliste");
    expect(CONDITION_EXECUTION_GEN3).toContain("audio réaliste et optimal");
  });
});

describe("it.139 — gen3 l'APPLIQUE : la section injectée à gen3", () => {
  const section = sectionConditionExecution();

  it("affirme la mobilisation totale sans demande et la réflexion préalable", () => {
    expect(section).toContain("TA CONDITION PERMANENTE D'EXÉCUTION — GEN3");
    expect(section).toContain("TOUTES les ressources que tu détiens");
    expect(section).toContain("SANS que l'utilisateur ait à te le demander");
    expect(section).toContain("tu réfléchis D'ABORD par toi-même");
    expect(section).toContain("avant de résoudre");
  });

  it("cite les 5 modalités numérotées 3 à 7 (après les 2 règles transversales)", () => {
    LIBELLES_PROPRIETAIRE.forEach((libelle, index) => {
      expect(section).toContain(`${index + 3}. ${libelle.toUpperCase()} —`);
    });
    expect(section).not.toContain("8. ");
  });

  it("verrouille les exigences de réalisme par modalité", () => {
    expect(section).toContain("PHOTORÉALISTE");
    expect(section).toContain("RÉALISTE ET OPTIMAL");
    expect(section).toContain("image.generate");
    expect(section).toContain("video.create");
    expect(section).toContain("voice.speak");
  });

  it("reste honnête : le réalisme ne promet jamais une capacité fantôme", () => {
    expect(section).toContain("ne te fait JAMAIS promettre une capacité qui n'existe pas");
    expect(section).toContain("moteurs RÉELS");
  });

  it("est déterministe (deux appels identiques → même section)", () => {
    expect(sectionConditionExecution()).toBe(section);
    expect(RESPONSE_QUALITY_SYSTEM).toContain("TA CONDITION PERMANENTE D'EXÉCUTION — GEN3");
  });
});

describe("it.139 — détection lexicale de la modalité (déterministe, traçabilité)", () => {
  it("route des demandes réelles vers la bonne modalité", () => {
    const cas: Array<[string, string]> = [
      ["Rédige un texte : une lettre de relance client", "texte"],
      ["Génère une image photoréaliste d'un lion au coucher du soleil", "image"],
      ["Crée une vidéo réaliste de vagues sur la côte", "video"],
      ["Génère un audio : voix off grave pour mon podcast", "audio"],
      ["Effectue la tâche en externe : recherche web, puis envoie un email au client", "tache-externe"],
    ];
    for (const [demande, attendu] of cas) {
      const detection = detecterModaliteExecution(demande);
      expect(detection, `demande : ${demande}`).not.toBeNull();
      expect(detection?.id, `demande : ${demande}`).toBe(attendu);
    }
  });

  it("retourne null plutôt que d'inventer une modalité (honnêteté)", () => {
    expect(detecterModaliteExecution("")).toBeNull();
    expect(detecterModaliteExecution("   ")).toBeNull();
    expect(detecterModaliteExecution("xyzzy plugh qwerty")).toBeNull();
  });

  it("est déterministe (deux appels identiques → même détection)", () => {
    const a = detecterModaliteExecution("Génère une image photoréaliste d'un lion");
    const b = detecterModaliteExecution("Génère une image photoréaliste d'un lion");
    expect(a).toEqual(b);
  });
});

describe("it.139 — VERROU bidirectionnel : le câblage réel des prompts", () => {
  const lire = (relatif: string): string =>
    readFileSync(path.join(import.meta.dirname, relatif), "utf8");

  it("le moteur de conversation injecte la condition dans ses prompts système", () => {
    const src = lire("../domain/conversations/engine-chat.ts");
    expect(src).toContain('from "@/lib/gen3/condition-execution"');
    expect(src).toContain("sectionConditionExecution(),");
    // Injecté DANS systemParts, APRÈS la vocation : l'ordre est celui de
    // l'assemblage réel du prompt système du tour chat.
    const positionSystemParts = src.indexOf("const systemParts = [");
    const positionVocation = src.indexOf("sectionVocationGen3(),");
    const positionCondition = src.indexOf("sectionConditionExecution(),");
    expect(positionSystemParts).toBeGreaterThan(-1);
    expect(positionVocation).toBeGreaterThan(positionSystemParts);
    expect(positionCondition).toBeGreaterThan(positionVocation);
  });

  it("le prompt système de qualité inclut la condition (surfaces génériques)", () => {
    const src = lire("../ai/response-quality.ts");
    expect(src).toContain('from "@/lib/gen3/condition-execution"');
    expect(src).toContain("sectionConditionExecution(),");
    const positionVocation = src.indexOf("sectionVocationGen3(),");
    const positionCondition = src.indexOf("sectionConditionExecution(),");
    expect(positionCondition).toBeGreaterThan(positionVocation);
  });
});
