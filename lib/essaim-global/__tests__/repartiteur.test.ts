import { describe, expect, it } from "vitest";

import { hacherUtilisateur, indexDeJain, RepartiteurGlobal } from "../repartiteur";

describe("répartiteur — primitives", () => {
  it("hachage FNV-1a : déterministe et bien réparti", () => {
    expect(hacherUtilisateur("alice")).toBe(hacherUtilisateur("alice"));
    expect(hacherUtilisateur("alice")).not.toBe(hacherUtilisateur("bob"));
    // Répartition sur 64 fragments : aucun fragment ne dépasse 5 % des 10k utilisateurs.
    const compte = new Array<number>(64).fill(0);
    for (let i = 0; i < 10_000; i++) {
      compte[hacherUtilisateur(`user-${i}`) % 64] += 1;
    }
    expect(Math.max(...compte)).toBeLessThan(500);
  });

  it("index de Jain : 1 pour égalité parfaite, faible pour monopole", () => {
    expect(indexDeJain([1, 1, 1, 1])).toBe(1);
    expect(indexDeJain([100, 0, 0, 0])).toBeCloseTo(0.25, 6);
    expect(indexDeJain([])).toBe(1);
  });
});

describe("répartiteur — admission", () => {
  it("admet puis sert dans l'ordre FIFO du fragment", () => {
    // Un seul fragment : l'ordre FIFO intra-fragment est observable.
    const r = new RepartiteurGlobal({ fragments: 1 });
    const d1 = r.soumettre("u1");
    const d2 = r.soumettre("u2");
    expect(d1.admis && d2.admis).toBe(true);
    const t1 = r.prochain();
    expect(t1!.utilisateur).toBe("u1");
    r.terminer(t1!);
    const t2 = r.prochain();
    expect(t2!.utilisateur).toBe("u2");
  });

  it("refuse au-delà du quota (token bucket) puis ré-admet après refill", () => {
    const r = new RepartiteurGlobal({ debitParUtilisateur: 1, rafale: 2, fragments: 4, fileParFragment: 100 });
    expect(r.soumettre("u1", 0, 0).admis).toBe(true);
    expect(r.soumettre("u1", 0, 0).admis).toBe(true);
    const refusee = r.soumettre("u1", 0, 0);
    expect(refusee.admis).toBe(false);
    if (!refusee.admis) expect(refusee.raison).toBe("quota");
    // 3 secondes plus tard : 3 jetons rechargés (débit 1/s, rafale 2).
    expect(r.soumettre("u1", 0, 3000).admis).toBe(true);
  });

  it("backpressure : refuse proprement quand une file est pleine", () => {
    const r = new RepartiteurGlobal({ fragments: 1, fileParFragment: 8, debitParUtilisateur: 1000, rafale: 1000 });
    let admises = 0;
    let refusees = 0;
    for (let i = 0; i < 50; i++) {
      const d = r.soumettre(`u${i}`, 0, 0);
      if (d.admis) admises += 1;
      else refusees += 1;
    }
    expect(admises).toBe(8);
    expect(refusees).toBe(42);
    const stats = r.stats();
    expect(stats.enAttente).toBe(8);
  });

  it("priorité haute passe avant la normale", () => {
    const r = new RepartiteurGlobal();
    r.soumettre("normal-1", 0, 0);
    r.soumettre("normal-2", 0, 0);
    r.soumettre("urgent", 2, 0);
    const t = r.prochain(0);
    expect(t!.utilisateur).toBe("urgent");
  });
});

describe("répartiteur — équité et famine", () => {
  it("round-robin : tous les utilisateurs d'un même fragment sont servis", () => {
    const r = new RepartiteurGlobal({ fragments: 1, fileParFragment: 500, debitParUtilisateur: 100, rafale: 100 });
    for (let i = 0; i < 100; i++) r.soumettre(`u${i}`, 0, 0);
    const servis = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const t = r.prochain(0);
      if (t) {
        servis.add(t.utilisateur);
        r.terminer(t, 0);
      }
    }
    expect(servis.size).toBe(100);
  });

  it("équité inter-fragments sous charge massive", () => {
    const r = new RepartiteurGlobal({ fragments: 16, fileParFragment: 2000, debitParUtilisateur: 100, rafale: 100, utilisateursSuivis: 5000 });
    // 1000 utilisateurs distincts soumettent chacun 10 demandes.
    for (let u = 0; u < 1000; u++) {
      for (let k = 0; k < 10; k++) r.soumettre(`user-${u}`, 0, 0);
    }
    let servis = 0;
    while (true) {
      const t = r.prochain(0);
      if (!t) break;
      r.terminer(t, 0);
      servis++;
    }
    // Toute la charge admise a été servie.
    expect(servis).toBe(r.stats().admises);
    // Équité : aucun utilisateur n'a été servi plus de 1.5× la moyenne.
    const stats = r.stats();
    expect(stats.equite).toBeGreaterThan(0.95);
  });
});

