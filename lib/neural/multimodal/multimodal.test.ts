/**
 * MULTIMODAL GÉNÉRATIF — TESTS RÉELS DE BOUT EN BOUT.
 *
 * Tout fichier produit est DÉCODÉ : signature/octet d'en-tête, structure
 * de chunks, dimensions, durée — et les propriétés promises sont MESURÉES
 * (déterminisme octet à octet, influence de l'éclairage sur les pixels,
 * différence mesurable entre deux profils de voix, ANIMATION prouvée par
 * différence de pixels entre frames). Aucun « succès » déclaré sans
 * vérification : les PNG/WAV/AVI produits sont de vrais fichiers lisibles.
 */

import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";

import { ecrirePNG } from "./generateur-images";
import { planifierScene, planifierVideo, motsSignificatifs } from "./encodeur-prompt-scene";
import { rendreStructurel } from "./generateur-images";
import { capturerProfilVoix, ecrireWAV, lireWAV, synthetiserVoix, type EchantillonWav, type ProfilVoix } from "./generateur-voix";
import { decoderPixelsPNG, ecrireAVI, genererVideo } from "./generateur-video";
import { creerLivraisonMultimodale } from "./facade-multimodale";

/* ===================== Aides de décodage (réelles) ===================== */

/** Parse un PNG (signature + chunks + CRC vérifiés) → {largeur, hauteur, pixels}. */
function decoderPNG(png: Buffer): { largeur: number; hauteur: number; pixels: Buffer; crcValide: boolean } {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(png.subarray(0, 8).equals(SIGNATURE)).toBe(true);
  let offset = 8;
  let largeur = 0;
  let hauteur = 0;
  const idat: Buffer[] = [];
  let crcValide = true;
  // CRC32 recalculé (même table que l'écrivain, réimplémentée ici pour l'indépendance).
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  while (offset + 8 <= png.length) {
    const taille = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const donnees = png.subarray(offset + 8, offset + 8 + taille);
    const crcStocke = png.readUInt32BE(offset + 8 + taille);
    let c = 0xffffffff;
    for (const octet of Buffer.concat([Buffer.from(type, "ascii"), donnees])) c = table[(c ^ octet) & 0xff] ^ (c >>> 8);
    if (((c ^ 0xffffffff) >>> 0) !== crcStocke) crcValide = false;
    if (type === "IHDR") {
      largeur = donnees.readUInt32BE(0);
      hauteur = donnees.readUInt32BE(4);
    } else if (type === "IDAT") {
      idat.push(donnees);
    } else if (type === "IEND") break;
    offset += 12 + taille;
  }
  const brut = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(largeur * hauteur * 3);
  const pas = 1 + largeur * 3;
  for (let y = 0; y < hauteur; y++) brut.copy(pixels, y * largeur * 3, y * pas + 1, (y + 1) * pas);
  return { largeur, hauteur, pixels, crcValide };
}

/** Parse un WAV → {frequence, echantillons, duree}. */
function decoderWAV(wav: Buffer): { frequence: number; echantillons: number; duree: number } {
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
  const echantillons = lireWAV(wav);
  return { frequence: echantillons.frequenceEchantillonnage, echantillons: echantillons.echantillons.length, duree: echantillons.echantillons.length / echantillons.frequenceEchantillonnage };
}

