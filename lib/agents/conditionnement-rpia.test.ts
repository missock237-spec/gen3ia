import { describe, expect, it } from "vitest";

import {
  conditionnerRequeteRPIA,
  graineTourChat,
} from "./conditionnement-rpia";

/**
 * PONT SYMBOLIQUE RPIA → PROMPT (A-P0) — contrat testé :
 *  1. jamais d'exception (fail-soft total, doctrine du chat) ;
 *  2. déterminisme : la même (message, graine) produit le même profil ;
 *  3. chaque directive dérive d'une mesure réelle (télémétrie honnête) ;
 *  4. entrées dégénérées → null sans planter.
 */
describe("conditionnerRequeteRPIA", () => {
  it("retourne des directives non vides avec une télémétrie mesurée cohérente", () => {
    const resultat = conditionnerRequeteRPIA(
      "Rédige un rapport d'analyse des ventes du trimestre avec graphiques et recommandations.",
      42,
    );
    expect(resultat).not.toBeNull();
    expect(resultat!.directives.length).toBeGreaterThanOrEqual(1);
    expect(resultat!.directives.length).toBeLessThanOrEqual(3);
    for (const directive of resultat!.directives) {
      expect(directive.startsWith("Modulation RPIA :")).toBe(true);
    }
    expect(resultat!.telemetrie.noeuds).toBe(64);
    expect(resultat!.telemetrie.epoques).toBe(8);
    expect(resultat!.telemetrie.erreurInitiale).toBeGreaterThan(0);
    expect(resultat!.telemetrie.noeudsActifs).toBeGreaterThanOrEqual(0);
    expect(resultat!.telemetrie.noeudsActifs).toBeLessThanOrEqual(64);
  });

  it("est déterministe : même message + même graine → mêmes directives", () => {
    const message = "Analyse ces données et dis-moi si la tendance est bonne.";
    const a = conditionnerRequeteRPIA(message, 7);
    const b = conditionnerRequeteRPIA(message, 7);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b!.directives).toEqual(a!.directives);
    expect(b!.telemetrie.erreurFinale).toBe(a!.telemetrie.erreurFinale);
    expect(b!.telemetrie.dispersion).toBeCloseTo(a!.telemetrie.dispersion, 12);
  });

  it("modifie le conditionnement quand la graine change (requêtes distinctes)", () => {
    const message = "Explique-moi simplement comment fonctionne la photosynthèse.";
    const a = conditionnerRequeteRPIA(message, 1);
    const b = conditionnerRequeteRPIA(message, 2);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Les graines différentes produisent des couches différentes : au moins
    // la télémétrie fine (erreur mesurée) diverge — sinon la couche serait
    // insensible à sa graine, ce qui casserait le contrat déterministe.
    const differents =
      a!.telemetrie.erreurFinale !== b!.telemetrie.erreurFinale ||
      a!.telemetrie.dispersion !== b!.telemetrie.dispersion;
    expect(differents).toBe(true);
  });

  it("est fail-soft : entrées dégénérées → null, jamais d'exception", () => {
    expect(conditionnerRequeteRPIA("", 42)).toBeNull();
    expect(conditionnerRequeteRPIA("   \n\t  ", 42)).toBeNull();
    expect(conditionnerRequeteRPIA(null as unknown as string, 42)).toBeNull();
    expect(conditionnerRequeteRPIA(undefined as unknown as string, 42)).toBeNull();
  });

  it("graineTourChat est stable pour un même tour et distinct entre tours", () => {
    const a = graineTourChat("user-1", "Bonjour gen3");
    const b = graineTourChat("user-1", "Bonjour gen3");
    const c = graineTourChat("user-2", "Bonjour gen3");
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });
});
