import { describe, expect, it } from "vitest";

import { OrchestrateurEssaim, dimensionsPourRatio } from "../orchestrateur";
import { RegistreEssaim } from "../registre";
import { BORNES_ESSAIM, découperEnSegments } from "../types";

function banc(): {
  o: OrchestrateurEssaim;
  r: RegistreEssaim;
  avancer: (ms: number) => void;
  uuid: () => string;
} {
  let t = 1_700_000_000_000;
  let compteur = 0;
  const registre = new RegistreEssaim(() => t);
  const orchestrateur = new OrchestrateurEssaim(
    registre,
    () => t,
    () => `uid-${String(++compteur).padStart(4, "0")}`,
  );
  return {
    o: orchestrateur,
    r: registre,
    avancer: (ms) => (t += ms),
    uuid: () => `uid-${String(compteur).padStart(4, "0")}`,
  };
}

function nœud(
  r: RegistreEssaim,
  id: string,
  memoireGo: number,
): void {
  r.battre(id, `user-${id}`, { webgpu: true, memoireGo, adaptateur: "test" });
}

describe("planifierFragments", () => {
  it("image = 1 fragment unique", () => {
    const { o } = banc();
    const plan = o.planifierFragments({ kind: "image", prompt: "un chat", seed: 42 });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ sous: "image", seed: 42, steps: BORNES_ESSAIM.stepsHaute });
  });

  it("vidéo = 6 keyframes QUALITÉ HAUTE, graines liées, dims du ratio", () => {
    const { o } = banc();
    const plan = o.planifierFragments({ kind: "video", prompt: "océan", ratio: "16:9", seed: 100 });
    expect(plan).toHaveLength(BORNES_ESSAIM.keyframesDéfaut);
    const seeds = plan.map((c) => (c as { seed: number }).seed);
    expect(seeds).toEqual([100, 117, 134, 151, 168, 185]);
    const dims = dimensionsPourRatio("16:9");
    expect(plan[0]).toMatchObject({
      sous: "keyframe",
      largeur: dims.w,
      hauteur: dims.h,
      steps: 26,
      guidance: 5.0,
    });
  });

  it("voix = segments de phrases ≤ 300 caractères, débit varié par rang", () => {
    const { o } = banc();
    const long = Array.from(
      { length: 10 },
      (_, i) => `Phrase numéro ${i} qui raconte une histoire différente et détaillée.`,
    ).join(" ");
    const plan = o.planifierFragments({ kind: "voice", prompt: long, seed: 1 });
    expect(plan.length).toBeGreaterThan(1);
    for (const charge of plan) {
      expect(charge.sous).toBe("segment");
      expect((charge as { texte: string }).texte.length).toBeLessThanOrEqual(300);
    }
    // Prosodie vivante : cycle de débit [1.0, 0.97, 1.03] par rang.
    expect((plan[0] as { vitesse: number }).vitesse).toBe(1.0);
    expect((plan[1] as { vitesse: number }).vitesse).toBe(0.97);
    expect((plan[2] as { vitesse: number }).vitesse).toBe(1.03);
  });
});

describe("découperEnSegments (pur)", () => {
  it("texte court = un segment", () => {
    expect(découperEnSegments("Bonjour.")).toEqual(["Bonjour."]);
    expect(découperEnSegments("")).toEqual([]);
  });

  it("coupe aux frontières de phrases", () => {
    const segs = découperEnSegments("Un matin clair. La mer était calme ! Qui savait ?", 20);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.join(" ").replace(/\s+/g, " ").trim()).toContain("Un matin clair.");
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(20);
  });

  it("jamais au milieu d'un mot (coupe virgules puis mots)", () => {
    const long = "incompréhensiblement ".repeat(40).trim();
    const segs = découperEnSegments(long, 60);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) {
      expect(s.length).toBeLessThanOrEqual(60);
      expect(s.startsWith(" ")).toBe(false);
      expect(s.endsWith(" ")).toBe(false);
    }
  });
});