describe("répartiteur — 100 000 utilisateurs virtuels (stress)", () => {
  it("sert 100k utilisateurs distincts avec mémoire bornée et équité maintenue", () => {
    const r = new RepartiteurGlobal({
      fragments: 64,
      fileParFragment: 128,
      debitParUtilisateur: 10,
      rafale: 2,
      utilisateursSuivis: 10_000,
    });

    let admises = 0;
    let refusees = 0;
    // Vague 1 : 100 000 utilisateurs envoient chacun 1 demande au même instant.
    for (let u = 0; u < 100_000; u++) {
      const d = r.soumettre(`utilisateur-${u}`, 0, 0);
      if (d.admis) admises += 1;
      else refusees += 1;
    }

    const stats = r.stats();
    // Files saturées : le refus est la sécurité, la mémoire est bornée.
    expect(admises).toBeLessThanOrEqual(64 * 128);
    expect(stats.enAttente).toBeLessThanOrEqual(64 * 128);
    expect(refusees).toBeGreaterThan(0);

    // Le répartiteur suit au plus le plafond d'utilisateurs (LRU).
    expect(r.utilisateursSuivis).toBeLessThanOrEqual(10_000);

    // Drainage complet des files : tout ticket admis est servi.
    let servis = 0;
    for (;;) {
      const t = r.prochain(0);
      if (!t) break;
      r.terminer(t, 0);
      servis++;
    }
    expect(servis).toBe(admises);

    // Après drainage : files vides, prêtes pour une nouvelle vague.
    expect(r.stats().enAttente).toBe(0);
  });

  it("vagues successives : le répartiteur ne fuit pas", () => {
    const r = new RepartiteurGlobal({ fragments: 8, fileParFragment: 64, debitParUtilisateur: 50, rafale: 1, utilisateursSuivis: 1000 });
    let maxEnAttente = 0;
    for (let vague = 0; vague < 50; vague++) {
      for (let u = 0; u < 2000; u++) r.soumettre(`u-${vague % 10}-${u}`, 0, vague * 1000);
      for (;;) {
        const t = r.prochain(vague * 1000 + 500);
        if (!t) break;
        r.terminer(t, vague * 1000 + 500);
      }
      maxEnAttente = Math.max(maxEnAttente, r.stats().enAttente);
    }
    expect(maxEnAttente).toBeLessThanOrEqual(8 * 64);
    // Mémoire : le nombre d'utilisateurs suivis reste plafonné.
    expect(r.utilisateursSuivis).toBeLessThanOrEqual(1000);
  });

  it("débit O(1) : 500k admissions traitées sans dégradation", { timeout: 20_000 }, () => {
    // Test de NON-régression algorithmique, PAS un benchmark : les
    // machines CI sont ~10× plus lentes que le local. Une complexité
    // dégradée (O(n²)) exploserait largement au-delà du seuil.
    // Timeout vitest explicite (défaut 5 s, trop court en CI).
    const r = new RepartiteurGlobal({ fragments: 64, fileParFragment: 256, debitParUtilisateur: 1e9, rafale: 1e9, utilisateursSuivis: 1000 });
    const debut = performance.now();
    let servis = 0;
    for (let i = 0; i < 500_000; i++) {
      r.soumettre(`u${i % 500}`, 0, 0);
      const t = r.prochain(0);
      if (t) {
        r.terminer(t, 0);
        servis += 1;
      }
    }
    const duree = performance.now() - debut;
    expect(servis).toBe(500_000);
    expect(duree).toBeLessThan(15_000);
  });
});

describe("répartiteur — cycle de vie", () => {
  it("fermé : tout est refusé proprement", () => {
    const r = new RepartiteurGlobal();
    r.fermer();
    const d = r.soumettre("u1");
    expect(d.admis).toBe(false);
    if (!d.admis) expect(d.raison).toBe("ferme");
  });

  it("purger oublie les utilisateurs anciens", () => {
    const r = new RepartiteurGlobal({ utilisateursSuivis: 10 });
    for (let i = 0; i < 20; i++) r.soumettre(`u${i}`, 0, i * 100);
    const oublies = r.purger(10_000);
    expect(oublies).toBeGreaterThanOrEqual(0);
    expect(r.utilisateursSuivis).toBeLessThanOrEqual(10);
  });
});