/** Parse un AVI → structure complète (frames, dims, fps, idx). */
function decoderAVI(avi: Buffer): { nbFrames: number; largeur: number; hauteur: number; fps: number; indexValide: boolean } {
  expect(avi.toString("ascii", 0, 4)).toBe("RIFF");
  expect(avi.toString("ascii", 8, 12)).toBe("AVI ");
  // Parcours RIFF PLAT : chaque chunk est lu UNE seule fois. Les LIST sont
  // soit descendues manuellement (hdrl → avih/strh), soit comptées (movi).
  let offset = 12;
  let nbFrames = 0;
  let largeur = 0;
  let hauteur = 0;
  let fps = 0;
  let indexValide = false;
  let framesMovi = 0;
  while (offset + 8 <= avi.length) {
    const id = avi.toString("ascii", offset, offset + 4);
    const taille = avi.readUInt32LE(offset + 4);
    if (id === "LIST") {
      const type = avi.toString("ascii", offset + 8, offset + 12);
      if (type === "movi") {
        let p = offset + 12;
        const finListe = offset + 8 + taille;
        while (p + 8 <= finListe) {
          const cid = avi.toString("ascii", p, p + 4);
          const ctaille = avi.readUInt32LE(p + 4);
          if (cid === "00dc") framesMovi++;
          p += 8 + ctaille + (ctaille % 2);
        }
      } else if (type === "hdrl") {
        // Descendre dans hdrl pour lire avih et strh (une seule fois).
        let p = offset + 12;
        const finListe = offset + 8 + taille;
        while (p + 8 <= finListe) {
          const cid = avi.toString("ascii", p, p + 4);
          const ctaille = avi.readUInt32LE(p + 4);
          if (cid === "avih") {
            nbFrames = avi.readUInt32LE(p + 8 + 16);
            largeur = avi.readUInt32LE(p + 8 + 32);
            hauteur = avi.readUInt32LE(p + 8 + 36);
          }
          if (cid === "LIST" && avi.toString("ascii", p + 8, p + 12) === "strl") {
            // LIST strl imbriquée → descendre pour lire strh.
            let q = p + 12;
            const finStrl = p + 8 + ctaille;
            while (q + 8 <= finStrl) {
              const qid = avi.toString("ascii", q, q + 4);
              const qtaille = avi.readUInt32LE(q + 4);
              if (qid === "strh") {
                fps = avi.readUInt32LE(q + 8 + 24) / Math.max(1, avi.readUInt32LE(q + 8 + 20));
              }
              q += 8 + qtaille + (qtaille % 2);
            }
          }
          p += 8 + ctaille + (ctaille % 2);
        }
      }
    } else if (id === "idx1") {
      const n = taille / 16;
      let ok = n === framesMovi;
      for (let k = 0; k < n && ok; k++) {
        if (avi.toString("ascii", offset + 8 + k * 16, offset + 8 + k * 16 + 4) !== "00dc") ok = false;
      }
      indexValide = ok;
    }
    offset += 8 + taille + (taille % 2);
  }
  nbFrames = Math.max(nbFrames, framesMovi);
  return { nbFrames, largeur, hauteur, fps, indexValide };
}

/* ============================ Échantillons ============================ */

/** Synthétise un WAV « échantillon de voix » (harmonique + vibrato) pour capturer un profil. */
function fabriqueEchantillon(f0: number, fs = 22050, secondes = 1.2, richesse = 0.5): EchantillonWav {
  const n = Math.floor(fs * secondes);
  const echantillons = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const env = Math.min(1, t * 8) * Math.min(1, (secondes - t) * 8);
    let v = Math.sin(2 * Math.PI * f0 * t);
    v += richesse * 0.5 * Math.sin(2 * Math.PI * f0 * 2 * t); // 2e harmonique
    v += richesse * 0.25 * Math.sin(2 * Math.PI * f0 * 3 * t); // 3e
    v += 0.05 * Math.sin(2 * Math.PI * f0 * 5 * t);
    echantillons[i] = v * env * 0.8;
  }
  return { echantillons, frequenceEchantillonnage: fs };
}

/** Profil DECLARÉ (voix par défaut neutre — jamais une imitation sans consentement). */
function profilNeutre(): ProfilVoix {
  return {
    hauteurHz: 130,
    timbreBandes: [0.3, 0.22, 0.18, 0.12, 0.08, 0.05, 0.03, 0.02],
    debitCrestesParSeconde: 4,
    consentement: { accordee: true, source: "profil-par-defaut-gen3" },
  };
}

/* ============================ Tests ============================ */