describe("cycle de vie d'un job d'essaim", () => {
  it("attribution aux 5 meilleurs : UN fragment par GPU, reste en file", () => {
    const { o, r } = banc();
    nœud(r, "gpu-a", 4);
    nœud(r, "gpu-b", 2);
    nœud(r, "gpu-c", 1);
    const job = o.créerJob({
      conversationId: "conv-1",
      userId: "user-gpu-a",
      kind: "video",
      prompt: "vol de drone au coucher du soleil",
      ratio: "16:9",
    });
    expect(job).not.toBeNull();
    expect(job!.fragments).toHaveLength(6);

    const confiés = o.attribuer();
    // 3 GPU, charge 1 chacun → 3 parts confiées, 3 en attente.
    expect(confiés).toHaveLength(3);
    expect(confiés.every((f) => f.état === "attribue" && f.noeudId)).toBe(true);
    expect(job!.fragments.filter((f) => f.état === "en-attente")).toHaveLength(3);
    // Le meilleur GPU reçoit la première part (méritocratie par score).
    expect(confiés[0].noeudId).toBe("gpu-a");
    expect(job!.état).toBe("en-cours");
  });

  it("aucun nœud → rien n'est confié, le job reste en file (jamais de faux envoi)", () => {
    const { o } = banc();
    const job = o.créerJob({
      conversationId: "conv-1",
      userId: "user-solo",
      kind: "image",
      prompt: "une arène futuriste",
    });
    expect(o.attribuer()).toHaveLength(0);
    expect(job!.état).toBe("planifie");
  });

  it("résultats : propriété vérifiée, accumulation, action FUSION à la dernière part", () => {
    const { o, r } = banc();
    nœud(r, "gpu-a", 4);
    nœud(r, "gpu-b", 4);
    // Trois phrases denses (~250 caractères chacune) → 3 fragments de voix
    // (chaque phrase tient sous 300, mais deux ensemble dépassent : sépare).
    const prompt = Array.from({ length: 3 }, (_, i) => `Phrase ${i} ${"voix riche et naturelle ".repeat(10)}`).join(" ");
    const job = o.créerJob({
      conversationId: "conv-1",
      userId: "user-x",
      kind: "voice",
      prompt,
    });
    expect(job!.fragments.length).toBe(3);
    const confiés = o.attribuer();
    expect(confiés.length).toBe(2); // 3 segments, 2 GPU → 2 confiés

    const f0 = job!.fragments[0];
    // Mauvais nœud → refus.
    expect(o.déclarerRésultat(f0.fragmentId, "gpu-b", new Uint8Array([1])).ok).toBe(false);
    // Bon nœud → accepté.
    const r1 = o.déclarerRésultat(f0.fragmentId, f0.noeudId!, new Uint8Array([1, 2, 3]));
    expect(r1.ok).toBe(true);
    expect(r1.fusion).toBeUndefined();

    const f1 = job!.fragments[1];
    const r2 = o.déclarerRésultat(f1.fragmentId, f1.noeudId!, new Uint8Array([4, 5]));
    expect(r2.ok).toBe(true);
    expect(r2.fusion).toBeUndefined();

    // La 3e part (en attente) doit d'abord être confiée puis rendue.
    const troisième = o.attribuer();
    expect(troisième).toHaveLength(1);
    const f2 = job!.fragments[2];
    const r3 = o.déclarerRésultat(f2.fragmentId, f2.noeudId!, new Uint8Array([6]));
    expect(r3.ok).toBe(true);
    expect(r3.fusion?.action).toBe("fusionner");
    expect(r3.fusion!.résultats.get(0)).toEqual(new Uint8Array([1, 2, 3]));
    expect(r3.fusion!.job.état).toBe("fusion");
    // La charge des GPU est rendue.
    expect(r.sélectionnerÉquipe().length).toBe(2);
  });

  it("démarrerFragment exige le nœud propriétaire", () => {
    const { o, r } = banc();
    nœud(r, "gpu-a", 4);
    const job = o.créerJob({ conversationId: "c", userId: "u", kind: "image", prompt: "p" });
    o.attribuer();
    const f = job!.fragments[0];
    expect(o.démarrerFragment(f.fragmentId, "inconnu")).toBeNull();
    expect(o.démarrerFragment(f.fragmentId, f.noeudId!)?.état).toBe("en-cours");
  });

  it("scellerJob : l'œuvre fusionnée cloture le job avec son URL", () => {
    const { o } = banc();
    const job = o.créerJob({ conversationId: "c", userId: "u", kind: "image", prompt: "p" });
    o.scellerJob(job!.jobId, "https://r2/oeuvre.png", 1234);
    const état = o.étatJob(job!.jobId, "u");
    expect(état!.état).toBe("termine");
    expect(état!.résultat).toMatchObject({ url: "https://r2/oeuvre.png", taille: 1234 });
  });
});

