import { describe, expect, it } from "vitest";

import {
  BORNES_ESSAIM,
  backoffReconnexion,
  planAssemblageTuiles,
  urlsPoidsPourPrécachage,
  type ChargeFragment,
} from "../types";

function tuile(tx: number, ty: number, gx = 2, gy = 2, l = 512, h = 512, overlap = 32): ChargeFragment {
  return {
    sous: "tuile",
    prompt: `scène — cadrage ${tx}/${ty}`,
    ratio: "1:1",
    seed: 42,
    steps: 26,
    guidance: 5,
    largeur: l,
    hauteur: h,
    grilleX: gx,
    grilleY: gy,
    tuileX: tx,
    tuileY: ty,
    overlap,
  };
}

describe("planAssemblageTuiles (géométrie de couture, pur)", () => {
  it("grille 2×2 : canevas 992×992, coutures à mi-chevauchement", () => {
    const plan = planAssemblageTuiles([
      tuile(0, 0), tuile(1, 0), tuile(0, 1), tuile(1, 1),
    ]);
    expect(plan).not.toBeNull();
    const demi = BORNES_ESSAIM.tuileOverlapPx / 2; // 16
    // Canevas : 2×(512−32)+32 = 992.
    expect(plan!.largeur).toBe(992);
    expect(plan!.hauteur).toBe(992);

    const [hg, hd, bg, bd] = plan!.zones;
    // Haut-gauche (bords gauche+haut EXTÉRIEURS) : rogné droite/bas seulement.
    expect(hg.rogner).toEqual({ left: 0, top: 0, width: 512 - demi, height: 512 - demi });
    expect(hg.coller).toEqual({ left: 0, top: 0 });
    // Haut-droit (bord droit EXTÉRIEUR) : rogné gauche, collé à 496.
    expect(hd.rogner).toEqual({ left: demi, top: 0, width: 512 - demi, height: 512 - demi });
    expect(hd.coller).toEqual({ left: 512 - 32 + demi, top: 0 });
    // Bas-droit (bords droit+bas EXTÉRIEURS) : collé au coin 496/496.
    expect(bd.rogner).toEqual({ left: demi, top: demi, width: 512 - demi, height: 512 - demi });
    expect(bd.coller).toEqual({ left: 496, top: 496 });
    // Bande basse-gauche (bord gauche EXTÉRIEUR) : collé à 0/496.
    expect(bg.rogner).toEqual({ left: 0, top: demi, width: 512 - demi, height: 512 - demi });
    expect(bg.coller).toEqual({ left: 0, top: 496 });
    // Couverture exacte : le coin bas-droit colle à 992.
    expect(bd.coller.left + bd.rogner.width).toBe(992);
    expect(bd.coller.top + bd.rogner.height).toBe(992);
  });

  it("les zones suivent l'ordre des charges (index de zone == index de fragment)", () => {
    const plan = planAssemblageTuiles([tuile(0, 0), tuile(1, 0), tuile(0, 1), tuile(1, 1)]);
    expect(plan!.zones.map((z) => [z.tuileX, z.tuileY])).toEqual([
      [0, 0], [1, 0], [0, 1], [1, 1],
    ]);
  });

  it("grille 1×1 : pas de rognage, canevas = tuile", () => {
    const plan = planAssemblageTuiles([tuile(0, 0, 1, 1)]);
    expect(plan).toEqual({
      largeur: 512,
      hauteur: 512,
      zones: [
        { tuileX: 0, tuileY: 0, rogner: { left: 0, top: 0, width: 512, height: 512 }, coller: { left: 0, top: 0 } },
      ],
    });
  });

  it("plans incohérents refusés (null)", () => {
    expect(planAssemblageTuiles([])).toBeNull();
    // Pas des tuiles.
    expect(
      planAssemblageTuiles([{ sous: "image", prompt: "p", ratio: "1:1", seed: 1, steps: 20, guidance: 4.5 }]),
    ).toBeNull();
    // Nombre de tuiles ≠ grille².
    expect(planAssemblageTuiles([tuile(0, 0), tuile(1, 0), tuile(0, 1)])).toBeNull();
    // Dimensions incohérentes entre tuiles.
    expect(planAssemblageTuiles([tuile(0, 0), tuile(1, 0), tuile(0, 1), tuile(1, 1, 2, 2, 512, 480)])).toBeNull();
    // Dimensions non multiples de 8 (contrainte VAE).
    expect(planAssemblageTuiles([tuile(0, 0, 1, 1, 510, 512)])).toBeNull();
    // Overlap ≥ dimension.
    expect(planAssemblageTuiles([tuile(0, 0, 1, 1, 512, 512, 600)])).toBeNull();
  });
});

describe("backoffReconnexion (pur)", () => {
  it("double puis plafonne à 15 s", () => {
    expect(backoffReconnexion(0)).toBe(1_000);
    expect(backoffReconnexion(1)).toBe(2_000);
    expect(backoffReconnexion(2)).toBe(4_000);
    expect(backoffReconnexion(3)).toBe(8_000);
    expect(backoffReconnexion(4)).toBe(15_000);
    expect(backoffReconnexion(10)).toBe(15_000);
  });
});

describe("urlsPoidsPourPrécachage (pur)", () => {
  it("liste les poids SD + Kokoro, plafonnée à 12", () => {
    const urls = urlsPoidsPourPrécachage("sd-photoreal", "kokoro");
    expect(urls).toContain("sd-photoreal/text_encoder.onnx");
    expect(urls).toContain("sd-photoreal/unet.onnx");
    expect(urls).toContain("sd-photoreal/vae_decoder.onnx");
    expect(urls).toContain("kokoro/kokoro-v1.0.onnx");
    expect(urls.every((u) => !u.startsWith("http"))).toBe(true);
    expect(urls.length).toBeLessThanOrEqual(12);
  });
});