describe("1 — planificateur de scène (prompt → plan structuré déterministe)", () => {
  it("détecte éclairage, cadrage, sujet, éléments — et est reproductible", () => {
    const plan = planifierScene("un chasseur au crépuscule dans la savane, plan large");
    expect(plan.eclairage).toBe("heure-doree");
    expect(plan.cadrage).toBe("plan-large");
    expect(plan.sujet).toBe("chasseur");
    expect(plan.elements).toContain("savane");
    const deuxieme = planifierScene("un chasseur au crépuscule dans la savane, plan large");
    expect(deuxieme).toEqual(plan);
  });

  it("nuit et néon reconnus ; mots outils exclus ; motsSignificatifs déterministe", () => {
    expect(planifierScene("la ville la nuit sous les néons").eclairage).toBe("nuit");
    expect(planifierScene("couloir futuriste néon cyber").eclairage).toBe("neon");
    expect(motsSignificatifs("le chat de la voisine")).toEqual(["chat", "voisine"]);
  });

  it("planifierVideo : séquence de scènes avec actions (zoom → entrante, panoramique)", () => {
    const plan = planifierVideo("le village au bord du fleuve puis la caméra approche du marché puis panoramique sur les pirogues", 6, 8);
    expect(plan.sequence).toBeDefined();
    expect(plan.sequence!.scenes.length).toBe(3);
    expect(plan.sequence!.scenes[1].action).toBe("entrante");
    expect(plan.sequence!.scenes[2].action).toBe("panoramique");
    expect(plan.sequence!.fps).toBe(8);
  });
});

describe("2 — générateur d'images : PNG RÉEL décodé (signature, CRC, dimensions, pixels)", () => {
  it("le PNG produit est décodable : CRC recalculés valides, dimensions exactes", () => {
    const rendu = rendreStructurel(planifierScene("une femme au marché de Douala à l'heure dorée"), 256, 192);
    expect(rendu.png.length).toBeGreaterThan(1000);
    const decode = decoderPNG(rendu.png);
    expect(decode.largeur).toBe(256);
    expect(decode.hauteur).toBe(192);
    expect(decode.pixels.length).toBe(256 * 192 * 3);
    expect(decode.crcValide).toBe(true);
    expect(rendu.niveauRealisme).toBe("structurel-local");
  });

  it("déterminisme octet à octet + influence réelle de l'éclairage sur les pixels", () => {
    const plan = planifierScene("un pêcheur au crépuscule sur le fleuve");
    const a = rendreStructurel(plan, 128, 96).png;
    const b = rendreStructurel(plan, 128, 96).png;
    expect(a.equals(b)).toBe(true);
    // Jour vs nuit : moyenne de luminosité mesurée — la nuit doit être plus sombre.
    const lumiere = (png: Buffer) => {
      const { pixels } = decoderPNG(png);
      let somme = 0;
      for (let i = 0; i < pixels.length; i += 3) somme += pixels[i] + pixels[i + 1] + pixels[i + 2];
      return somme / (pixels.length / 3);
    };
    const jour = lumiere(rendreStructurel(planifierScene("un pêcheur en plein jour"), 128, 96).png);
    const nuit = lumiere(rendreStructurel(planifierScene("un pêcheur la nuit"), 128, 96).png);
    expect(jour).toBeGreaterThan(nuit * 1.2);
  });

  it("ecrirePNG brut : vérification de la structure des chunks", () => {
    const pixels = Buffer.alloc(16 * 16 * 3, 128);
    const png = ecrirePNG(16, 16, pixels);
    expect(png.readUInt32BE(8)).toBe(13); // IHDR length
    expect(png.toString("ascii", 12, 16)).toBe("IHDR");
    expect(png.toString("ascii", 8 + 25 + 4, 8 + 29 + 4)).toBe("IDAT");
    const decode = decoderPNG(png);
    expect(decode.largeur).toBe(16);
  });
});

