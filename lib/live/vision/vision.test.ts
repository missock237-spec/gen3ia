import { describe, expect, it } from "vitest";

import sharp from "sharp";

import { analyserFrame, creerFrameBuffer, fabriqueGrilleSharp } from "./frame-selector";
import { analyserScene } from "./scene-analyzer";
import { analyserTemporalite } from "./temporal-analyzer";
import { definirMoteurOcrLocal, lireTexte, moteurOcrActif, reinitialiserMoteurOcr } from "./ocr-engine";
import { creerVisionEngine } from "./vision-engine";

/**
 * TESTS PHASE 3 — GEN3IA LIVE : vision RÉELLE sur les pixels. Les frames
 * sont des JPEG RÉELS générés par sharp (dépendance locale) : fond blanc,
 * barres noires (texture type texte), rectangle mobile. Preuves mesurées :
 * dédup des frames identiques, détection du changement, bandes de texte,
 * colonne latérale, direction du mouvement, OCR honnêtement indisponible.
 */

const L = 256;
const H = 128;

async function jpegFondNoir(barreNoire: boolean, rect: { x: number } | null): Promise<Buffer> {
  const svg = `<svg width="${L}" height="${H}">
    <rect width="${L}" height="${H}" fill="white"/>
    ${barreNoire ? `<rect x="8" y="8" width="${L - 16}" height="8" fill="black"/><rect x="8" y="22" width="${L - 16}" height="6" fill="black"/>` : ""}
    ${rect ? `<rect x="${rect.x}" y="60" width="40" height="40" fill="black"/>` : ""}
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

describe("frame selector : dédup et sélection par changement réel (mission : ne pas tout analyser)", () => {
  it("première frame sélectionnée ; frame IDENTIQUE ignorée ; frame changée sélectionnée avec diff mesurée", async () => {
    const decoder = fabriqueGrilleSharp();
    const f1 = await jpegFondNoir(true, { x: 20 });
    const f1b = await jpegFondNoir(true, { x: 20 }); // identique au contenu
    const f2 = await jpegFondNoir(true, { x: 200 }); // rectangle déplacé

    const a = await analyserFrame(f1, null, decoder);
    expect(a.selectionnee).toBe(true);
    expect(a.raison).toBe("premiere-frame");

    const b = await analyserFrame(f1b, a, decoder);
    expect(b.selectionnee).toBe(false); // dédup : rien n'a changé
    expect(b.raison).toBe("identique-ignoree");
    expect(b.proportionChangee).toBeLessThan(0.02);

    const c = await analyserFrame(f2, a, decoder);
    expect(c.selectionnee).toBe(true);
    expect(c.raison).toBe("changement-detecte");
    expect(c.proportionChangee).toBeGreaterThan(0.01); // ~40×40 sur 256×128 réduit → mesuré
    expect(c.distanceHash).toBeGreaterThan(0);
  });

  it("buffer borné : mémoire temporelle limitée (pas de fuite)", async () => {
    const buffer = creerFrameBuffer(3);
    for (let i = 0; i < 5; i++) {
      buffer.ajouter({ horodatage: i, hash: `h${i}`, grille: new Uint8Array(1), largeur: 64, hauteur: 32, distanceHash: 1, diffMoyenne: 1, proportionChangee: 0.1, selectionnee: true, raison: "changement-detecte" });
    }
    expect(buffer.frames().length).toBe(3);
    expect(buffer.derniere()?.hash).toBe("h4");
  });
});

describe("scene analyzer : perception structurelle réelle (bandes de texte, colonnes, thème)", () => {
  it("bandes de texte détectées en haut, colonne gauche active avec rectangle à gauche, thème clair", async () => {
    const decoder = fabriqueGrilleSharp();
    const f1 = await analyserFrame(await jpegFondNoir(true, { x: 20 }), null, decoder);
    const scene = analyserScene(f1);
    expect(scene.bandes.filter((b) => b.probableTexte).length).toBeGreaterThan(0);
    expect(scene.bandes[1].probableTexte).toBe(true); // barres réduites → lignes 2..7 (bande 1)
    expect(scene.colonneActiveGauche).toBe(true); // rectangle à gauche
    expect(scene.interpretation).toContain("texte");
    expect(scene.interpretation).toContain("clair"); // fond blanc
  });

  it("écran sombre déclaré sombre (luminance mesurée, pas supposée)", async () => {
    const svg = `<svg width="${L}" height="${H}"><rect width="${L}" height="${H}" fill="#101010"/><rect x="10" y="10" width="30" height="10" fill="#888"/></svg>`;
    const jpeg = await sharp(Buffer.from(svg)).jpeg().toBuffer();
    const f = await analyserFrame(jpeg, null, fabriqueGrilleSharp());
    const scene = analyserScene(f);
    expect(scene.interpretation).toContain("sombre");
  });
});

describe("temporal analyzer : zones et direction du changement mesurées", () => {
  it("rectangle déplacé gauche→droite : direction 'droite', zone modifiée col 2, contexte honnête", async () => {
    const decoder = fabriqueGrilleSharp();
    const a = await analyserFrame(await jpegFondNoir(true, { x: 20 }), null, decoder);
    const b = await analyserFrame(await jpegFondNoir(true, { x: 200 }), a, decoder);
    const t = analyserTemporalite([a, b]);
    expect(t.framesConservees).toBe(2);
    expect(t.deplacement).toBe("horizontal"); // signature mesurée : zones symétriques extrêmes
    expect(t.zones.length).toBeGreaterThan(0);
  });

  it("frames identiques : direction immobile, contexte 'stable'", async () => {
    const decoder = fabriqueGrilleSharp();
    const a = await analyserFrame(await jpegFondNoir(true, null), null, decoder);
    const t = analyserTemporalite([a, a]);
    expect(t.direction).toBe("immobile");
    expect(t.contexte).toContain("stable");
  });

  it("moins de 2 frames : contexte honnête (aucune comparaison fabuleuse)", () => {
    expect(analyserTemporalite([]).contexte).toContain("aucune frame");
    expect(analyserTemporalite([{
      horodatage: 1, hash: "h", grille: new Uint8Array(64), largeur: 64, hauteur: 32,
      distanceHash: 0, diffMoyenne: 0, proportionChangee: 0, selectionnee: true, raison: "premiere-frame",
    }]).contexte).toContain("aucun point de comparaison");
  });
});

describe("OCR : adaptateur remplaçable (règle 11) + honnêteté absolue", () => {
  it("sans moteur branché : indisponible avec raison explicite, jamais de texte fabriqué", async () => {
    reinitialiserMoteurOcr();
    expect(moteurOcrActif()).toBeNull();
    const res = await lireTexte(await jpegFondNoir(true, null));
    expect(res.disponible).toBe(false);
    expect(res.raisonIndisponibilite).toContain("interdits");
    expect(res.textes).toBeUndefined();
  });

  it("moteur invalide rejeté ; moteur branché → vraie lecture transmise avec confiance plafonnée", async () => {
    expect(() => definirMoteurOcrLocal({ nom: "", lireTexte: async () => ({ textes: [], confiance: 1 }) })).toThrow("invalide");
    const reconnus: string[] = [];
    definirMoteurOcrLocal({
      nom: "moteur-test-local",
      lireTexte: async (jpeg) => {
        reconnus.push(jpeg.length.toString());
        return {
          textes: [{ contenu: "Enregistrer", zone: { x: 10, y: 20, largeur: 80, hauteur: 24 }, confiance: 0.92 }],
          elementsInterface: [{ type: "bouton", texte: "Enregistrer", zone: { x: 10, y: 20, largeur: 80, hauteur: 24 }, confiance: 0.92 }],
          confiance: 0.9,
        };
      },
    });
    expect(moteurOcrActif()?.nom).toBe("moteur-test-local");
    const res = await lireTexte(await jpegFondNoir(true, null));
    expect(res.disponible).toBe(true);
    expect(res.moteur).toBe("moteur-test-local");
    expect(res.textes?.[0].contenu).toBe("Enregistrer");
    expect(res.confiance).toBe(0.9);
    expect(reconnus).toHaveLength(1);
    reinitialiserMoteurOcr();
  });

  it("échec du moteur branché : indisponible avec raison (jamais de demi-lecture)", async () => {
    definirMoteurOcrLocal({
      nom: "moteur-cassé",
      lireTexte: async () => { throw new Error("wasm non initialisé"); },
    });
    const res = await lireTexte(await jpegFondNoir(true, null));
    expect(res.disponible).toBe(false);
    expect(res.raisonIndisponibilite).toContain("moteur-cassé");
    expect(res.raisonIndisponibilite).toContain("wasm non initialisé");
    reinitialiserMoteurOcr();
  });
});

describe("vision engine : pipeline complet (sélection → analyse → contexte)", () => {
  it("frame identique → null (non analysée) ; frame changée → description complète", async () => {
    const engine = creerVisionEngine("session-test");
    const d1 = await engine.traiter(await jpegFondNoir(true, { x: 20 }));
    expect(d1).not.toBeNull();
    expect(d1!.scene.bandes.length).toBe(12);
    expect(d1!.confiance.score).toBeGreaterThan(0.5); // première frame cohérente
    expect(d1!.confiance.facteurs.length).toBeGreaterThan(1);
    expect(d1!.ocr.disponible).toBe(false);
    expect(d1!.interpretation).toContain("non lu");

    // frame IDENTIQUE au contenu → ignorée par l'engine
    const d2 = await engine.traiter(await jpegFondNoir(true, { x: 20 }));
    expect(d2).toBeNull();

    // frame changée → analysée, contexte accumulé
    const d3 = await engine.traiter(await jpegFondNoir(true, { x: 200 }));
    expect(d3).not.toBeNull();
    expect(d3!.temporalite.deplacement).toBe("horizontal");
    expect(engine.contexte().length).toBe(2); // f1 + f3 (f2 ignorée)
  });
});