describe("SENTINELLE DE RELANCE (déconnexions brusques)", () => {
  it("un agent qui disparaît brusquement → sa part est RELANCÉE vers un autre", () => {
    const { o, r, avancer } = banc();
    nœud(r, "gpu-vif", 4);
    nœud(r, "gpu-relais", 3);
    const registreRelais = (): void => nœud(r, "gpu-relais", 3);
    const j = o.créerJob({ conversationId: "c", userId: "user-gpu-vif", kind: "image", prompt: "aurore boréale" });
    const confiés = o.attribuer();
    expect(confiés).toHaveLength(1);
    const fragment = confiés[0];
    expect(fragment.noeudId).toBe("gpu-vif");

    // Le nœud meurt BRUSQUEMENT (plus de battements). Le relais, lui,
    // continue d'émettre ses ondes de vie.
    avancer(BORNES_ESSAIM.ttlNoeudMs + 5_000);
    registreRelais();
    const { relancés } = o.surveiller();
    expect(relancés).toHaveLength(1);
    expect(relancés[0].fragmentId).toBe(fragment.fragmentId);
    expect(relancés[0].génération).toBe(1);
    expect(relancés[0].état).toBe("en-attente");
    expect(relancés[0].noeudId).toBeUndefined();
    const jFrais = o.étatJob(j!.jobId, "user-gpu-vif");
    expect(jFrais!.relances).toHaveLength(1);

    // Un autre agent reçoit la part re-relancée.
    const reconfiés = o.attribuer();
    expect(reconfiés).toHaveLength(1);
    expect(reconfiés[0].noeudId).toBe("gpu-relais");
    expect(reconfiés[0].génération).toBe(1);
  });

  it("une part muette au-delà du TTL fragment est re-relancée même si le nœud vit", () => {
    const { o, r, avancer } = banc();
    nœud(r, "gpu-muet", 4);
    const j = o.créerJob({ conversationId: "c", userId: "user-gpu-muet", kind: "image", prompt: "x" });
    const [f] = o.attribuer();
    avancer(BORNES_ESSAIM.ttlFragmentMs + 1_000);
    const { relancés } = o.surveiller();
    expect(relancés.map((x) => x.fragmentId)).toContain(f.fragmentId);
    expect(o.étatJob(j!.jobId, "user-gpu-muet")!.relances).toHaveLength(1);
  });

  it("générationsMax épuisées → échec HONNÊTE, jamais de faux succès", () => {
    const { o, r, avancer } = banc();
    const j = o.créerJob({ conversationId: "c", userId: "user-gpu-seul", kind: "image", prompt: "x" });
    for (let g = 0; g <= BORNES_ESSAIM.générationsMax; g++) {
      // Le nœud continue d'émettre ses ondes (il est vivant mais muet sur
      // SA part — onglet figé : le TTL fragment doit suffire à la relance).
      nœud(r, "gpu-seul", 4);
      const confiés = o.attribuer();
      avancer(BORNES_ESSAIM.ttlFragmentMs + 1_000);
      const { échoués } = o.surveiller();
      if (g === BORNES_ESSAIM.générationsMax) {
        expect(échoués).toHaveLength(1);
        expect(o.étatJob(j!.jobId, "user-gpu-seul")!.état).toBe("echoue");
        expect(o.étatJob(j!.jobId, "user-gpu-seul")!.erreur).toBeTruthy();
        return;
      }
      expect(confiés.length + échoués.length).toBeGreaterThan(0);
    }
  });

  it("échec déclaré par le nœud lui-même → relance immédiate", () => {
    const { o, r } = banc();
    nœud(r, "gpu-panne", 4);
    nœud(r, "gpu-sain", 2);
    const j = o.créerJob({ conversationId: "c", userId: "u", kind: "video", prompt: "x" });
    o.attribuer(); // 1 confié à gpu-panne, 1 à gpu-sain (charges 1)
    const f = j!.fragments[0];
    const résultat = o.échouerFragment(f.fragmentId, f.noeudId!, "WebGPU OOM");
    expect(résultat).not.toBeNull();
    expect(résultat!.génération).toBe(1);
    expect(o.étatJob(j!.jobId, "u")!.relances).toHaveLength(1);
  });
});

describe("bornes et purge", () => {
  it("plafond de jobs actifs honnête (503 côté route)", () => {
    const { o } = banc();
    for (let i = 0; i < BORNES_ESSAIM.jobsActifsMax; i++) {
      expect(
        o.créerJob({ conversationId: `c${i}`, userId: "u", kind: "image", prompt: `p${i}` }),
      ).not.toBeNull();
    }
    expect(
      o.créerJob({ conversationId: "c-over", userId: "u", kind: "image", prompt: "over" }),
    ).toBeNull();
  });

  it("prompt vide refusé", () => {
    const { o } = banc();
    expect(o.créerJob({ conversationId: "c", userId: "u", kind: "image", prompt: "   " })).toBeNull();
  });

  it("les jobs terminés au-delà de la rétention sont purgés (octets libérés)", () => {
    const { o, r, avancer } = banc();
    nœud(r, "gpu-purge", 4);
    const j = o.créerJob({ conversationId: "c", userId: "u", kind: "image", prompt: "x" });
    const [f] = o.attribuer();
    o.déclarerRésultat(f.fragmentId, f.noeudId!, new Uint8Array(10));
    o.scellerJob(j!.jobId, "https://r2/x.png", 10);
    avancer(BORNES_ESSAIM.retentionJobMs + 1_000);
    o.purger();
    expect(o.étatJob(j!.jobId, "u")).toBeNull();
  });

  it("étatJob/jobParOrigine respectent la propriété utilisateur", () => {
    const { o } = banc();
    const j = o.créerJob({
      conversationId: "c",
      userId: "alice",
      kind: "image",
      prompt: "x",
      jobIdOrigine: "origine-1",
    });
    expect(o.étatJob(j!.jobId, "bob")).toBeNull();
    expect(o.jobParOrigine("origine-1", "alice")?.jobId).toBe(j!.jobId);
    expect(o.jobParOrigine("origine-1", "bob")).toBeNull();
  });
});