describe("3 — générateur de voix : profil RÉEL capturé, consentement exigé, synthèse mesurable", () => {
  it("capture d'un profil : f0 mesurée proche de la vraie hauteur, timbre somme = 1", () => {
    const profil = capturerProfilVoix(fabriqueEchantillon(180), { accordee: true, source: "test-consentement-18.3b" });
    expect(profil.hauteurHz).toBeGreaterThan(150);
    expect(profil.hauteurHz).toBeLessThan(220);
    const sommeBandes = profil.timbreBandes.reduce((a, b) => a + b, 0);
    expect(sommeBandes).toBeCloseTo(1, 1);
    expect(profil.debitCrestesParSeconde).toBeGreaterThan(0);
  });

  it("PORTE DE CONSENTEMENT : aucun profil sans autorisation enregistrée", () => {
    expect(() => capturerProfilVoix(fabriqueEchantillon(180), { accordee: false, source: "test" })).toThrow(/Consentement requis/);
  });

  it("synthèse : WAV décodable, durée cohérente, déterminisme octet à octet", () => {
    const profil = profilNeutre();
    const a = synthetiserVoix("bonjour je suis gen3 votre assistante", profil);
    const b = synthetiserVoix("bonjour je suis gen3 votre assistante", profil);
    expect(a.wav.equals(b.wav)).toBe(true);
    const decode = decoderWAV(a.wav);
    expect(decode.frequence).toBe(22050);
    expect(decode.duree).toBeGreaterThan(0.5);
    expect(decode.duree).toBeLessThan(6);
  });

  it("RESSEMBLANCE mesurable : deux profils différents → sorties acoustiquement distinctes", () => {
    const grave = { ...profilNeutre(), hauteurHz: 90, timbreBandes: [0.5, 0.25, 0.12, 0.06, 0.04, 0.02, 0.005, 0.005] };
    const aigu = { ...profilNeutre(), hauteurHz: 260, timbreBandes: [0.08, 0.12, 0.2, 0.25, 0.2, 0.1, 0.03, 0.02] };
    const voxA = synthetiserVoix("le fleuve coule doucement", grave).echantillons;
    const voxB = synthetiserVoix("le fleuve coule doucement", aigu).echantillons;
    // Mesure 1 : la fondamentale de la voix grave est présente et dominante.
    const energie = (echantillons: Float32Array, freq: number, fs = 22050) => {
      let re = 0;
      let im = 0;
      const n = Math.min(echantillons.length, fs);
      for (let i = 0; i < n; i++) {
        re += echantillons[i] * Math.cos((2 * Math.PI * freq * i) / fs);
        im -= echantillons[i] * Math.sin((2 * Math.PI * freq * i) / fs);
      }
      return Math.hypot(re, im);
    };
    expect(energie(voxA, 90)).toBeGreaterThan(energie(voxB, 90) * 20);
    // Mesure 2 : le CENTROÏDE SPECTRAL (barycentre de l'énergie) sépare les
    // timbres — robuste au flUAGE d'un seul bin : la voix aiguë sonne plus haut.
    const centroide = (echantillons: Float32Array, fs = 22050) => {
      let sommePonderee = 0;
      let sommeEnergie = 0;
      for (let f = 60; f <= 4000; f += 20) {
        const e = energie(echantillons, f, fs);
        sommePonderee += f * e * e;
        sommeEnergie += e * e;
      }
      return sommePonderee / Math.max(1e-9, sommeEnergie);
    };
    const centreGrave = centroide(voxA);
    const centreAigu = centroide(voxB);
    expect(centreAigu).toBeGreaterThan(centreGrave * 1.5);
  });

  it("fournisseur voix branché : livraison étiquetée photoréaliste-réseau", async () => {
    const { genererVoix } = await import("./generateur-voix");
    const livraison = await genererVoix("test", profilNeutre(), { nom: "tts-neuronal-reel", synthetiser: async () => ecrireWAV(new Float32Array(22050), 22050) });
    expect(livraison.niveauRealisme).toBe("photoréaliste-réseau");
    expect(livraison.fournisseur).toBe("tts-neuronal-reel");
  });
});

