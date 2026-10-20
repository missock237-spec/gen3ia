import { describe, expect, it } from "vitest";

import {
  appliquerGardeDeterministe,
  evaluerArithmetique,
  executerIntentionExacte,
  formaterNombre,
  resoudreDate,
  tokeniserArithmetique,
} from "../garde-deterministe";

describe("Deterministic Guard — parseur arithmétique exact (sans eval)", () => {
  it("tokenise les nombres français et les opérateurs unicode", () => {
    const jetons = tokeniserArithmetique("14 589 × 892");
    expect(jetons).not.toBeNull();
    expect(jetons).toHaveLength(3);
    expect(jetons![0]).toEqual({ t: "nombre", v: 14589 });
    expect(jetons![1]).toEqual({ t: "op", v: "*" });
    expect(jetons![2]).toEqual({ t: "nombre", v: 892 });
  });

  it("évalue les 4 opérations, puissances et parenthèses exactement", () => {
    const e = (s: string): number | null => evaluerArithmetique(tokeniserArithmetique(s)!);
    expect(e("14 589 × 892")).toBe(14589 * 892);
    expect(e("2 + 3 * 4")).toBe(14);
    expect(e("(2 + 3) * 4")).toBe(20);
    expect(e("10 / 4")).toBe(2.5);
    expect(e("2 ^ 10")).toBe(1024);
    expect(e("7 % 3")).toBe(1);
    expect(e("-5 + 3")).toBe(-2);
    expect(e("10 ÷ 2,5")).toBe(4);
    expect(e("100 − 58")).toBe(42);
    // Division par zéro : jamais un chiffre inventé.
    expect(e("5 / 0")).toBeNull();
    // Expression tronquée : refusée, pas « réparée ».
    expect(evaluerArithmetique(tokeniserArithmetique("2 +")!)).toBeNull();
    expect(tokeniserArithmetique("abc")).toBeNull();
  });

  it("formate à la française (espaces fines, virgule décimale)", () => {
    expect(formaterNombre(13013388)).toBe("13\u202f013\u202f388");
    expect(formaterNombre(2.5)).toBe("2,5");
    expect(formaterNombre(-1234567)).toBe("-1\u202f234\u202f567");
    expect(formaterNombre(0)).toBe("0");
  });
});

describe("Deterministic Guard — détection et exécution d'intentions exactes", () => {
  it("« Combien font 14 589 × 892 ? » → 13 013 388, jamais un autre chiffre", () => {
    const resultat = executerIntentionExacte("Combien font 14 589 × 892 ?");
    expect(resultat).not.toBeNull();
    expect(resultat!.intention.type).toBe("arithmetique");
    expect(resultat!.valeur).toBe(13013388);
    expect(resultat!.texte).toContain(formaterNombre(13013388));
  });

  it("pourcentages : « 15 % de 2 400 » → 360", () => {
    const resultat = executerIntentionExacte("calcule 15 % de 2 400");
    expect(resultat!.intention.type).toBe("pourcentage");
    expect(resultat!.valeur).toBe(360);
  });

  it("TVA : « TVA 20% sur 1000 » → 1 200 TTC", () => {
    const resultat = executerIntentionExacte("TVA 20% sur 1000");
    expect(resultat!.intention.type).toBe("tva");
    expect(resultat!.valeur).toBe(1200);
  });

  it("remise : « remise de 20% sur 500 » → 400 net", () => {
    const resultat = executerIntentionExacte("remise de 20% sur 500");
    expect(resultat!.intention.type).toBe("remise");
    expect(resultat!.valeur).toBe(400);
  });

  it("comparaison de règles : vrai/faux déterministes", () => {
    const vrai = executerIntentionExacte("14 589 > 892");
    expect(vrai!.texte).toContain("VRAI");
    const faux = executerIntentionExacte("3 > 100");
    expect(faux!.texte).toContain("FAUX");
  });

  it("dates : nombre de jours exact entre deux dates", () => {
    const resultat = resoudreDate("combien de jours entre le 1er mars 2026 et le 15 juin 2026", new Date("2026-01-15T00:00:00Z"));
    expect(resultat).not.toBeNull();
    expect(resultat!.valeur).toBe(106);
  });

  it("dates : « dans 45 jours » résolu calendairement", () => {
    const resultat = resoudreDate("quelle date dans 45 jours", new Date("2026-01-01T12:00:00Z"));
    expect(resultat).not.toBeNull();
    // 1er janvier + 45 jours = 15 février 2026.
    expect(resultat!.texte).toContain("15 février 2026");
  });

  it("dates : jour de la semaine d'une date future", () => {
    const resultat = resoudreDate("quel jour sera le 25 décembre 2026", new Date("2026-01-01T00:00:00Z"));
    expect(resultat).not.toBeNull();
    // 25 décembre 2026 = un vendredi (vérifié UTC).
    expect(resultat!.texte).toContain("vendredi");
  });

  it("aucune intention exacte dans une question purement ouverte → null", () => {
    expect(executerIntentionExacte("Écris-moi un poème sur la mer")).toBeNull();
    expect(executerIntentionExacte("Pourquoi le ciel est-il bleu ?")).toBeNull();
    expect(executerIntentionExacte("")).toBeNull();
  });
});

describe("Deterministic Guard — arbitrage entre l'onde et le calcul exact", () => {
  it("l'onde qui contient la bonne valeur est CONFORME (elle parle)", () => {
    const garde = appliquerGardeDeterministe("Combien font 14 589 × 892 ?", "Le résultat est 13 013 388.");
    expect(garde.active).toBe(true);
    expect(garde.coherence).toBe("conforme");
    expect(garde.source).toBe("onde");
    expect(garde.reponseFinale).toContain("13 013 388");
  });

  it("l'onde qui invente un chiffre est CORRIGÉE — le calcul gagne", () => {
    const garde = appliquerGardeDeterministe("Combien font 14 589 × 892 ?", "Je pense que cela fait environ 12 999 000.");
    expect(garde.active).toBe(true);
    expect(garde.coherence).toBe("corrigee");
    expect(garde.source).toBe("calcul_exact");
    expect(garde.reponseFinale).toContain(formaterNombre(13013388));
    expect(garde.reponseFinale).toContain("déterministe");
  });

  it("l'onde qui se tait reçoit le résultat exact", () => {
    const garde = appliquerGardeDeterministe("calcule 15 % de 2 400", "");
    expect(garde.coherence).toBe("corrigee");
    expect(garde.reponseFinale).toContain("360");
  });

  it("sans intention exacte, l'onde garde la parole (sans objet)", () => {
    const garde = appliquerGardeDeterministe("Pourquoi le ciel est-il bleu ?", "La diffusion de Rayleigh disperse les courtes longueurs d'onde.");
    expect(garde.active).toBe(false);
    expect(garde.coherence).toBe("sans_objet");
    expect(garde.source).toBe("onde");
    expect(garde.reponseFinale).toContain("Rayleigh");
  });
});
