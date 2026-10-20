import { describe, expect, it } from "vitest";

import {
  ancreJournal,
  chainer,
  empreinteEntree,
  GENESIS,
  verifierChaine,
} from "@/lib/security/journal-chaine";

/* ------------------------------------------------------------------ */
/* JOURNAL CHAÎNÉ — le journal d'audit est inviolable : chaque entrée    */
/* scelle la précédente (HMAC en chaîne).                                */
/* ------------------------------------------------------------------ */

interface EntreeTest {
  action: string;
  at: string;
  uid: string;
}

const entrees: EntreeTest[] = [
  { action: "project.created", at: "2026-01-01T08:00:00.000Z", uid: "u1" },
  { action: "arene.session", at: "2026-01-01T09:00:00.000Z", uid: "u1" },
  { action: "export.prepared", at: "2026-01-01T10:00:00.000Z", uid: "u1" },
];

describe("chaînage du journal", () => {
  it("chaîne proprement et se vérifie", () => {
    const chaîne = chainer<EntreeTest>(entrees);
    expect(chaîne).toHaveLength(3);
    expect(chaîne[0].hashPrev).toBe(GENESIS);
    expect(chaîne[1].hashPrev).toBe(chaîne[0].hash);
    expect(chaîne[2].hashPrev).toBe(chaîne[1].hash);
    const verdict = verifierChaine<EntreeTest>(chaîne);
    expect(verdict.valide).toBe(true);
  });

  it("la MODIFICATION d'une entrée passée est détectée", () => {
    const chaîne = chainer<EntreeTest>(entrees);
    const falsifiée = JSON.parse(JSON.stringify(chaîne)) as Array<{ entree: EntreeTest; hash: string; hashPrev: string }>;
    falsifiée[1].entree.action = "export.prepared"; // réécrire l'historique
    const verdict = verifierChaine<EntreeTest>(falsifiée);
    expect(verdict).toMatchObject({ valide: false, raison: "falsifie", a: 1 });
  });

  it("la SUPPRESSION d'une entrée est détectée (rupture de chaîne)", () => {
    const chaîne = chainer<EntreeTest>(entrees);
    const amputée = [chaîne[0], chaîne[2]]; // la 2e entrée a « disparu »
    const verdict = verifierChaine<EntreeTest>(amputée);
    expect(verdict).toMatchObject({ valide: false, raison: "ordre", a: 1 });
  });

  it("le RÉORDONNANCEMENT est détecté", () => {
    const chaîne = chainer<EntreeTest>(entrees);
    const mélangée = [chaîne[1], chaîne[0], chaîne[2]];
    const verdict = verifierChaine<EntreeTest>(mélangée);
    expect(verdict).toMatchObject({ valide: false, raison: "ordre", a: 0 });
  });

  it("l'ancre du mois relie les chaînes entre elles (reprise après redémarrage)", () => {
    const ancre = ancreJournal("u1", "2026-01");
    const reprise = chainer<EntreeTest>([entrees[0]], ancre);
    expect(reprise[0].hashPrev).toBe(ancre);
    const verdict = verifierChaine<EntreeTest>(reprise, ancre);
    expect(verdict.valide).toBe(true);
  });

  it("l'empreinte est déterministe et dépend du hash précédent", () => {
    const e = { action: "x", at: "t", uid: "u" } as unknown as Record<string, unknown>;
    expect(empreinteEntree(e, GENESIS)).toBe(empreinteEntree(e, GENESIS));
    expect(empreinteEntree(e, GENESIS)).not.toBe(empreinteEntree(e, "autre-ancre"));
  });
});