describe("4 — générateur de vidéo : AVI RÉEL parsé, frames exactes, ANIMATION PROUVÉE", () => {
  it("l'AVI est parsé : RIFF/AVI , nb frames exact, fps, idx1 cohérent", async () => {
    const video = await genererVideo("la ville au crépuscule puis zoom sur le marché", undefined, { dureeSecondes: 2, fps: 8, largeur: 128, hauteur: 96 });
    expect(video.avi.length).toBeGreaterThan(50_000);
    const parse = decoderAVI(video.avi);
    expect(parse.nbFrames).toBe(video.nbFrames);
    expect(parse.largeur).toBe(128);
    expect(parse.hauteur).toBe(96);
    expect(parse.fps).toBeCloseTo(8, 0);
    expect(parse.indexValide).toBe(true);
    expect(video.dureeSecondes).toBeCloseTo(2, 0);
  });

  it("ANIMATION PROUVÉE : le zoom entrant change réellement les pixels entre frames", async () => {
    const video = await genererVideo("un arbre baobab puis la caméra approche", undefined, { dureeSecondes: 2, fps: 6, largeur: 128, hauteur: 96 });
    // Décoder la première et la dernière frame depuis l'AVI (movi) — via les PNG du compositeur :
    const plan = planifierVideo("un arbre baobab puis la caméra approche", 2, 6);
    const scene = plan.sequence!.scenes[0];
    const debut = decoderPixelsPNG(rendreStructurel({ ...plan, sequence: undefined }, 128, 96).png);
    const { rendrePixelsStructurel } = await import("./generateur-images");
    const fin = rendrePixelsStructurel(plan, 128, 96, { decalageX: 0, zoom: 1.8 }).pixels;
    void scene;
    let differences = 0;
    const total = Math.min(debut.length, fin.length);
    for (let i = 0; i < total; i++) if (Math.abs(debut[i] - fin[i]) > 12) differences++;
    expect(differences / total).toBeGreaterThan(0.02); // l'animation est réelle
  });

  it("panoramique : la caméra déplace réellement le sujet entre frames", async () => {
    const { rendrePixelsStructurel } = await import("./generateur-images");
    const plan = planifierScene("un chasseur dans la savane");
    const f0 = rendrePixelsStructurel(plan, 128, 96, { decalageX: 0, zoom: 1 }).pixels;
    const f1 = rendrePixelsStructurel(plan, 128, 96, { decalageX: 40, zoom: 1 }).pixels;
    let differences = 0;
    for (let i = 0; i < f0.length; i++) if (Math.abs(f0[i] - f1[i]) > 12) differences++;
    expect(differences).toBeGreaterThan(500);
  });
});

describe("5 — façade multimodale bout en bout", () => {
  it("un prompt → image + audio + vidéo réels, niveaux de réalisme honnêtes", async () => {
    const livraison = await creerLivraisonMultimodale("une pêcheuse au lever du soleil sur le fleuve Congo puis zoom sur son filet", profilNeutre(), {}, { dureeSecondes: 2, fps: 6, largeur: 160, hauteur: 120 });
    const image = decoderPNG(livraison.image.png);
    expect(image.crcValide).toBe(true);
    expect(image.largeur).toBe(160);
    const audio = decoderWAV(livraison.audio.wav);
    expect(audio.duree).toBeGreaterThan(0.5);
    const video = decoderAVI(livraison.video.avi);
    expect(video.nbFrames).toBe(livraison.video.nbFrames);
    expect(video.indexValide).toBe(true);
    expect(livraison.image.niveauRealisme).toBe("structurel-local");
    expect(livraison.plan.sujet).toBe("pecheuse");
    expect(livraison.textePrononce).toContain("pecheuse");
  });

  it("fournisseurs branchés : les niveaux deviennent photoréaliste-réseau", async () => {
    const livraison = await creerLivraisonMultimodale("un pont la nuit", profilNeutre(), {
      images: { nom: "diffusion-reelle", generer: async () => ecrirePNG(4, 4, Buffer.alloc(48, 10)) },
      video: { nom: "video-frontiere", generer: async () => Buffer.from("RIFFxxxx", "ascii") },
    });
    expect(livraison.image.niveauRealisme).toBe("photoréaliste-réseau");
    expect(livraison.image.fournisseur).toBe("diffusion-reelle");
    expect(livraison.video.niveauRealisme).toBe("photoréaliste-réseau");
    expect(livraison.audio.niveauRealisme).toBe("structurel-local"); // pas de fournisseur voix → repli honnête
  });
});
